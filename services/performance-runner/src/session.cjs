const fs = require("node:fs/promises");
function cookiesForHost(cookies, hostname) {
  return cookies.filter((cookie) => hostname === cookie.domain.replace(/^\./, "") || (cookie.domain.startsWith(".") && hostname.endsWith(cookie.domain)));
}
async function saveSession(browser, page, origin, file = "/auth/storage-state.json") {
  const cookies = cookiesForHost(await browser.cookies(), new URL(origin).hostname).map((cookie) => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
  }));
  let origins = [];
  try { origins = JSON.parse(await fs.readFile(file, "utf8")).origins || []; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (page && !page.isClosed() && new URL(page.url()).origin === origin) {
    const localStorage = await page.evaluate(() => Object.entries(window.localStorage)
      .filter(([name]) => name.startsWith("sb-") || name.startsWith("supabase."))
      .map(([name, value]) => ({ name, value })));
    origins = [{ origin, localStorage }];
  }
  await fs.writeFile(file + ".tmp", JSON.stringify({ cookies, origins }), { mode: 0o600 });
  await fs.rename(file + ".tmp", file);
}
module.exports = { cookiesForHost, saveSession };
