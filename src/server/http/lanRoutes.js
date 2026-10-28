import { networkInterfaces } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import { httpError } from "./http.js";
import QRCode from "qrcode";

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

export const lanTokenHeader = "x-self-wiki-lan-token";
export const lanTokenCookie = "self_wiki_lan_token";

export function lanRequestToken(req) {
  const header = req.headers[lanTokenHeader];
  if (typeof header === "string" && header) return header;
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === lanTokenCookie) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

export function lanTokenMatches(candidate, token) {
  if (typeof candidate !== "string" || typeof token !== "string" || !candidate || !token) return false;
  const left = createHash("sha256").update(candidate).digest(), right = createHash("sha256").update(token).digest();
  return timingSafeEqual(left, right);
}

// Settings, agent sessions, background AI jobs and executable configuration
// never leave this machine, even when LAN editing is allowed.
const lanReadPosts = new Set(["/api/organization/semantic/search"]);

export function lanRestriction(method, pathname, { allowWrite = false } = {}) {
  if (/^\/api\/(?:workflows|workflow-node-types|workflow-runs|workflow-artifacts)(?:\/|$)/.test(pathname)) return '工作流定义、运行、事件与产物仅限本机';
  const read = method === "GET" || method === "HEAD";
  if (pathname.startsWith("/api/chat/")) return "Agent 会话仅限本机使用";
  if (pathname === "/api/lan-sharing" && !read || pathname.startsWith("/api/lan-sharing/")) return "局域网共享设置仅限本机修改";
  if (pathname.startsWith("/api/organization/") && !read && !lanReadPosts.has(pathname)) return "自动整理及其配置仅限本机操作";
  if (/^\/api\/elements\/[1-9]\d*\/video-analysis(?:\/cancel)?$/.test(pathname) && !read) return "视频分析仅限本机启动或取消";
  if (["/api/video-analysis/config", "/api/video-analysis/probe", "/api/visual-index/rebuild"].includes(pathname) && !read) return "视频分析配置与索引仅限本机操作";
  if (/^\/api\/elements\/[1-9]\d*\/description\/regenerate$/.test(pathname)) return "重新生成图片说明仅限本机操作";
  if (!allowWrite && !read && !lanReadPosts.has(pathname)) return "局域网共享为只读模式；如需编辑，请在本机设置中允许局域网编辑";
  return "";
}

export async function lanPairingPage(failed = false, pageUrl = "") {
  // Self-contained (unpaired visitors cannot load app assets); colors follow the app's 暖纸/夜间 themes.
  // Failure page may include a host-only QR (no pairing token) so phones can reopen this form.
  let qrBlock = "";
  if (failed && pageUrl) {
    try {
      const svg = await QRCode.toString(pageUrl, { type: "svg", margin: 1, width: 148, color: { dark: "#39362f", light: "#00000000" } });
      qrBlock = `<figure class="qr" aria-label="本配对页二维码">${svg}<figcaption>扫码可回到本页；正确配对请用电脑「设置 → 局域网共享」中的二维码。</figcaption></figure>`;
    } catch { /* QR is optional enrichment */ }
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>self-wiki 局域网配对</title>
<style>
:root{--bg:#eee8dc;--panel:#f6f1e7;--ink:#39362f;--muted:#635c50;--line:#d8cfbf;--accent:#725b3e;--accent-hover:#5d482e;--on-accent:#fffaf2;--focus:#987344;--bad:#a13f3b;--bad-soft:#f3dcd8;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1e2329;--panel:#282e35;--ink:#dce2e8;--muted:#aab5c1;--line:#3b4551;--accent:#abc4df;--accent-hover:#c1d5eb;--on-accent:#1e2b39;--focus:#aac7e8;--bad:#f0a09a;--bad-soft:#47292a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:14px/1.7 "Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
main{width:min(100%,420px);padding:32px 28px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 14px 40px rgb(40 49 65/.12)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;color:var(--muted);font-size:13px;font-weight:600}.brand i{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--accent);color:var(--on-accent);font-style:normal;font-weight:700}
h1{margin:0 0 8px;font-size:22px;font-weight:600;letter-spacing:-.3px}p{margin:0 0 18px;color:var(--muted);font-size:13px}
.error{display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid color-mix(in srgb,var(--bad) 30%,var(--line));border-left:3px solid var(--bad);border-radius:8px;background:var(--bad-soft);color:var(--ink)}
label{display:grid;gap:6px;font-size:13px;font-weight:600}input{width:100%;min-height:42px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:15px ui-monospace,Consolas,monospace;letter-spacing:.5px}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
button{width:100%;min-height:42px;margin-top:14px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}button:hover{background:var(--accent-hover)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}small{display:block;margin-top:16px;color:var(--muted);font-size:12px}.hint{margin:14px 0 0;color:var(--muted);font-size:12px}
.qr{margin:16px 0 0;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);text-align:center}.qr svg{display:block;width:148px;height:148px;margin:0 auto}.qr figcaption{margin-top:8px;color:var(--muted);font-size:12px;font-weight:500}
</style></head>
<body><main><div class="brand"><i aria-hidden="true">W</i>self-wiki · 局域网共享</div><h1>需要局域网配对码</h1><p>请在运行 self-wiki 的电脑上打开“设置 → 局域网共享”，在下方输入设置页显示的 6 位数字配对码即可连接。手机也可扫描设置页二维码。</p>
${failed ? `<p class="error" role="alert">${failed === "limited" ? "尝试次数过多，请稍等一分钟再输入配对码。" : "配对码不正确或已更换，请核对电脑设置页中的 6 位数字。"}</p>` : ""}<form method="get" action="/"><label>配对码<input name="pair" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" required autofocus></label><button type="submit">连接</button></form>
${qrBlock}${failed ? '<p class="hint">设备需在同一局域网；请以电脑设置页显示的配对码为准。</p>' : ""}<small>配对后，本浏览器会记住此设备，无需重复输入。</small></main></body></html>`;
}
