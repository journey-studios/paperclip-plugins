import fs from "node:fs/promises";
import puppeteer from "puppeteer";
import session from "./session.cjs";
process.umask(0o077);
const origin = process.env.PERFORMANCE_AUTH_ORIGIN;
const email = process.env.PERFORMANCE_BOT_EMAIL;
const password = process.env.PERFORMANCE_BOT_PASSWORD;
const userId = process.env.PERFORMANCE_BOT_USER_ID;
let browser;
try {
  if (!origin || new URL(origin).protocol !== "https:" || !email || !password || !userId) throw new Error("AUTH_CONFIGURATION_REQUIRED");
  process.env.HOME = "/tmp/performance-seed";
  await fs.mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.goto(new URL("/login", origin).href, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  const tokenResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/auth/v1/token", { timeout: 30000 });
  await page.click('button[type="submit"]');
  const response = await tokenResponse;
  const data = await response.json();
  if (!response.ok() || data.user?.id !== userId || data.user?.email !== email) throw new Error("AUTH_IDENTITY_MISMATCH");
  await page.waitForFunction(() => !/\/(login|signin)(\/|$)/.test(location.pathname), { timeout: 30000 });
  await session.saveSession(browser, page, new URL(origin).origin);
  process.stdout.write(JSON.stringify({ ok: true, identityVerified: true, separateSession: true }) + "\n");
} catch (error) {
  let code = "AUTH_SEED_FAILED";
  if (error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)) code = error.message;
  process.stdout.write(JSON.stringify({ ok: false, code }) + "\n");
  process.exitCode = 1;
} finally { await browser?.close(); }
