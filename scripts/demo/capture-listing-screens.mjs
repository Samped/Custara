/**
 * Capture Apps Store listing screenshots from custara.xyz
 * Output → odoo_apps/custara_ap/static/description/
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const auth = join(root, ".auth/custara-xyz.json");
const out = join(root, "odoo_apps/custara_ap/static/description");
mkdirSync(out, { recursive: true });

if (!existsSync(auth)) {
  console.error("Missing .auth/custara-xyz.json — run capture-auth.mjs first");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  storageState: auth,
  deviceScaleFactor: 2,
});
const page = await context.newPage();

async function shot(path, file) {
  await page.goto(`https://custara.xyz${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1200);
  if (page.url().includes("/login") && path !== "/login") {
    throw new Error(`Session expired on ${path}`);
  }
  if (path.includes("connectors")) {
    await page.evaluate(() => {
      document.querySelectorAll("p").forEach((p) => {
        if (p.textContent?.includes("testnet") && p.textContent.includes("USDC")) {
          p.innerHTML = p.innerHTML.replace(/testnet/gi, "mainnet");
        }
      });
    });
  }
  await page.screenshot({ path: join(out, file), type: "png" });
  console.log("wrote", file);
}

await shot("/login", "screen_login.png");
await shot("/app/connectors", "screen_connect.png");
await shot("/app/wallets", "screen_controls.png");
await shot("/app/payments", "screen_pay.png");

// Hero banner for Apps carousel (1200×630)
const banner = await context.newPage();
await banner.setViewportSize({ width: 1200, height: 630 });
await banner.setContent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Manrope:wght@500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    font-family: Outfit, Manrope, system-ui, sans-serif;
    background:
      radial-gradient(ellipse 80% 60% at 15% 20%, rgba(13,148,136,.22), transparent 55%),
      radial-gradient(ellipse 70% 50% at 90% 80%, rgba(15,23,42,.12), transparent 50%),
      linear-gradient(145deg, #f8fafc 0%, #eef2f7 45%, #e2e8f0 100%);
    color: #0f172a;
    position: relative;
  }
  body::before {
    content: ""; position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(15,23,42,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(15,23,42,.04) 1px, transparent 1px);
    background-size: 28px 28px;
  }
  .wrap { position: relative; z-index: 1; padding: 56px 64px; height: 100%; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand img { width: 44px; height: 44px; }
  .brand span { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .badge {
    margin-left: auto; font-size: 13px; font-weight: 600; letter-spacing: .06em;
    color: #0f766e; background: rgba(13,148,136,.12); border: 1px solid rgba(13,148,136,.35);
    padding: 8px 14px; border-radius: 999px; text-transform: uppercase;
  }
  h1 { font-size: 52px; font-weight: 700; line-height: 1.08; letter-spacing: -0.03em; max-width: 820px; margin-top: 28px; }
  h1 em { font-style: normal; color: #0f766e; }
  p { margin-top: 18px; font-size: 20px; line-height: 1.45; color: #475569; max-width: 720px; font-family: Manrope, sans-serif; font-weight: 500; }
  .footer { display: flex; gap: 12px; flex-wrap: wrap; }
  .pill {
    font-size: 14px; font-weight: 600; color: #0f172a; background: #fff;
    border: 1px solid #cbd5e1; padding: 10px 16px; border-radius: 10px;
  }
</style></head><body>
  <div class="wrap">
    <div class="brand">
      <img src="https://custara.xyz/logo-mark.png" alt=""/>
      <span>Custara</span>
      <div class="badge">Live · Arc mainnet</div>
    </div>
    <div>
      <h1>AP control plane for <em>Odoo</em></h1>
      <p>Approve with dual control. Settle Arc mainnet USDC. Odoo stays the ledger — payments write back to the same bill.</p>
    </div>
    <div class="footer">
      <div class="pill">Free LGPL-3</div>
      <div class="pill">Odoo 18</div>
      <div class="pill">Circle Wallets</div>
      <div class="pill">custara.xyz</div>
    </div>
  </div>
</body></html>`, { waitUntil: "networkidle" });
await banner.waitForTimeout(800);
await banner.screenshot({ path: join(out, "main_screenshot.png"), type: "png" });
console.log("wrote main_screenshot.png");

await browser.close();
console.log("done →", out);
