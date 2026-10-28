/**
 * Headed login to custara.xyz — complete Circle OTP in the window.
 * Saves Playwright storageState to .auth/custara-xyz.json (gitignored).
 *
 * Usage: node scripts/demo/capture-auth.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, ".auth/custara-xyz.json");
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 50 });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

console.log("Open the browser window. Sign in at https://custara.xyz/login");
console.log("When you land on /app, this script will save the session and exit.");
await page.goto("https://custara.xyz/login", { waitUntil: "domcontentloaded" });

await page.waitForURL((url) => url.pathname.startsWith("/app"), { timeout: 10 * 60 * 1000 });
await page.waitForTimeout(1500);
await context.storageState({ path: out });
console.log(`Saved session → ${out}`);
await browser.close();
