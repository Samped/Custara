#!/usr/bin/env node
import { login, logout, mfa, orgSet, teamInvite, whoami } from "./commands/account.js";
import { invoices } from "./commands/invoices.js";
import { approvals, audit, cash, pay, vendors, wallets, webhooks } from "./commands/money.js";
import { parseFlags, wantsJson } from "./flags.js";
import { fail } from "./output.js";

const HELP = `custara — talk to a Custara workspace

  custara login --api-key <key> [--url https://custara.xyz]
  custara login --email <you@company.com> [--code 123456]
  custara logout
  custara whoami

  custara invoices ingest --vendor "Acme" --number INV-1 --amount 25 --currency USDC --due 2026-10-20 --arc-address 0x...
  custara invoices ingest --file invoice.json
  custara invoices list
  custara invoices get <id>
  custara invoices analysis <id>
  custara invoices bulk --file bills.csv

  custara approvals decide <id> --decision approved|rejected
  custara pay <invoiceId> [--rail arc_usdc] [--step-up <secret>]

  custara vendors create --name "Acme" --arc-address 0x...
  custara wallets list|sync
  custara cash
  custara audit export|verify
  custara webhooks list
  custara webhooks create --url https://example.com/hook --events payment.intent_created,invoice.reconciled
  custara webhooks disable <id>

  custara mfa enroll
  custara mfa confirm <code>
  custara mfa disable <code>
  custara org set --payment-mode live|sandbox --autopay true|false --mfa-threshold 5000
  custara team invite --email person@company.com --role approver

Env: CUSTARA_URL, CUSTARA_API_KEY, CUSTARA_TOKEN, CUSTARA_STEP_UP
Add --json for raw API output.
`;

async function main() {
  const { positionals, flags } = parseFlags(process.argv.slice(2));
  const asJson = wantsJson(flags);
  const [command, sub, ...rest] = positionals;
  if (!command || command === "help" || flags.help === true) {
    console.log(HELP);
    return;
  }
  if (command === "login") return login(flags, asJson);
  if (command === "logout") return logout(asJson);
  if (command === "whoami") return whoami(asJson);
  if (command === "invoices") return invoices(sub, rest, flags, asJson);
  if (command === "approvals") return approvals([sub, ...rest].filter(Boolean) as string[], flags, asJson);
  if (command === "pay") return pay(sub, flags, asJson);
  if (command === "vendors") {
    if (sub !== "create") throw new Error("Use custara vendors create --name");
    return vendors(flags, asJson);
  }
  if (command === "wallets") return wallets(sub, asJson);
  if (command === "cash") return cash(asJson);
  if (command === "audit") return audit(sub, asJson);
  if (command === "webhooks") return webhooks(sub, rest, flags, asJson);
  if (command === "mfa") return mfa(sub || "", rest[0], flags, asJson);
  if (command === "org") {
    if (sub !== "set") throw new Error("Use custara org set");
    return orgSet(flags, asJson);
  }
  if (command === "team") {
    if (sub !== "invite") throw new Error("Use custara team invite --email");
    return teamInvite(flags, asJson);
  }
  throw new Error(`Unknown command ${command}\n\n${HELP}`);
}

main().catch(fail);
