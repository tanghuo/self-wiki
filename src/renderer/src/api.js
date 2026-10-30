// `?api=` lets the Vite dev server talk to a separately started backend. Production builds
// always use their own origin, and only loopback backends are accepted at all.
function devApiBase() {
  if (!import.meta.env?.DEV) return "";
  const requested = new URLSearchParams(window.location.search).get("api");
  if (!requested) return "";
  try {
    const url = new URL(requested);
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return "";
    return url.origin;
  } catch { return ""; }
}
const apiBase = devApiBase();

export function apiUrl(path) {
  return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok || payload?.ok === false) {
    throw Object.assign(new Error(payload?.error || payload?.message || `HTTP ${response.status}`), { code: payload?.code });
  }
  return payload;
}
