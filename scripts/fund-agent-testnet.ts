/**
 * Automatically fund the org Circle agent wallet with Arc testnet USDC.
 *
 * Uses Circle POST /v1/faucet/drips (needs CIRCLE_API_KEY with faucet access).
 * On rate limits, keeps retrying until --wait expires while also polling balance
 * so a parallel public-faucet drip still completes the script.
 *
 * Usage:
 *   npm run fund:agent
 *   npm run fund:agent -- --org cmuset65r00gncd46pwdej2x2
 *   npm run fund:agent -- --address 0xabc...
 *   npm run fund:agent -- --wait 3600 --poll 120
 *   npm run fund:agent -- --sync-only --poll 90
 *
 * Env: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, DATABASE_URL, ARC_CHAIN=ARC-TESTNET
 */
import { readFileSync } from "fs";
import path from "path";

function loadEnv() {
  try {
    const text = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // ignore
  }
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtEta(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

async function main() {
  loadEnv();
  const { PrismaClient } = await import("@prisma/client");
  const {
    requestTestnetUsdcFaucet,
    getWalletUsdcBalance,
    CIRCLE_PUBLIC_FAUCET_URL,
  } = await import("../src/domain/arc/circle");
  const { getArcChain } = await import("../src/domain/arc/config");
  const { syncWalletBalances } = await import("../src/domain/arc/wallets");

  const prisma = new PrismaClient();
  const addressArg = arg("address");
  const orgArg = arg("org");
  const pollSec = Number(arg("poll") || "120");
  const waitSec = Number(arg("wait") || "3600");
  const syncOnly = hasFlag("sync-only");
  const once = hasFlag("once");

  let organizationId = orgArg || "";
  let address = addressArg?.toLowerCase() || "";
  let walletId: string | null = null;
  let provider = "circle";

  if (!address || !organizationId) {
    const agent = await prisma.orgWallet.findFirst({
      where: {
        role: "agent",
        status: "active",
        provider: "circle",
        ...(organizationId ? { organizationId } : {}),
        ...(address ? { address } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!agent) {
      throw new Error(
        "No active Circle agent wallet found. Upgrade on /app/wallets first, or pass --org / --address.",
      );
    }
    organizationId = agent.organizationId;
    address = agent.address;
    walletId = agent.circleWalletId;
    provider = agent.provider;
  } else {
    const agent = await prisma.orgWallet.findFirst({
      where: { organizationId, address, role: "agent" },
    });
    walletId = agent?.circleWalletId ?? null;
    provider = agent?.provider || "circle";
  }

  const chain = getArcChain();
  console.log(`Agent ${address}`);
  console.log(`Chain ${chain} · org ${organizationId}`);
  console.log(`Public faucet (captcha): ${CIRCLE_PUBLIC_FAUCET_URL}  → ARC + USDC`);

  let before = await getWalletUsdcBalance({ walletId, address, provider });
  console.log(`Balance before: ${before} USDC`);

  if (before > 0 && !hasFlag("force")) {
    console.log("Already funded. Use --force to request another drip anyway.");
    try {
      await syncWalletBalances(organizationId);
    } catch {
      // ignore
    }
    await prisma.$disconnect();
    return;
  }

  const deadline = Date.now() + Math.max(30, waitSec) * 1000;
  let faucetAccepted = false;
  let nextFaucetAt = syncOnly ? Number.POSITIVE_INFINITY : 0;
  let attempt = 0;

  while (Date.now() < deadline) {
    // Poll / sync first so a manual public-faucet drip ends the loop.
    try {
      await syncWalletBalances(organizationId);
    } catch {
      // ignore sync errors while waiting
    }
    const nowBal = await getWalletUsdcBalance({ walletId, address, provider });
    if (nowBal > before) {
      console.log(`\nFunded. Agent has ${nowBal} USDC (was ${before}).`);
      await prisma.$disconnect();
      return;
    }
    if (attempt === 0 || attempt % 3 === 0) {
      console.log(`Balance ${nowBal} USDC · ${fmtEta(deadline - Date.now())} left`);
    }

    if (!syncOnly && Date.now() >= nextFaucetAt) {
      attempt += 1;
      process.stdout.write(`Faucet attempt ${attempt}… `);
      const faucet = await requestTestnetUsdcFaucet({
        address,
        blockchain: chain,
        retries: 0,
      });

      if (faucet.ok) {
        faucetAccepted = true;
        console.log(faucet.message);
        // Credit can lag; keep polling until balance moves or wait ends.
        nextFaucetAt = Date.now() + 180_000;
      } else if (faucet.method === "rate_limited") {
        const waitMs = faucet.retryAfterMs || 120_000;
        console.log(`rate-limited — next API try in ${fmtEta(waitMs)}`);
        nextFaucetAt = Date.now() + waitMs;
        if (attempt === 1) {
          console.log(
            `Tip: while waiting you can drip at ${faucet.faucetUrl} (ARC + USDC → ${address}). This script will detect the balance.`,
          );
        }
      } else {
        console.log(faucet.message);
        nextFaucetAt = Date.now() + 180_000;
        if (once) {
          process.exitCode = 2;
          await prisma.$disconnect();
          return;
        }
      }

      if (once && !faucetAccepted) {
        process.exitCode = 2;
        await prisma.$disconnect();
        return;
      }
      if (once && faucetAccepted) {
        // fall through to short poll below via deadline shrink
        const short = Date.now() + Math.max(15, pollSec) * 1000;
        while (Date.now() < short) {
          await sleep(5_000);
          try {
            await syncWalletBalances(organizationId);
          } catch {
            // ignore
          }
          const bal = await getWalletUsdcBalance({ walletId, address, provider });
          console.log(`Balance now: ${bal} USDC`);
          if (bal > before) {
            console.log(`\nFunded. Agent has ${bal} USDC (was ${before}).`);
            await prisma.$disconnect();
            return;
          }
        }
        console.warn("Faucet accepted but balance unchanged yet — re-run with --sync-only --poll 120.");
        process.exitCode = 3;
        await prisma.$disconnect();
        return;
      }
    }

    await sleep(Math.min(15_000, Math.max(5_000, (pollSec * 1000) / 4)));
  }

  const after = await getWalletUsdcBalance({ walletId, address, provider });
  if (after > before) {
    console.log(`\nFunded. Agent has ${after} USDC (was ${before}).`);
  } else if (faucetAccepted) {
    console.warn(
      "Faucet API accepted earlier but balance still 0. Credits can lag — run: npm run fund:agent -- --sync-only --poll 180",
    );
    process.exitCode = 3;
  } else {
    console.error(
      `\nStill unfunded after ${waitSec}s. Circle API stayed rate-limited.\n` +
        `Manual: ${CIRCLE_PUBLIC_FAUCET_URL} → ARC + USDC → ${address}\n` +
        `Then: npm run fund:agent -- --sync-only --poll 120`,
    );
    process.exitCode = 2;
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
