/**
 * Recapture login (no session) and render Odoo Settings / Send-to-Custara frames.
 * Output → odoo_apps/custara_ap/static/description/
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "odoo_apps/custara_ap/static/description");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });

const loginCtx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
let loginCaptured = false;
try {
  const login = await loginCtx.newPage();
  await login.goto("https://custara.xyz/login", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await login.waitForTimeout(1800);
  if (!login.url().includes("/app")) {
    await login.screenshot({ path: join(out, "screen_login.png"), type: "png" });
    console.log("wrote screen_login.png from live");
    loginCaptured = true;
  }
} catch (e) {
  console.warn("live login unavailable:", e.message);
}
if (!loginCaptured) {
  const login = await loginCtx.newPage();
  await login.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=Manrope:wght@500;600;700&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 1280px; height: 800px; font-family: Manrope, system-ui, sans-serif;
  color: #0a0f12; background: #f7f8f9;
  background-image:
    linear-gradient(rgba(10,15,18,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(10,15,18,.04) 1px, transparent 1px);
  background-size: 32px 32px;
  display: flex; align-items: center; justify-content: center;
}
.panel {
  width: 420px; padding: 32px; background: rgba(255,255,255,.94);
  border: 1px solid rgba(10,15,18,.07); border-radius: 14px;
  box-shadow: 0 0 0 1px rgba(10,15,18,.03), 0 10px 28px -18px rgba(10,15,18,.22);
}
.brand { display: flex; align-items: center; gap: 10px; font-family: Outfit, sans-serif; font-weight: 700; font-size: 15px; }
.brand img { width: 30px; height: 30px; }
h1 { margin-top: 24px; font-family: Outfit, sans-serif; font-size: 28px; letter-spacing: -0.03em; }
.sub { margin-top: 8px; color: #66747c; font-size: 14px; }
label { display: block; margin-top: 28px; font-size: 13px; font-weight: 600; }
input { width: 100%; height: 38px; margin-top: 8px; border: 1px solid rgba(10,15,18,.1); border-radius: 8px; padding: 0 12px; font: 14px Manrope, sans-serif; }
button { width: 100%; margin-top: 16px; height: 38px; border: 0; border-radius: 8px; background: #0a0f12; color: #fff; font: 600 14px Manrope, sans-serif; }
.hint { margin-top: 16px; font-size: 12px; color: #66747c; line-height: 1.45; }
</style></head><body>
  <div class="panel">
    <div class="brand"><img src="file://${join(root, "public/logo-mark.png")}" alt=""/><span>Custara</span></div>
    <h1>Sign in</h1>
    <p class="sub">Work email · one-time code</p>
    <label>Work email<input type="email" value="controller@acme.com" readonly /></label>
    <button>Continue</button>
    <p class="hint">Circle email OTP. No password. Used by AP reviewers on custara.xyz.</p>
  </div>
</body></html>`, { waitUntil: "domcontentloaded" });
  await login.waitForTimeout(400);
  await login.screenshot({ path: join(out, "screen_login.png"), type: "png" });
  console.log("wrote screen_login.png from product-matched frame");
}
await loginCtx.close();

const odoo = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});

async function render(file, html) {
  const page = await odoo.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, file), type: "png" });
  console.log("wrote", file);
  await page.close();
}

const chrome = `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Inter, system-ui, sans-serif; background: #f8f9fa; color: #1f1f1f; width: 1280px; height: 800px; overflow: hidden; }
  .top { height: 46px; background: #714B67; color: #fff; display: flex; align-items: center; padding: 0 16px; gap: 18px; }
  .top .logo { font-weight: 700; letter-spacing: .04em; font-size: 15px; }
  .top nav { display: flex; gap: 16px; font-size: 13px; opacity: .92; }
  .top .right { margin-left: auto; font-size: 13px; }
  .crumb { height: 40px; background: #fff; border-bottom: 1px solid #e6e6e6; display: flex; align-items: center; padding: 0 20px; font-size: 13px; color: #6b6b6b; }
  .crumb strong { color: #1f1f1f; font-weight: 600; }
  .layout { display: flex; height: 714px; }
  .side { width: 220px; background: #fff; border-right: 1px solid #e6e6e6; padding: 16px 0; }
  .side h3 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8c8c8c; padding: 0 18px 8px; }
  .side a { display: block; padding: 8px 18px; font-size: 13px; color: #3d3d3d; text-decoration: none; }
  .side a.on { background: #f3eef2; color: #714B67; font-weight: 600; }
  .main { flex: 1; padding: 22px 28px; overflow: hidden; }
  .block { background: #fff; border: 1px solid #e6e6e6; border-radius: 4px; padding: 22px 24px; }
  .block h2 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
  .muted { color: #6b6b6b; font-size: 12.5px; line-height: 1.45; }
  .field { margin-top: 16px; }
  .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .field input { width: 100%; max-width: 520px; height: 34px; border: 1px solid #cfcfcf; border-radius: 4px; padding: 0 10px; font: 13px Inter, sans-serif; background: #fff; }
  .actions { margin-top: 22px; display: flex; gap: 8px; }
  .btn { height: 32px; padding: 0 14px; border-radius: 4px; border: 1px solid transparent; font: 600 13px Inter, sans-serif; cursor: default; }
  .btn-primary { background: #714B67; color: #fff; }
  .btn-ghost { background: #fff; border-color: #d4d4d4; }
  .sheet { background: #fff; border: 1px solid #e6e6e6; border-radius: 4px; min-height: 620px; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #eee; }
  .btn-sec { height: 30px; padding: 0 12px; border-radius: 4px; border: 1px solid #d4d4d4; background: #fff; font: 600 12.5px Inter, sans-serif; }
  .btn-custara { height: 30px; padding: 0 12px; border-radius: 4px; border: 1px solid #714B67; background: #fff; color: #714B67; font: 700 12.5px Inter, sans-serif; }
  .status { margin-left: 8px; font-size: 11px; font-weight: 700; letter-spacing: .04em; color: #8c5a00; background: #fff4d6; border: 1px solid #f0d48a; padding: 3px 8px; border-radius: 3px; }
  .title { padding: 18px 22px 8px; font-size: 24px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 28px; padding: 8px 22px 22px; }
  .row label { display: block; font-size: 11px; color: #8c8c8c; margin-bottom: 4px; }
  .row .val { font-size: 14px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
  .sent { grid-column: 1 / -1; margin-top: 8px; background: #f8f4f7; border: 1px solid #eadceb; border-radius: 4px; padding: 12px 14px; }
</style>
`;

await render(
  "screen_odoo_settings.png",
  `<!DOCTYPE html><html><head><meta charset="utf-8"/>${chrome}</head><body>
  <div class="top"><div class="logo">odoo</div><nav><span>Accounting</span><span>Purchases</span><span>Settings</span></nav><div class="right">Acme Accounting</div></div>
  <div class="crumb">Settings / Accounting / <strong>Custara AP</strong></div>
  <div class="layout">
    <aside class="side">
      <h3>Settings</h3>
      <a>General Settings</a>
      <a class="on">Accounting</a>
      <a>Users &amp; Companies</a>
      <a>Technical</a>
    </aside>
    <main class="main">
      <div class="block">
        <h2>Custara AP</h2>
        <p class="muted">Custara approves and pays. Odoo stays the ledger. Production API: https://custara.xyz — Arc mainnet USDC.</p>
        <div class="field">
          <label>Custara API URL</label>
          <input value="https://custara.xyz" readonly />
        </div>
        <div class="field">
          <label>Custara API key</label>
          <input type="password" value="••••••••••••••••••••" readonly />
        </div>
        <p class="muted" style="margin-top:12px">Partner key from Custara → Developers. Demo host: https://testnet.custara.xyz</p>
        <div class="actions">
          <button class="btn btn-primary">Save</button>
          <button class="btn btn-ghost">Discard</button>
        </div>
      </div>
    </main>
  </div>
</body></html>`,
);

await render(
  "screen_odoo_send.png",
  `<!DOCTYPE html><html><head><meta charset="utf-8"/>${chrome}</head><body>
  <div class="top"><div class="logo">odoo</div><nav><span>Accounting</span><span>Vendors</span><span>Bills</span></nav><div class="right">Acme Accounting</div></div>
  <div class="crumb">Accounting / Vendors / Bills / <strong>BILL/2026/10/0018</strong></div>
  <div class="layout">
    <aside class="side">
      <h3>Accounting</h3>
      <a>Dashboard</a>
      <a>Customers</a>
      <a class="on">Vendors</a>
      <a>Reporting</a>
    </aside>
    <main class="main">
      <div class="sheet">
        <div class="bar">
          <button class="btn-sec">Confirm</button>
          <button class="btn-custara">Send to Custara</button>
          <button class="btn-sec">Print</button>
          <span class="status">POSTED</span>
        </div>
        <div class="title">Vendor Bill BILL/2026/10/0018</div>
        <div class="grid">
          <div class="row"><label>Vendor</label><div class="val">Northwind Supplies</div></div>
          <div class="row"><label>Bill Date</label><div class="val">26 Oct 2026</div></div>
          <div class="row"><label>Bill Reference</label><div class="val">INV-8841</div></div>
          <div class="row"><label>Due Date</label><div class="val">09 Nov 2026</div></div>
          <div class="row"><label>Journal</label><div class="val">Vendor Bills</div></div>
          <div class="row"><label>Total</label><div class="val">2,480.00 USD</div></div>
          <div class="sent">
            <div class="muted" style="font-weight:600;color:#714B67">Custara AP</div>
            <div style="margin-top:6px;font-size:13px">Sent to Custara — empty until you click Send to Custara. Payment writes back to this bill after Arc mainnet settlement.</div>
          </div>
        </div>
      </div>
    </main>
  </div>
</body></html>`,
);

await browser.close();
console.log("done");
