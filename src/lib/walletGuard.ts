/**
 * Phantom / MetaMask / Rabby all try to define window.ethereum.
 * The second injector throws "Cannot redefine property: ethereum".
 * Next.js then paints that as an app Runtime TypeError in dev.
 */
export function installWalletExtensionGuard() {
  const w = window as Window & { __custaraWalletGuard?: boolean };
  if (w.__custaraWalletGuard) return;
  w.__custaraWalletGuard = true;

  const defineProperty = Object.defineProperty;
  Object.defineProperty = function (target, property, attributes) {
    if (target === window && (property === "ethereum" || property === "solana")) {
      try {
        return defineProperty.call(Object, target, property, attributes);
      } catch {
        return target;
      }
    }
    return defineProperty.call(Object, target, property, attributes);
  } as typeof Object.defineProperty;

  const ignore = (event: Event) => {
    const err = "error" in event ? (event as ErrorEvent).error : undefined;
    const reason = "reason" in event ? (event as PromiseRejectionEvent).reason : undefined;
    const message = String(
      (event as ErrorEvent).message || err?.message || reason?.message || reason || "",
    );
    const stack = String(err?.stack || reason?.stack || "");
    if (
      message.includes("Cannot redefine property: ethereum") ||
      message.includes("Cannot redefine property: solana") ||
      stack.includes("evmAsk.js")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  window.addEventListener("error", ignore, true);
  window.addEventListener("unhandledrejection", ignore, true);
}
