import { networkInterfaces } from "node:os";
import { httpError } from "./http.js";

export function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter((entry) =>
    entry.family === "IPv4" && !entry.internal && isLocalAddress(entry.address)).map((entry) => entry.address))];
}

function isLocalAddress(address = "") {
  const [a, b] = address.replace(/^::ffff:/, "").split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function validateLanRequest(req, host) {
  if (!isLocalAddress(req.socket.remoteAddress)) throw httpError(403, "仅允许局域网访问");
  if (!["localhost", "127.0.0.1", ...lanAddresses()].includes(host.hostname) ||
      Number(host.port || 80) !== req.socket.localPort) throw httpError(403, "Invalid host");
}
