// LAN HTTP does not expose randomUUID. getRandomValues remains available;
// preserve native UUID generation on localhost/HTTPS and in capable workers.
(() => {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID === "function") return;
  if (typeof cryptoApi.getRandomValues !== "function") return;
  Object.defineProperty(cryptoApi, "randomUUID", {
    configurable: true,
    writable: true,
    value() {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
})();
