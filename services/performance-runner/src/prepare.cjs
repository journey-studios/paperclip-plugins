const fs = require("node:fs");
const path = require("node:path");
function save(file, value) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
module.exports = async function prepare(browser) {
  const { target, cache, proofFile } = JSON.parse(fs.readFileSync(process.env.PERFORMANCE_REQUEST_FILE, "utf8"));
  const expected = new URL(target.url);
  const proof = { cache, cacheVerified: false, preflightReady: false, preflightHistory: false, auditReadyVerified: false, auditHistoryVerified: false };
  let phase = "preflight";
  const observed = new WeakSet();
  async function watch(page) {
    if (!page || observed.has(page)) return;
    observed.add(page);
    page.on("framenavigated", async (frame) => {
      if (phase !== "audit" || frame !== page.mainFrame()) return;
      let current;
      try { current = new URL(frame.url()); } catch { return; }
      if (current.origin !== expected.origin || current.pathname !== expected.pathname) return;
      try {
        if (target.selectors?.ready) await page.waitForSelector(target.selectors.ready, { timeout: 45000 });
        proof.auditReadyVerified = true;
        if (target.selectors?.history) await page.waitForSelector(target.selectors.history, { timeout: 45000 });
        proof.auditHistoryVerified = true;
        save(proofFile, proof);
      } catch { /* Missing DOM evidence invalidates the run in the parent. */ }
    });
  }
  browser.on("targetcreated", async (target) => { try { await watch(await target.page()); } catch {} });
  for (const page of await browser.pages()) await watch(page);
  if (target.authProfile !== "public") {
    const state = JSON.parse(fs.readFileSync("/auth/storage-state.json", "utf8"));
    const cookies = (state.cookies || []).filter((cookie) => expected.hostname === cookie.domain.replace(/^\./, "") || expected.hostname.endsWith(cookie.domain.startsWith(".") ? cookie.domain : "." + cookie.domain));
    if (!cookies.length) throw new Error("AUTH_PROFILE_EMPTY");
    await browser.setCookie(...cookies);
  }
  const page = await browser.newPage();
  await watch(page);
  if (target.authProfile !== "public") {
    const state = JSON.parse(fs.readFileSync("/auth/storage-state.json", "utf8"));
    const origin = (state.origins || []).find((item) => item.origin === expected.origin);
    if (origin?.localStorage?.length) {
      await page.evaluateOnNewDocument((origin, items) => {
        if (location.origin === origin) for (const item of items) localStorage.setItem(item.name, item.value);
      }, expected.origin, origin.localStorage);
    }
  }
  if (cache === "warm") {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (target.selectors?.ready) await page.waitForSelector(target.selectors.ready, { timeout: 45000 });
    if (target.selectors?.history) await page.waitForSelector(target.selectors.history, { timeout: 45000 });
    await page.goto("about:blank");
  }
  const start = performance.now();
  let clickAt = start;
  if (target.scenario === "home-to-chat") {
    await page.goto(target.startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(target.selectors.click, { timeout: 45000 });
    clickAt = performance.now();
    await page.click(target.selectors.click);
    if (target.selectors.conversation) {
      await page.waitForSelector(target.selectors.conversation, { timeout: 45000 });
      await page.click(target.selectors.conversation);
    }
    await page.waitForFunction((url) => location.origin + location.pathname === url, {}, expected.origin + expected.pathname);
  } else {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  if (target.selectors?.ready) await page.waitForSelector(target.selectors.ready, { timeout: 45000 });
  proof.preflightReady = true;
  if (target.selectors?.history) await page.waitForSelector(target.selectors.history, { timeout: 45000 });
  proof.preflightHistory = true;
  if (new URL(page.url()).origin + new URL(page.url()).pathname !== expected.origin + expected.pathname) throw new Error("AUTH_OR_ROUTE_INVALID");
  proof.uiReadyMs = performance.now() - clickAt;
  // The real audit is a navigation. UI journey timings are a separate preflight measurement.
  const session = await page.createCDPSession();
  if (cache === "cold") await session.send("Network.clearBrowserCache");
  await session.detach();
  proof.cacheVerified = true;
  await page.goto("about:blank");
  phase = "audit";
  save(proofFile, proof);
  // Keep the observer page owned by this browser until LHCI closes the browser.
};
