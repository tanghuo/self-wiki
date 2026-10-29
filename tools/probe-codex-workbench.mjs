import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCodexAppServer } from '../src/agent/executors/codexAppServer.js';
import { defaultOrganizationConfig } from '../src/shared/domain/organization.js';

if (!process.argv.includes('--live')) throw new Error('--live required; starts Codex without a model turn');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-codex-workbench-'))), cwd = path.join(root, 'project'); await mkdir(cwd);
const config = defaultOrganizationConfig().executor; config.codexCli = { ...config.codexCli, codexHome: path.join(root, 'codex-home'), reuseLocalAuth: true };
const profile = `wiki_${randomUUID().replaceAll('-', '')}`;
const nativeRead = process.argv.includes('--native-read');
const configOverrides = [`default_permissions=${JSON.stringify(profile)}`, `permissions.${profile}.filesystem={":root"=${JSON.stringify(nativeRead ? 'read' : 'deny')},":minimal"="read",${JSON.stringify(cwd)}="read"}`, `permissions.${profile}.network.enabled=false`];
const report = { root, modelCalls: 0, paidImageCalls: 0, checks: {} }; let client;
try {
  client = await startCodexAppServer(config, { cwd, workbench: true, configOverrides, onNotification() {}, onExit() {}, onToolCall() { throw new Error('No active turn'); }, onRequest() { throw new Error('No active turn'); } });
  report.version = client.version; report.checks.authenticated = !!client.account.account || client.account.requiresOpenaiAuth === false;
  const result = await client.request('thread/start', { cwd, permissions: profile, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'untrusted', approvalsReviewer: 'user', model: client.defaultModel || null, ephemeral: false, dynamicTools: [] });
  report.policy = { activePermissionProfile: result.activePermissionProfile, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandbox: result.sandbox, model: result.model, runtimeWorkspaceRoots: result.runtimeWorkspaceRoots };
  report.checks.profileSelected = result.activePermissionProfile?.id === profile;
  report.checks.nativeApprovals = result.approvalPolicy === 'untrusted' && result.approvalsReviewer === 'user';
  report.threadId = result.thread.id;
  const catalog = await client.request('mcpServerStatus/list', { threadId: result.thread.id });
  report.catalog = catalog.data?.map(server => ({ name: server.name, runtimeStatus: server.runtimeStatus, tools: Object.keys(server.tools || {}).length }));
  const resolved = await client.request('config/read', { includeLayers: false, cwd });
  report.mcpConfig = Object.entries(resolved.config?.mcp_servers || {}).map(([name, server]) => ({ name, enabled: server.enabled }));
  report.checks.noExternalMcp = Array.isArray(catalog.data) && catalog.data.every(server => !Object.keys(server.tools || {}).length) && report.mcpConfig.every(server => server.enabled === false);
} catch (error) { report.error = error.message; }
finally { await client?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
