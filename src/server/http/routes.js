import { httpError, json, text, readJson, serveStatic } from "./http.js";
import { handleElementRoute } from "./elementRoutes.js";
import { handleOrganizationRoute } from "./organizationRoutes.js";
import { handleVideoAnalysisRoute } from "./videoAnalysisRoutes.js";
import { handleChatRoute } from "./chatRoutes.js";
import { handleWorkflowRoute } from './workflowRoutes.js';
import { handleTemporaryShareRoute, handleSharedDownloadRoute } from "./temporaryShareRoutes.js";
import { validateLanRequest, lanRequestToken, lanTokenMatches, lanRestriction, lanPairingPage, lanTokenCookie } from "./lanRoutes.js";
import { createPairingLimiter } from "./pairingLimiter.js";
import { handleLocalAuthRoute } from './localAuthRoutes.js';
import { handleAgentWorkbenchRoute } from './agentWorkbenchRoutes.js';
import { handleAionuiExperimentRoute } from './aionuiExperimentRoutes.js';

export function createRequestHandler({ wiki, sharing, temporaryShares, organization, semantic, videoAnalysis, chat, workflow, agentWorkbench, agentTasks, aionuiExperiment, usage, instance, authentication, rendererDist, access = "local" }) {
  const routes = new Map([
    ["GET /api/token-usage", async (_req, res, url) => {
      const days = Number(url.searchParams.get("days") ?? 7);
      if (![0, 1, 7, 30].includes(days)) throw httpError(400, "无效的统计时间范围");
      json(res, 200, usage.report(days));
    }],
    ["GET /api/instance", async (_req, res) => json(res, 200, instance)],
    ["GET /api/lan-sharing", async (_req, res) => json(res, 200, sharing.status(access))],
    ["POST /api/lan-sharing/token", async (_req, res) => json(res, 200, await sharing.regenerateToken())],
    ["POST /api/lan-sharing/pairing", async (_req, res) => json(res, 200, await sharing.beginPairing())],
    ["PUT /api/lan-sharing", async (req, res) => json(res, 200, await sharing.configure(await readJson(req)))],
    ["POST /api/lan-sharing", async (req, res) => json(res, 200, await sharing.setEnabled((await readJson(req)).enabled, access === "lan" ? res : undefined))],
  ]);

  // Bound guesses across all peers; do not trust forwarding headers for identity.
  const pairingLimiter = createPairingLimiter();
  // Returns true when the LAN request was fully answered (pairing redirect or page).
  async function lanGate(req, res, host) {
    const policy = sharing.policy();
    const url = new URL(req.url || "/", host);
    if (policy.requireToken) {
      const pair = url.searchParams.get("pair");
      if (pair !== null && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (!lanTokenMatches(pair, policy.token)) {
          const retryAfter = pairingLimiter.attempt(req.socket.remoteAddress, `${policy.token}:${policy.pairingCode}`);
          if (retryAfter) {
            res.setHeader("retry-after", String(retryAfter));
            text(res, 429, await lanPairingPage("limited", url.origin + "/"), "text/html; charset=utf-8"); return true;
          }
          if (!lanTokenMatches(pair, policy.pairingCode) || !sharing.consumePairingCode(pair)) {
            text(res, 401, await lanPairingPage(true, url.origin + "/"), "text/html; charset=utf-8"); return true;
          }
        }
        url.searchParams.delete("pair");
        res.writeHead(303, { location: `${url.pathname}${url.search}`,
          "set-cookie": `${lanTokenCookie}=${encodeURIComponent(policy.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
        res.end(); return true;
      }
      if (!lanTokenMatches(lanRequestToken(req), policy.token)) {
        if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
          text(res, 401, await lanPairingPage(false, url.origin + "/"), "text/html; charset=utf-8"); return true;
        }
        throw httpError(401, "需要局域网配对；请在浏览器中打开共享地址并输入本机设置中的 6 位配对码");
      }
    }
    const restriction = lanRestriction(req.method, url.pathname, policy);
    if (restriction) throw httpError(403, restriction);
    return false;
  }

  return async (req, res) => {
    try {
      const host = new URL(`http://${req.headers.host || "127.0.0.1"}`);
      if (access === "lan") {
        validateLanRequest(req, host);
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-security-policy", "frame-ancestors 'none'");
      } else if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) throw httpError(403, "Invalid host");
      if (req.headers.origin && req.headers.origin !== host.origin) throw httpError(403, "Invalid origin");
      const url = new URL(req.url || "/", host);
      if (temporaryShares && await handleSharedDownloadRoute(temporaryShares, req, res, url)) return;
      if (access === "lan" && await lanGate(req, res, host)) return;
      if (access === 'local') {
        if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { ok: true, application: 'self-wiki' }); return; }
        if (authentication && await handleLocalAuthRoute(authentication, req, res, url)) return;
        if (url.pathname.startsWith('/api/') || url.pathname === '/image') {
          res.setHeader('cache-control', 'no-store');
          const management = authentication?.isManagement(req), worker = !management && authentication?.isWorker(req, url);
          if (worker) req.localPrincipal = 'organizer-worker';
          if (!management && !worker && !chat?.authorizeToolRequest?.(req, url)) {
            throw httpError(401, '需要本机配对或管理凭据');
          }
        }
      }
      if (req.headers["x-self-wiki-instance"] && req.headers["x-self-wiki-instance"] !== instance?.instanceId) {
        throw httpError(409, "Server instance changed; reconnect before retrying");
      }
      if (aionuiExperiment && await handleAionuiExperimentRoute(aionuiExperiment, req, res, url, access)) return;
      if (workflow && await handleWorkflowRoute(workflow, req, res, url, access)) return;
      if (agentWorkbench && await handleAgentWorkbenchRoute(agentWorkbench, req, res, url, access, agentTasks)) return;
      if (temporaryShares && await handleTemporaryShareRoute(temporaryShares, req, res, url, access)) return;
      if (chat && await handleChatRoute(chat, req, res, url)) return;
      if (organization && await handleOrganizationRoute(organization, req, res, url)) return;
      if (videoAnalysis && await handleVideoAnalysisRoute(videoAnalysis, req, res, url)) return;
      if (wiki && await handleElementRoute(wiki, req, res, url, semantic, { allowTrashPreview: access === "local", allowUsageStats: access === "local", allowMaterialWrite: access === "local" })) return;
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (handler) await handler(req, res, url);
      else if (url.pathname.startsWith("/api/") || url.pathname === "/image") throw httpError(404, "Not found");
      else if (req.method === "GET") await serveStatic(res, url, rendererDist, access === "lan" ? { access: sharing.policy().allowWrite ? "lan-edit" : "read-only" } : {});
      else throw httpError(405, "Method not allowed");
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error.message, message: error.message, code: error.code || 'REQUEST_FAILED', retryable: error.retryable === true, stateKnown: error.stateKnown !== false, jobId: error.jobId || "" });
    }
  };
}
