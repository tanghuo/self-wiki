// Use the socket address, never client-controlled forwarding headers.
export function createPairingLimiter() {
  let generation, until = 0, total = 0;
  const peers = new Map();
  return {
    attempt(address, key) {
      const now = Date.now();
      if (key !== generation || now >= until) {
        generation = key; until = now + 60_000; total = 0; peers.clear();
      }
      const count = peers.get(address) || 0;
      if (count >= 10 || total >= 100) return Math.max(1, Math.ceil((until - now) / 1000));
      peers.set(address, count + 1); total++;
      return 0;
    },
  };
}
