import { parseArcAddress } from "@/domain/erp/adapters";

export const DEFAULT_PLATFORM_FEE_BPS = 75;
export const DEFAULT_PLATFORM_FEE_MIN_USDC = 0.1;

export function platformFeeBps() {
  const n = Number(process.env.PLATFORM_FEE_BPS ?? DEFAULT_PLATFORM_FEE_BPS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLATFORM_FEE_BPS;
}

export function platformFeeMinUsdc() {
  const n = Number(process.env.PLATFORM_FEE_MIN_USDC ?? DEFAULT_PLATFORM_FEE_MIN_USDC);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLATFORM_FEE_MIN_USDC;
}

export function platformFeeAddress() {
  const raw = process.env.PLATFORM_FEE_ADDRESS?.trim() || "";
  return parseArcAddress(raw);
}

/** Buyer-paid USDC on top of the vendor settlement. Zero when no treasury address is set. */
export function platformFeeUsdc(settlementUsdc: number) {
  if (!platformFeeAddress()) return 0;
  const amount = Number(settlementUsdc);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const raw = (amount * platformFeeBps()) / 10_000;
  const rounded = Math.round(Math.max(platformFeeMinUsdc(), raw) * 100) / 100;
  return rounded;
}

export function describePlatformFee(settlementUsdc: number) {
  const fee = platformFeeUsdc(settlementUsdc);
  return {
    feeAmount: fee,
    feeBps: platformFeeBps(),
    feeAddress: platformFeeAddress(),
    totalDebit: Math.round((settlementUsdc + fee) * 1_000_000) / 1_000_000,
  };
}

export function formatBuyerPayLine(settlementUsdc: number) {
  const { feeAmount, feeBps } = describePlatformFee(settlementUsdc);
  const vendor = formatUsdc(settlementUsdc);
  if (!(feeAmount > 0)) return `Pay ${vendor} USDC to vendor`;
  return `Pay ${vendor} USDC to vendor + ${formatUsdc(feeAmount)} USDC Custara fee (${formatBps(feeBps)})`;
}

export function formatBps(bps: number) {
  const pct = bps / 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

function formatUsdc(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
