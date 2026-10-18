const apiBase = (new URLSearchParams(window.location.search).get("api") || "").replace(/\/+$/, "");

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
    throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}
