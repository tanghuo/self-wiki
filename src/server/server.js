import { createServer as createHttpServer } from "node:http";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createLocalAuthentication } from './application/localAuthentication.js';
import { saveLocalCredentials } from './assets/localCredentials.js';
import { createVectorQueries } from "./data/vectorQueries.js";
import { initDb } from "./data/sqlite.js";
import { createRequestHandler } from "./http/routes.js";
import { createElementRepository } from "./data/elementRepository.js";
import { createElementService } from "./application/elementService.js";
import { createImageStore } from "./assets/imageStore.js";
import { createVideoStore } from "./assets/videoStore.js";
import { createLanSharing } from "./application/lanSharing.js";
import { lanAddresses } from "./http/lanRoutes.js";
import { createOrganizationRepository } from "./data/organizationRepository.js";
import { createOrganizationService } from "./application/organizationService.js";
import { createSemanticRepository } from "./data/semanticRepository.js";
import { createSemanticService } from "./application/semanticService.js";
import { createChatRepository } from "./data/chatRepository.js";
import { createChatService } from "./application/chatService.js";
import { createUsageRepository } from "./data/usageRepository.js";
import { createChatArchiveRepository } from "./data/chatArchiveRepository.js";
import { createChatArchiveService } from "./application/chatArchiveService.js";
import { createVideoAnalysisRepository } from "./data/videoAnalysisRepository.js";
import { createVideoAnalysisService } from "./application/videoAnalysisService.js";
import { createTemporaryShares } from "./application/temporaryShares.js";
import { createWorkflowRepository } from './data/workflowRepository.js';
import { createWorkflowStore } from './assets/workflowStore.js';
import { createWorkflowService } from './application/workflow/service.js';
import { createAgentWorkbenchRepository } from './data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from './application/agentWorkbench/service.js';
import { createAgentTaskRepository } from './data/agentTaskRepository.js';
import { createAgentWikiRepository } from './data/agentWikiRepository.js';
import { createAgentArtifactStore } from './assets/agentArtifactStore.js';
import { createAgentCommandStore } from './assets/agentCommandStore.js';
import { createAgentTaskService } from './application/agentTasks/service.js';
import { createAgentTools } from './application/agentTools/service.js';

const projectRoot = path.resolve(import.meta.dirname, "../..");
// Fetch Standard port blocking: https://fetch.spec.whatwg.org/#port-blocking
const browserBlockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export async function createServer(options = {}) {
  const authentication = createLocalAuthentication();
  const port = Number(options.port ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  if (port !== 0 && browserBlockedPorts.has(port)) throw new Error(`Port ${port} is blocked by browsers; choose another port or 0 for automatic selection`);
  const dataDir = path.resolve(options.dataDir || path.join(projectRoot, "data"));
  await mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "library.sqlite3");
  const db = initDb(dbPath);
  const vectorQueries = createVectorQueries(db, dbPath);
  const imageStore = createImageStore(path.join(dataDir, "assets"));
  const archive = createChatArchiveService({ repo: createChatArchiveRepository(db), imageStore, dataDir });
  const wikiRepo = createElementRepository(db);
  const wiki = createElementService(wikiRepo, imageStore, archive.cleanup, createVideoStore(path.join(dataDir, "assets", "videos")));
  try { await wiki.prepareImages(); }
  catch (error) { db.close(); throw error; }
  const rendererDist = path.join(projectRoot, "dist/renderer");
  const usage = createUsageRepository(db);
  const recordUsage = (event) => usage.record(event);
  const semantic = createSemanticService({ repo: createSemanticRepository(db, { vectorQueries }), wiki, recordUsage });
  const mediaSearch = {
    searchFirstFrame(elementId) {
      throw Object.assign(new Error("视频分析尚未就绪"), { statusCode: 503 });
    },
  };
  const organization = await createOrganizationService({
    repo: createOrganizationRepository(db), dataDir, semantic, recordUsage, workerAuthentication: authentication,
    searchMedia: (elementId) => mediaSearch.searchFirstFrame(elementId),
  });
  const videoAnalysis = await createVideoAnalysisService({
    repo: createVideoAnalysisRepository(db, { wiki: wikiRepo, vectorQueries }),
    wiki, dataDir, recordUsage,
    executionConfig: () => organization.executionConfig(),
    getEmbeddingConfig: () => organization.status().config.embedding,
  });
  mediaSearch.searchFirstFrame = (elementId) => videoAnalysis.search({ elementId, firstFrame: true });
  const chat = createChatService({ repo: createChatRepository(db), wiki, archive, organization, dataDir, recordUsage });
  let agentWorkbench;
  const workflow = createWorkflowService({ repo: createWorkflowRepository(db), store: createWorkflowStore(dataDir), wiki, imageStore, executeAgent: (...args) => agentWorkbench.executeWorkflowAgent(...args), executionConfig: () => organization.executionConfig() });
  const workbenchRepo = createAgentWorkbenchRepository(db);
  // Kept closed until the installed ACP SDK tool path passes live validation.
  const applicationToolsVerified = options.agentApplicationToolsEnabled !== false;
  const agentTasks = createAgentTaskService({ repo: createAgentTaskRepository(db), sessions: workbenchRepo, store: createAgentArtifactStore(dataDir), wiki, workflow, executionConfig: () => organization.executionConfig(), enabled: () => applicationToolsVerified && agentWorkbench?.status().agentWorkbenchEnabled, imageExecutor: options.workbenchImageExecutor });
  const agentTools = createAgentTools({ wiki, repo: createAgentWikiRepository(db), tasks: agentTasks });
  const artifactInspection = await agentTasks.inspectStorage();
  if (artifactInspection.unreferenced.length) console.warn(`[self-wiki] Agent artifact inspection: ${artifactInspection.unreferenced.length} unreferenced files preserved; inspect /api/agent/storage-inspection`);
  agentWorkbench = await createAgentWorkbenchService({ repo: workbenchRepo, dataDir, legacyChat: chat, wiki, executionConfig: () => organization.executionConfig(), initiallyEnabled: options.agentWorkbenchEnabled === true, openEngine: options.openWorkbenchEngine, tools: agentTools, tasks: agentTasks, commandStore: createAgentCommandStore(dataDir), applicationToolsVerified, codexVerified: options.agentCodexWorkbenchEnabled !== false });
  agentTasks.schedule();
  const instance = { application: "self-wiki", protocolVersion: 1, instanceId: randomUUID(), dataDir };
  const services = {
    authentication,
    instance,
    wiki,
    organization,
    semantic,
    videoAnalysis,
    chat,
    workflow,
    agentWorkbench,
    agentTasks,
    usage,
    rendererDist,
  };
  const temporaryShares = await createTemporaryShares(dataDir);
  services.temporaryShares = temporaryShares;
  const sharing = await createLanSharing({
    dataDir,
    listAddresses: lanAddresses,
    createHandler: (sharingInstance) => createRequestHandler({ ...services, sharing: sharingInstance, access: "lan" }),
  });
  const handleRequest = createRequestHandler({ ...services, sharing });
  const requests = new Set();
  const server = createHttpServer((req, res) => {
    const running = handleRequest(req, res);
    requests.add(running);
    running.finally(() => requests.delete(running)).catch((error) => console.error("[self-wiki] request failed:", error?.stack || error));
  });
  let actualPort;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      actualPort = server.address().port;
      if (!browserBlockedPorts.has(actualPort)) break;
      // Ephemeral ports are assigned by the OS and can still be blocked by the renderer.
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (browserBlockedPorts.has(actualPort)) throw new Error("Unable to allocate a browser-accessible port after 10 attempts");
  } catch (error) {
    await agentWorkbench.close();
    await agentTasks.close();
    await workflow.close();
    await temporaryShares.close();
    await videoAnalysis.close();
    await chat.close();
    await sharing.close();
    await organization.close();
    await vectorQueries.close();
    db.close();
    throw error;
  }
  instance.url = `http://127.0.0.1:${actualPort}/`;
  const runtimeDir = path.join(dataDir, ".runtime");
  const runtimePath = path.join(runtimeDir, `server-${instance.instanceId}.json`);
  let credentialsPath;
  let closing;
  const app = {
    port: actualPort, dataDir, url: `http://127.0.0.1:${actualPort}/`,
    createBootstrapCode: () => authentication.createBootstrapCode(),
    managementHeaders: () => authentication.managementHeaders(),
    get credentialFile() { return credentialsPath; },
    close() {
      closing ||= (async () => {
        await agentWorkbench.close();
        await agentTasks.close();
        await workflow.close();
        await videoAnalysis.close();
        await chat.close();
        await organization.close();
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await sharing.close();
        await temporaryShares.close();
        await Promise.allSettled([...requests]);
        await stopped;
        await wiki.closePreviews();
        await vectorQueries.close();
        db.close();
        await rm(runtimePath, { force: true });
        if (credentialsPath) await rm(credentialsPath, { force: true });
      })();
      return closing;
    },
  };
  try {
    await mkdir(runtimeDir, { recursive: true });
    credentialsPath = await saveLocalCredentials(runtimeDir, instance.instanceId, authentication.credential());
    await writeFile(runtimePath, JSON.stringify(instance), { flag: "wx", mode: 0o600 });
    organization.initialize({ url: instance.url, instanceId: instance.instanceId });
    chat.initialize({ url: instance.url, instanceId: instance.instanceId });
    videoAnalysis.start();
    workflow.start();
    wiki.startPreviews().catch((error) => console.error("[self-wiki] preview warming failed:", error?.stack || error));
    if (sharing.status().autoStart) await sharing.setEnabled(true).catch(() => {});
  } catch (error) { await app.close(); throw error; }
  return app;
}

async function runCli() {
  const options = {};
  let open = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--port") options.port = Number(args[++i]);
    else if (args[i] === "--data-dir") options.dataDir = args[++i];
    else if (args[i] === "--open") open = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  // Background failures are logged and the API keeps serving; a synchronous crash
  // leaves state unknown, so exit and let the desktop shell offer a restart.
  process.on("unhandledRejection", (reason) => console.error("[self-wiki] unhandled rejection:", reason?.stack || reason));
  process.on("uncaughtException", (error) => { console.error("[self-wiki] uncaught exception:", error?.stack || error); process.exit(70); });
  const server = await createServer(options);
  const close = () => server.close().then(() => { if (process.connected) process.disconnect(); });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.on("message", (message) => { if (message?.type === "shutdown") void close(); });
  process.once("disconnect", close);
  process.send?.({ type: "ready", url: server.url, bootstrapCode: server.createBootstrapCode() });
  console.log(`self-wiki API running at ${server.url}`);
  console.log(`Data: ${server.dataDir}`);
  if (open) {
    const browserUrl = `${server.url}#local-bootstrap=${server.createBootstrapCode()}`;
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, process.platform === "win32" ? ["/c", "start", "", browserUrl] : [browserUrl], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", (error) => console.error(`Unable to open browser: ${error.message}`));
    child.unref();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => { console.error(error); process.exitCode = 1; });
}
