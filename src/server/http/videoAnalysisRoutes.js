import { elementId } from "../../shared/domain/elements.js";
import { json, readJson, httpError } from "./http.js";

export async function handleVideoAnalysisRoute(service, req, res, url) {
  const route = url.pathname, method = req.method;
  const firstFrame = route.match(/^\/api\/elements\/([1-9]\d*)\/video-first-frame$/);
  if (firstFrame && method === "GET") {
    const controller = new AbortController(), abort = () => controller.abort();
    res.once("close", abort);
    try {
      const image = await service.firstFrame(elementId(firstFrame[1]), controller.signal);
      res.writeHead(200, { "content-type": image.contentType, "content-length": image.bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(image.bytes); return true;
    } finally { res.off("close", abort); }
  }
  const element = route.match(/^\/api\/elements\/([1-9]\d*)\/video-analysis(?:\/(cancel))?$/);
  if (!element && !route.startsWith("/api/video-analysis/") && !route.startsWith("/api/visual-index/") && !route.startsWith("/api/visual-search")) return false;
  let result;
  if (element && method === "GET" && !element[2]) result = service.status(elementId(element[1]));
  else if (element && method === "POST") result = element[2] ? service.cancel(elementId(element[1])) : service.enqueue(elementId(element[1]), await readJson(req));
  else if (route === "/api/video-analysis/status" && method === "GET") result = service.status(url.searchParams.has("videoId") ? elementId(url.searchParams.get("videoId")) : null);
  else if (route === "/api/video-analysis/config" && method === "PUT") result = await service.configure(await readJson(req));
  else if (route === "/api/video-analysis/probe" && method === "POST") result = await service.probe();
  else if (route === "/api/visual-index/status" && method === "GET") result = service.status().visual;
  else if (route === "/api/visual-index/rebuild" && method === "POST") result = service.rebuild();
  else if (route === "/api/visual-search/rejections" && method === "POST") result = service.rejectMatch(await readJson(req));
  else if (route === "/api/visual-search" && method === "GET") {
    const sourceId = url.searchParams.has("elementId") ? elementId(url.searchParams.get("elementId")) : null;
    const frameId = url.searchParams.has("frameId") ? elementId(url.searchParams.get("frameId")) : null;
    const q = (url.searchParams.get("q") || "").trim();
    if ((!sourceId && !frameId && !q) || q.length > 2000) throw httpError(400, "请提供素材、视频帧或 1–2000 字查询");
    result = await service.search({ elementId: sourceId, frameId, q });
  } else {
    const observation = route.match(/^\/api\/video-analysis\/results\/([1-9]\d*)\/(accept|reject)$/);
    const frame = route.match(/^\/api\/video-analysis\/frames\/([1-9]\d*)$/);
    if (observation && method === "POST") result = service[observation[2]](elementId(observation[1]), await readJson(req));
    else if (frame && method === "GET") {
      const image = await service.frame(elementId(frame[1]));
      res.writeHead(200, { "content-type": image.contentType, "content-length": image.bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(image.bytes); return true;
    } else throw httpError(404, "Unknown video analysis route");
  }
  json(res, 200, result); return true;
}
