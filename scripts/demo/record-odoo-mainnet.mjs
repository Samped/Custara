/**
 * Record captioned Odoo→mainnet walkthrough using .auth/custara-xyz.json
 * Output: demos/custara-odoo-mainnet-demo.mp4
 *
 * Usage: node scripts/demo/record-odoo-mainnet.mjs
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const auth = join(root, ".auth/custara-xyz.json");
const demos = join(root, "demos");
const videoDir = join(demos, ".pw-video");
const outMp4 = join(demos, "custara-odoo-mainnet-demo.mp4");
const framesDir = join(demos, ".frames");

if (!existsSync(auth)) {
  console.error("Missing .auth/custara-xyz.json — run: node scripts/demo/capture-auth.mjs");
  process.exit(1);
}

mkdirSync(demos, { recursive: true });
rmSync(videoDir, { recursive: true, force: true });
mkdirSync(videoDir, { recursive: true });
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

async function caption(page, text, holdMs = 2400) {
  await page.evaluate((t) => {
    let bar = document.getElementById("demo-caption");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "demo-caption";
      bar.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(15,23,42,.94);color:#f8fafc;" +
        "font:600 16px/1.45 ui-sans-serif,system-ui,sans-serif;padding:14px 22px;letter-spacing:.01em;" +
        "border-top:1px solid rgba(148,163,184,.35);pointer-events:none;";
      document.body.appendChild(bar);
    }
    bar.textContent = t;
  }, text);
  await page.waitForTimeout(holdMs);
}

async function go(page, path) {
  await page.goto(`https://custara.xyz${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(900);
}

/** Finish company + MFA prompts so /app/* pages are reachable. */
async function ensureWorkspaceReady(page) {
  await go(page, "/app");
  if (page.url().includes("/login")) {
    throw new Error("Session expired — re-run capture-auth.mjs and complete OTP again");
  }

  if (page.url().includes("/app/onboarding") && !page.url().includes("/mfa")) {
    await caption(page, "First-time setup · Company profile for the workspace", 2200);
    const name = page.locator("#name");
    if (await name.count()) {
      await name.fill("Custara Demo");
      await page.locator("#legalName").fill("Custara Demo Ltd");
      await page.locator("#businessType").selectOption("startup");
      await page.locator("#country").selectOption("US");
      await page.locator("#industry").fill("B2B AP automation");
      await page.locator("#website").fill("https://custara.xyz");
      await page.getByRole("button", { name: /continue/i }).click();
      await page.waitForTimeout(2000);
    }
  }

  if (page.url().includes("/app/onboarding/mfa")) {
    await caption(page, "MFA optional for this demo · Skip to the workspace", 2000);
    const skip = page.getByRole("button", { name: "Skip" });
    if (await skip.count()) {
      await skip.click();
      await page.waitForURL((u) => !u.pathname.includes("/onboarding/mfa"), { timeout: 20_000 });
      await page.waitForTimeout(800);
    }
  }

  await go(page, "/app");
  if (page.url().includes("/onboarding") || page.url().includes("/login")) {
    throw new Error(`Could not reach workspace — still on ${page.url()}`);
  }
}

const browser = await chromium.launch({ headless: true, slowMo: 80 });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  storageState: auth,
  recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

try {
  await ensureWorkspaceReady(page);

  await caption(page, "Custara AP for Odoo · Arc mainnet USDC · Odoo stays the ledger", 3200);

  await go(page, "/app/connectors");
  await caption(page, "Connect Odoo · API https://custara.xyz · Partner key from Developers", 3000);
  await page.waitForTimeout(1200);

  await go(page, "/app/inbox");
  await caption(page, "Sync or Send to Custara · Vendor bills land in Inbox", 2800);
  const firstInvoice = page.locator('a[href*="/app/invoices/"]').first();
  if (await firstInvoice.count()) {
    await firstInvoice.click();
    await page.waitForTimeout(1200);
    await caption(page, "Review risk and policy · Approve in Custara before pay", 3000);
  } else {
    await caption(page, "Inbox ready · Sync Odoo or Send to Custara from a vendor bill", 3000);
  }

  await go(page, "/app/approvals");
  await caption(page, "Approvals · Dual control when policy requires it", 2600);

  await go(page, "/app/payments");
  await caption(page, "Pay on Arc mainnet · Settle approved bills in USDC", 3000);
  await page.waitForTimeout(1000);

  await go(page, "/app/wallets");
  await caption(page, "Fund the workspace agent · Then sync balance before paying", 3000);

  await go(page, "/app/receipts");
  await caption(page, "Write-back · Custara payment reconciles the same Odoo bill", 3000);

  await go(page, "/app");
  await caption(page, "Free Odoo module · apps.odoo.com · Live at custara.xyz", 3500);
  await page.waitForTimeout(800);
} finally {
  await context.close();
  await browser.close();
}

const webms = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
if (!webms.length) {
  console.error("No webm recorded");
  process.exit(1);
}
const webmPath = join(videoDir, webms[0]);
const stagedWebm = join(demos, "custara-odoo-mainnet-demo.webm");
renameSync(webmPath, stagedWebm);

const ff = spawnSync(
  "ffmpeg",
  ["-y", "-i", stagedWebm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outMp4],
  { stdio: "inherit" },
);
if (ff.status !== 0) {
  console.error("ffmpeg failed");
  process.exit(1);
}

spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    outMp4,
    "-vf",
    "select='eq(n\\,30)+eq(n\\,120)+eq(n\\,240)+eq(n\\,360)+eq(n\\,480)'",
    "-vsync",
    "vfr",
    join(framesDir, "frame_%d.png"),
  ],
  { stdio: "inherit" },
);

console.log(`MP4 → ${outMp4}`);
console.log(`Frames → ${framesDir}`);
rmSync(videoDir, { recursive: true, force: true });
