import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export class CliError extends Error {
  constructor(code, message, exitCode = 1, details, status) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.status = status;
  }
}

function localUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new CliError("USAGE", "--url must be a local HTTP origin", 2); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("USAGE", "--url must be a loopback HTTP origin, such as http://127.0.0.1:8765", 2);
  }
  return url.href;
}

async function request(url, route, { method = "GET", body, headers = {}, timeout = 30000, format = "json" } = {}) {
  let response, data;
  try {
    response = await fetch(new URL(route, url), { method, body, headers, signal: AbortSignal.timeout(timeout), redirect: "manual", ...(body?.[Symbol.asyncIterator] ? { duplex: "half" } : {}) });
    if (response.ok && format === "stream") return response.body;
    const text = await response.text();
    if (response.ok && format === "text") return text;
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new CliError("PROTOCOL", "Expected a self-wiki JSON response; check the API URL and restart an older backend", 3);
    }
    try { data = JSON.parse(text); }
    catch { throw new CliError("PROTOCOL", "Server returned invalid JSON", 3); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("CONNECTION", `Request failed: ${error.message}.${method === "GET" ? " Check that the backend is running." : " The operation may have succeeded; inspect state before retrying."}`, 3);
  }
  if (!response.ok) throw new CliError("API_ERROR", data?.error || `HTTP ${response.status}`, 1, data, response.status);
  return data;
}

async function identify(url, timeout) {
  const info = await request(url, "/api/instance", { timeout });
  if (info?.application !== "self-wiki" || info.protocolVersion !== 1 || typeof info.instanceId !== "string" || !info.instanceId || typeof info.dataDir !== "string") {
    throw new CliError("PROTOCOL", "The endpoint is not a compatible self-wiki backend; restart/update it", 3);
  }
  return info;
}

export async function connect(options) {
  const timeout = options.timeout ?? 30000;
  const explicitUrl = options.url ?? (process.env.SELF_WIKI_URL || undefined);
  let url, instance;
  if (explicitUrl !== undefined) {
    url = localUrl(explicitUrl);
    instance = await identify(url, timeout);
  } else {
    const dataDir = path.resolve(options["data-dir"] || process.env.APP_DATA_DIR || path.resolve(import.meta.dirname, "../../data"));
    const runtimeDir = path.join(dataDir, ".runtime");
    let files;
    try { files = await readdir(runtimeDir); }
    catch (error) { if (error.code === "ENOENT") files = []; else throw error; }
    const candidates = await Promise.all(files.filter((name) => /^server-[\da-f-]+\.json$/.test(name)).map(async (name) => {
      let saved;
      try { saved = JSON.parse(await readFile(path.join(runtimeDir, name), "utf8")); }
      catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
      // Discovery records are hints, not proof that a reused port still owns this database.
      try {
        if (typeof saved?.dataDir !== "string" || path.relative(dataDir, path.resolve(saved.dataDir)) !== "") return null;
        const candidateUrl = localUrl(saved.url);
        const current = await identify(candidateUrl, Math.min(timeout, 1500));
        if (current.instanceId !== saved.instanceId || path.relative(dataDir, path.resolve(current.dataDir)) !== "") return null;
        return { url: candidateUrl, instance: current };
      } catch (error) { if (error instanceof CliError) return null; throw error; }
    }));
    const active = candidates.filter(Boolean);
    if (!active.length) throw new CliError("NOT_RUNNING", `No active self-wiki backend found in ${dataDir}. Start/restart the app or run npm start; use --data-dir for a custom directory or --url for an explicit API origin.`, 3);
    if (active.length > 1) throw new CliError("AMBIGUOUS_INSTANCE", "Multiple backends are running. Select one with --url.", 3, active.map((entry) => entry.instance));
    ({ url, instance } = active[0]);
  }
  return {
    instance: { ...instance, url },
    request: (route, options = {}) => request(url, route, { ...options, timeout, headers: { ...options.headers, "x-self-wiki-instance": instance.instanceId,
      ...(process.env.SELF_WIKI_CHAT_TOKEN && { "x-self-wiki-chat-token": process.env.SELF_WIKI_CHAT_TOKEN, "x-self-wiki-chat-call": process.env.SELF_WIKI_CHAT_CALL || "" }) } }),
  };
}
