import { elementId } from "../../shared/domain/elements.js";
import { httpError, json, readJson, readImage, text } from "./http.js";

export async function handleChatRoute(chat, req, res, url) {
  if (!url.pathname.startsWith("/api/chat/")) return false;
  const route = url.pathname.slice("/api/chat/".length), method = req.method;
  const before = url.searchParams.has("before") ? elementId(url.searchParams.get("before")) : undefined;
  if (route === "attachments" && method === "POST") {
    let name;
    try { name = decodeURIComponent(req.headers["x-file-name"] || "粘贴图片.png"); }
    catch { throw httpError(400, "无效的文件名"); }
    json(res, 201, await chat.addAttachment(await readImage(req), name)); return true;
  }
  const attachment = route.match(/^attachments\/([1-9]\d*)(\/image)?$/);
  if (attachment && method === "GET" && attachment[2]) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    text(res, 200, await chat.attachmentImage(elementId(attachment[1])), "image/png"); return true;
  }
  if (attachment && method === "DELETE" && !attachment[2]) {
    json(res, 200, await chat.removeAttachment(elementId(attachment[1]))); return true;
  }
  const artifact = route.match(/^turns\/([1-9]\d*)\/artifacts\/([\da-f-]+\.png)$/);
  if (artifact && method === "GET") {
    res.setHeader("X-Content-Type-Options", "nosniff");
    text(res, 200, await chat.artifact(elementId(artifact[1]), artifact[2]), "image/png"); return true;
  }
  let result;
  if (route === "status" && method === "GET") result = chat.status();
  else if (route === "activity" && method === "GET") result = chat.activity();
  else if (route === "models" && method === "GET") result = await chat.models();
  else if (route === "probe" && method === "POST") result = await chat.probe();
  else if (route === "image-generation/probe" && method === "POST") result = await chat.probeImages(req.headers["content-length"] && req.headers["content-length"] !== "0" ? await readJson(req) : {});
  else if (route === "image-generation/preference" && method === "GET") result = chat.imagePreference();
  else if (route === "image-generation/preference" && method === "PATCH") result = chat.setImagePreference(await readJson(req));
  else if (route === "image-generation/workflows" && method === "GET") result = await chat.imageWorkflows();
  else if (route === "image-generation/workflows/load" && method === "POST") result = await chat.loadImageWorkflow(await readJson(req, { maxBytes: 1024 * 1024 }));
  else if (/^image-generation\/workflows\/[1-9]\d*$/.test(route) && method === "GET") result = chat.imageWorkflow(elementId(route.split("/").at(-1)));
  else if (route === "sessions" && method === "GET") result = chat.list(before);
  else if (route === "sessions" && method === "POST") result = chat.create();
  else if (route === "sessions/start" && method === "POST") result = chat.start(await readJson(req, { maxBytes: 128 * 1024 }));
  else if (route === "sessions/new/draft" && method === "GET") result = chat.newDraft();
  else if (route === "sessions/new/draft" && method === "PUT") result = chat.setNewDraft(await readJson(req, { maxBytes: 128 * 1024 }));
  else if (route === "model-preference" && method === "GET") result = chat.modelPreference();
  else if (route === "model-preference" && method === "PATCH") result = chat.setModelPreference(await readJson(req));
  else if (route === "proposals" && method === "POST") result = await chat.propose(req.headers["x-self-wiki-chat-token"], req.headers["x-self-wiki-chat-call"], await readJson(req));
  else {
    const session = route.match(/^sessions\/([1-9]\d*)(?:\/(turns|stop|events|draft|image-draft|image-options))?$/);
    const draft = route.match(/^turns\/([1-9]\d*)\/draft$/);
    const save = route.match(/^turns\/([1-9]\d*)\/save$/);
    const extract = route.match(/^turns\/([1-9]\d*)\/extract$/);
    const branch = route.match(/^turns\/([1-9]\d*)\/(edit|select|fork)$/);
    const trace = route.match(/^turns\/([1-9]\d*)\/trace$/);
    const proposal = route.match(/^proposals\/([1-9]\d*)\/(accept|reject|undo)$/);
    if (session) {
      const id = elementId(session[1]), action = session[2];
      if (!action && method === "GET") result = url.searchParams.has("around") ? chat.around(id, elementId(url.searchParams.get("around"))) : chat.detail(id, before);
      else if (!action && method === "PATCH") result = chat.setModel(id, await readJson(req));
      else if (action === "draft" && method === "PUT") result = chat.setDraft(id, await readJson(req));
      else if (action === "image-draft" && method === "PUT") result = chat.setImageDraft(id, await readJson(req));
      else if (action === "image-options" && method === "PATCH") result = chat.setImageOptions(id, await readJson(req));
      else if (action === "turns" && method === "POST") result = chat.send(id, await readJson(req, { maxBytes: 128 * 1024 }));
      else if (action === "stop" && method === "POST") result = await chat.stop(id);
      else if (action === "events" && method === "GET") {
        chat.detail(id);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        let blocked = false, pending;
        const send = (data) => {
          if (res.destroyed) return;
          if (blocked) { pending = data; return; }
          blocked = !res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const unsubscribe = chat.subscribe(id, send);
        // write(false) accepted the snapshot. Only send updates received while blocked;
        // replaying the same large snapshot on every drain starves other HTTP requests.
        res.on("drain", () => { blocked = false; if (pending) { const next = pending; pending = undefined; send(next); } });
        const timer = setInterval(() => { if (!res.destroyed && !blocked) blocked = !res.write(": heartbeat\n\n"); }, 15000);
        res.once("close", () => { clearInterval(timer); unsubscribe(); }); return true;
      } else throw httpError(405, "Method not allowed");
    } else if (trace && method === "GET") result = chat.trace(elementId(trace[1]), url.searchParams.has("event") ? url.searchParams.get("event") : undefined);
    else if (branch && method === "POST") result = chat[branch[2] === "select" ? "selectVersion" : branch[2]](elementId(branch[1]), await readJson(req));
    else if (extract && method === "POST") result = chat.extract(elementId(extract[1]), await readJson(req));
    else if (save && method === "POST") result = await chat.save(elementId(save[1]), await readJson(req));
    else if (draft && method === "POST") result = chat.draft(elementId(draft[1]), await readJson(req));
    else if (proposal && method === "POST") result = await chat[proposal[2]](elementId(proposal[1]), await readJson(req));
    else throw httpError(404, "Unknown chat route");
  }
  json(res, 200, result); return true;
}
