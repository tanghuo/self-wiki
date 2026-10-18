import { request } from "./api.js";

// Usage reporting must not turn a successful clipboard/tray action into a failure.
// Do not retry: a lost acknowledgement may already have incremented the counter.
export function recordElementUsage(id, action) {
  void request(`/api/elements/${id}/usage`, {
    method: "POST", body: JSON.stringify({ action }), keepalive: true,
  }).then(() => window.dispatchEvent(new Event("element-usage-recorded")))
    .catch((error) => console.warn("内容使用次数记录失败", error));
}
