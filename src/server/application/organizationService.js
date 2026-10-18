import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultOrganizationConfig, organizationConfig, organizationOutput } from "../../shared/domain/organization.js";
import { elementError, elementId } from "../../shared/domain/elements.js";

export async function createOrganizationService({ repo, dataDir, semantic, recordUsage, searchMedia }) {
  const configPath = path.join(dataDir, "organization.json");
  const defaultCodexHome = path.resolve(dataDir, "wiki-codex");
  await mkdir(defaultCodexHome, { recursive: true });
  let config = defaultOrganizationConfig(), configError = "", instance, child, stopping, closed = false, reconfiguring = false;
  let diagnostic = { available: false, code: "NOT_CHECKED", diagnostic: "尚未检测执行器" };
  let queue = Promise.resolve();
  try { config = organizationConfig(JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""))); }
  catch (error) { if (error.code !== "ENOENT") configError = `自动整理配置无效：${error.message}`; }
  repo.configure(!configError && config.enabled);
  await semantic.configure({ ...(configError ? defaultOrganizationConfig() : config), executor: executionConfig() });

  function executionConfig() {
    return structuredClone({ ...config.executor, imageGeneration: config.imageGeneration,
      codexCli: { ...config.executor.codexCli, codexHome: config.executor.codexCli.codexHome || defaultCodexHome,
        reuseLocalAuth: config.executor.codexCli.reuseLocalAuth ?? !config.executor.codexCli.codexHome } });
  }

  function start() {
    if (closed || reconfiguring || configError || child || !instance) return;
    diagnostic = { available: false, code: "CHECKING", diagnostic: "正在检测 Codex CLI…" };
    const processHandle = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../agent/main.js")], {
      windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child = processHandle;
    const pendingUsage = new Map();
    processHandle.on("message", (event) => {
      if (event.type !== "usage") return;
      if (event.event.state === "running") pendingUsage.set(event.event.id, event.event); else pendingUsage.delete(event.event.id);
      recordUsage?.(event.event);
    });
    processHandle.once("error", () => { diagnostic = { available: false, code: "START_FAILED", diagnostic: "无法启动整理 worker" }; });
    processHandle.on("message", (event) => { if (event.type === "error") diagnostic = { available: false, code: "WORKER_ERROR", diagnostic: String(event.message).slice(0, 1000) }; });
    processHandle.once("close", () => {
      for (const event of pendingUsage.values()) recordUsage?.({ ...event, state: "interrupted", elapsedMs: Date.now() - event.startedAt });
      if (child === processHandle) child = null;
      if (!closed && diagnostic.available) diagnostic = { available: false, code: "STOPPED", diagnostic: "整理 worker 已停止，可重新检测启动" };
    });
    processHandle.send({ type: "start", ...instance, config: { ...config, executor: executionConfig() } });
  }
  async function stop() {
    if (stopping) return stopping;
    const previous = child;
    if (!previous) return;
    stopping = new Promise((resolve) => { previous.once("close", resolve); if (previous.connected) previous.send({ type: "stop" }); else previous.kill(); });
    try { await stopping; } finally { stopping = null; }
  }
  function status(elementId, before) { return { config, configPath, defaultCodexHome, configError, executor: diagnostic, workerRunning: Boolean(child), semantic: semantic.status(), ...repo.status(elementId, before) }; }
  function token(payload) {
    if (typeof payload?.leaseToken !== "string" || payload.leaseToken.length > 120 || !payload.leaseToken) throw elementError("需要有效的任务租约");
    return payload.leaseToken;
  }
  function indices(payload) {
    if (!Array.isArray(payload?.indices) || !payload.indices.length || payload.indices.length > 40 || payload.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= 40)) throw elementError("请选择有效的整理建议");
    return [...new Set(payload.indices)];
  }
  return {
    initialize(value) { instance = value; if (!configError && (config.enabled || repo.hasPending())) start(); },
    status,
    executionConfig,
    revision: () => repo.revision(),
    configure(value) {
      const next = organizationConfig(value);
      const task = queue.then(async () => {
        if (closed) throw elementError("应用正在退出", 503);
        reconfiguring = true;
        repo.configure(false);
        try {
          await stop();
          await writeFile(`${configPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8");
          await rename(`${configPath}.tmp`, configPath);
          config = next; configError = "";
          await semantic.configure({ ...config, executor: executionConfig() });
          diagnostic = { available: false, code: "NOT_CHECKED", diagnostic: "配置已保存" };
        } finally {
          reconfiguring = false;
          repo.configure(!closed && !configError && config.enabled);
          if (config.enabled || repo.hasPending()) start();
        }
        return status();
      });
      queue = task.catch(() => {});
      return task;
    },
    probe() { if (configError) throw elementError(configError); start(); return status(); },
    enqueue(id) {
      if (closed || configError) throw elementError(configError || "应用正在退出", 503);
      const job = repo.enqueue(elementId(id)); start(); return { job };
    },
    enqueueTexts(payload) {
      if (closed || reconfiguring || configError) throw elementError(configError || "整理器正在停止或切换配置", 503);
      const after = payload?.after ?? 0, throughId = payload?.throughId ?? null;
      if (!Number.isSafeInteger(after) || after < 0 || throughId !== null && (!Number.isSafeInteger(throughId) || throughId < after)) {
        throw elementError("无效的文字检查范围");
      }
      const batch = repo.textBatch(after, throughId);
      // Each item owns a short transaction; active jobs are reused on retries.
      for (const id of batch.ids) repo.enqueue(id);
      start();
      return { count: batch.ids.length, nextAfter: batch.nextAfter, throughId: batch.throughId };
    },
    claim() { return { job: closed || reconfiguring || configError ? null : repo.claim() }; },
    heartbeat(id, payload) { return repo.heartbeat(id, token(payload)); },
    async context(id, payload) {
      const queries = payload.queries ?? [];
      if (!Array.isArray(queries) || queries.length > 3 || queries.some((q) => typeof q !== "string" || !q.trim() || q.length > 80)) throw elementError("检索词无效");
      const semanticQuery = payload.semanticQuery ?? "";
      if (typeof semanticQuery !== "string" || semanticQuery.length > 2000) throw elementError("语义检索描述过长");
      const imageIds = payload.imageIds ?? [];
      if (!Array.isArray(imageIds) || imageIds.length > 8 || imageIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw elementError("待查看图片无效");
      const lease = token(payload), initial = repo.context(id, lease, queries, null, imageIds);
      let visual = initial.visual;
      const source = initial.elements.find((e) => e.id === initial.sourceId);
      if (!visual && ["image", "video"].includes(source.kind) && searchMedia) {
        try { visual = await searchMedia(initial.sourceId); }
        catch { visual = { matches: [], diagnostic: "视觉候选暂不可用，使用已有内容检索" }; }
      }
      const query = semanticQuery || queries.join("；");
      const retrieval = !config.embedding.enabled ? null : source.kind === "video"
        ? query ? await semantic.search({ query }) : { matches: [], reason: "视频首帧尚未描述" }
        : await semantic.search({ elementId: initial.sourceId, query });
      if (closed || reconfiguring) throw elementError("整理器正在停止或切换配置", 503);
      return repo.context(id, lease, queries, retrieval, imageIds, visual);
    },
    semanticStatus: () => semantic.status(),
    semanticProbe: () => semantic.probe(),
    semanticRebuild: (payload) => semantic.rebuild(payload.mode || "missing"),
    semanticSearch(payload) {
      if (typeof payload.query !== "string" || !payload.query.trim() || payload.query.length > 2000) throw elementError("请输入 1–2000 字的检索内容");
      return semantic.search({ query: payload.query.trim() });
    },
    submit(id, payload) {
      if (closed || reconfiguring || configError) throw elementError("整理器正在停止或切换配置", 503);
      const lease = token(payload), output = organizationOutput(payload.output);
      if (output.queries.length || output.imageRequests.length || typeof payload.requestKey !== "string" || !payload.requestKey || payload.requestKey.length > 160 ||
          !payload.execution || typeof payload.execution !== "object" || Array.isArray(payload.execution) || JSON.stringify(payload.execution).length > 4000) throw elementError("提交结果信息无效");
      return repo.submit(id, lease, payload.requestKey, output, payload.execution, config.applyMode === "auto");
    },
    fail(id, payload) {
      if (typeof payload.message !== "string" || typeof payload.retryable !== "boolean") throw elementError("失败信息无效");
      if (payload.code !== undefined && payload.code !== "AUTH_REQUIRED") throw elementError("失败类型无效");
      return repo.failed(id, token(payload), payload.message, payload.retryable, payload.code);
    },
    result: (id) => repo.result(id),
    accept: (id, payload) => repo.accept(id, indices(payload)),
    reject: (id, payload) => repo.reject(id, indices(payload)),
    undo: (id) => repo.undo(id),
    correct(payload) {
      if (!["remove", "replace"].includes(payload?.operation) || !Array.isArray(payload.selections) ||
          !payload.selections.length || payload.selections.length > 100) throw elementError("请选择 1–100 个整理结果");
      const selections = payload.selections.map((item) => {
        if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= 40) throw elementError("无效的整理结果");
        return { resultId: elementId(item.resultId), index: item.index };
      });
      if (new Set(selections.map((s) => `${s.resultId}:${s.index}`)).size !== selections.length) throw elementError("不能重复选择整理结果");
      if (payload.operation === "replace" && typeof payload.name !== "string") throw elementError("请输入替换名称");
      return repo.correct(selections, payload.operation, payload.name);
    },
    workerState(value) {
      if (typeof value.available !== "boolean" || typeof value.diagnostic !== "string") throw elementError("执行器状态无效");
      diagnostic = { available: value.available, diagnostic: value.diagnostic.slice(0, 1000), code: String(value.code || "").slice(0, 80), version: String(value.version || "").slice(0, 100), path: String(value.path || "").slice(0, 1000) };
      return { ok: true };
    },
    async close() { closed = true; repo.configure(false); await queue; await Promise.all([stop(), semantic.close()]); },
  };
}
