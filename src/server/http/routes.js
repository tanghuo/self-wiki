import { httpError, json, readJson, serveStatic } from "./http.js";
import { handleElementRoute } from "./elementRoutes.js";
import { handleOrganizationRoute } from "./organizationRoutes.js";
import { handleVideoAnalysisRoute } from "./videoAnalysisRoutes.js";
import { handleChatRoute } from "./chatRoutes.js";
import { validateLanRequest } from "./lanRoutes.js";

export function createRequestHandler({ wiki, sharing, organization, semantic, videoAnalysis, chat, usage, instance, rendererDist, access = "local" }) {
  const routes = new Map([
    ["GET /api/token-usage", async (_req, res, url) => {
      const days = Number(url.searchParams.get("days") ?? 7);
      if (![0, 1, 7, 30].includes(days)) throw httpError(400, "无效的统计时间范围");
      json(res, 200, usage.report(days));
    }],
    ["GET /api/instance", async (_req, res) => json(res, 200, instance)],
    ["GET /api/lan-sharing", async (_req, res) => json(res, 200, sharing.status())],
    ["PUT /api/lan-sharing", async (req, res) => json(res, 200, await sharing.configure(await readJson(req)))],
    ["POST /api/lan-sharing", async (req, res) => json(res, 200, await sharing.setEnabled((await readJson(req)).enabled, access === "lan" ? res : undefined))],
  ]);

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
      if (req.headers["x-self-wiki-instance"] && req.headers["x-self-wiki-instance"] !== instance?.instanceId) {
        throw httpError(409, "Server instance changed; reconnect before retrying");
      }
      const url = new URL(req.url || "/", host);
      if (chat && await handleChatRoute(chat, req, res, url)) return;
      if (organization && await handleOrganizationRoute(organization, req, res, url)) return;
      if (videoAnalysis && await handleVideoAnalysisRoute(videoAnalysis, req, res, url)) return;
      if (wiki && await handleElementRoute(wiki, req, res, url, semantic, { allowTrashPreview: access === "local", allowUsageStats: access === "local", allowMaterialWrite: access === "local" })) return;
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (handler) await handler(req, res, url);
      else if (url.pathname.startsWith("/api/") || url.pathname === "/image") throw httpError(404, "Not found");
      else if (req.method === "GET") await serveStatic(res, url, rendererDist);
      else throw httpError(405, "Method not allowed");
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error.message, jobId: error.jobId || "" });
    }
  };
}
