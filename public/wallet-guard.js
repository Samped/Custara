/** Swallow wallet-extension collisions on window.ethereum / window.solana. */
(function () {
  if (window.__custaraWalletGuard) return;
  window.__custaraWalletGuard = true;

  var defineProperty = Object.defineProperty;
  Object.defineProperty = function (target, property, attributes) {
    if (target === window && (property === "ethereum" || property === "solana")) {
      try {
        return defineProperty.call(Object, target, property, attributes);
      } catch (err) {
        return target;
      }
    }
    return defineProperty.call(Object, target, property, attributes);
  };

  function ignore(event) {
    var err = event && event.error;
    var reason = event && event.reason;
    var message = String(
      (event && event.message) ||
        (err && err.message) ||
        (reason && reason.message) ||
        reason ||
        "",
    );
    var stack = String((err && err.stack) || (reason && reason.stack) || "");
    if (
      message.indexOf("Cannot redefine property: ethereum") !== -1 ||
      message.indexOf("Cannot redefine property: solana") !== -1 ||
      stack.indexOf("evmAsk.js") !== -1
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  window.addEventListener("error", ignore, true);
  window.addEventListener("unhandledrejection", ignore, true);
})();
