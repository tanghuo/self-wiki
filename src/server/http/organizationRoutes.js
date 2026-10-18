import { elementId } from "../../shared/domain/elements.js";
import { httpError, json, readJson } from "./http.js";

export async function handleOrganizationRoute(organization, req, res, url) {
  const root = "/api/organization/";
  if (!url.pathname.startsWith(root)) return false;
  const route = url.pathname.slice(root.length), method = req.method;
  let result;
  if (route === "revision" && method === "GET") { json(res, 200, organization.revision()); return true; }
  if (route === "status" && method === "GET") result = organization.status(url.searchParams.has("elementId") ? elementId(url.searchParams.get("elementId")) : null, url.searchParams.has("before") ? elementId(url.searchParams.get("before")) : null);
  else if (route === "correct" && method === "POST") result = organization.correct(await readJson(req));
  else if (route === "config" && method === "PUT") result = await organization.configure(await readJson(req, { maxBytes: 1024 * 1024 }));
  else if (route === "probe" && method === "POST") result = organization.probe();
  else if (route === "enqueue" && method === "POST") result = organization.enqueue((await readJson(req)).elementId);
  else if (route === "enqueue-texts" && method === "POST") result = organization.enqueueTexts(await readJson(req));
  else if (route === "claim" && method === "POST") result = organization.claim();
  else if (route === "worker-state" && method === "POST") result = organization.workerState(await readJson(req));
  else if (route === "semantic/status" && method === "GET") result = organization.semanticStatus();
  else if (route === "semantic/probe" && method === "POST") result = await organization.semanticProbe();
  else if (route === "semantic/rebuild" && method === "POST") result = organization.semanticRebuild(await readJson(req));
  else if (route === "semantic/search" && method === "POST") result = await organization.semanticSearch(await readJson(req));
  else {
    const job = route.match(/^jobs\/([1-9]\d*)\/(heartbeat|context|submit|fail)$/);
    const record = route.match(/^results\/([1-9]\d*)(?:\/(accept|reject|undo))?$/);
    if (job && method === "POST") result = await organization[job[2]](elementId(job[1]), await readJson(req));
    else if (record && !record[2] && method === "GET") result = organization.result(elementId(record[1]));
    else if (record?.[2] && method === "POST") result = organization[record[2]](elementId(record[1]), await readJson(req));
    else throw httpError(404, "Unknown organization route");
  }
  json(res, 200, result);
  return true;
}
