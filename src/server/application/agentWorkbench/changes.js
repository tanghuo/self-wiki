import { readFile, writeFile, rename, mkdir, lstat, unlink, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { textDiff, unifiedFiles } from '../../../shared/domain/agentWorkbench/fileDiff.js';
import { agentError, activeTurnStates } from '../../../shared/domain/agentWorkbench/contracts.js';
import { createFileGateway } from './files.js';
import { pathIdentity } from './workspaces.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const conflict = message => agentError('CHANGE_CONFLICT', message, 409);

export function collectTurnChanges(events, workspace) {
  const host = new Map(), native = new Map(); let aggregate, aggregateTruncated = false, baseline, observed;
  for (const event of events) {
    const value = event.data;
    if (event.type === 'workspace.baseline') baseline = value;
    if (event.type === 'workspace.changed') observed = value.current;
    if (event.type === 'engine.diff') { aggregate = value.diff; aggregateTruncated = value.truncated === true; }
    if (event.type === 'file.native_diff' && value.status === 'completed') for (const change of value.changes || []) {
      const parsed = typeof change.before === 'string' && typeof change.after === 'string' ? textDiff(change.before, change.after) : unifiedFiles(`diff --git a/file b/file\n${change.diff || ''}`)[0];
      const repeated = native.has(change.path);
      native.set(change.path, { ...parsed, path: change.path, source: value.namespace || 'codex', rawDiff: change.diff, added: !repeated && parsed?.rows.length ? parsed.added : null, removed: !repeated && parsed?.rows.length ? parsed.removed : null, rows: parsed?.rows || [], partial: repeated });
    }
    if (event.type !== 'file.changed' || value.source !== 'host') continue;
    const key = pathIdentity(value.path), previous = host.get(key);
    host.set(key, { ...value, before: previous?.before ?? value.before, beforeHash: previous ? previous.beforeHash : value.beforeHash, contiguous: (previous?.contiguous ?? true) && (!previous || previous.afterHash === value.beforeHash) });
  }
  if (aggregate !== undefined) { native.clear(); for (const file of unifiedFiles(aggregate)) native.set(file.path, aggregateTruncated ? { ...file, added: null, removed: null } : file); }
  const files = [];
  for (const value of host.values()) {
    if (value.beforeHash === value.afterHash) continue;
    const complete = value.contiguous && (value.beforeHash === null || hash(value.before) === value.beforeHash) && hash(value.after) === value.afterHash;
    files.push({ path: value.path, displayPath: path.relative(workspace.path, value.path).split(path.sep).join('/'), kind: value.beforeHash === null ? 'add' : 'modify', source: 'host', canUndo: complete, undoReason: complete ? '' : '修改记录不连续或原始字节不完整', before: value.before, after: value.after, beforeHash: value.beforeHash, afterHash: value.afterHash, ...textDiff(value.before, value.after) });
  }
  for (const value of native.values()) {
    if (host.has(pathIdentity(path.resolve(workspace.path, value.path)))) continue;
    files.push({ ...value, displayPath: value.path, source: value.source || 'codex', canUndo: false, undoReason: aggregateTruncated ? '原生差异被截断，仅供查看' : value.partial ? '缺少本轮聚合差异，以下仅显示最近一次修改' : '原生差异没有完整的修改前版本，仅供查看' });
  }
  const changed = observed?.git && JSON.stringify(observed) !== JSON.stringify(baseline);
  return { files, incomplete: aggregateTruncated, workspaceDiff: changed ? observed.diff : '', workspaceStatus: changed ? observed.status : [], workspaceNotice: '工作区检测结果可能包含原有修改、命令和外部编辑，不计入 Agent 文件统计，也不参与撤销。' };
}

export function createTurnChanges({ repo, dataDir }) {
  const directory = path.join(dataDir, 'agent-changes');
  const journalPath = id => path.join(directory, `${id}.json`);
  async function journal(id) { return readFile(journalPath(id), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); }
  async function save(id, value) {
    await mkdir(directory, { recursive: true });
    const temp = `${journalPath(id)}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(value), { flag: 'wx' }); await rename(temp, journalPath(id)); }
    finally { await rm(temp, { force: true }); }
  }
  function records(turn) {
    const events = []; let after = 0;
    for (;;) { const page = repo.events(turn.sessionId, after, 1000); if (!page.length) break; events.push(...page.filter(event => event.turnId === turn.id)); after = page.at(-1).seq; }
    return events;
  }
  function collect(id) {
    const turn = repo.turn(id), workspace = repo.workspace(repo.session(turn.sessionId).workspaceId), events = records(turn);
    const changes = collectTurnChanges(events, workspace);
    return { turn, workspace, changes, version: hash(JSON.stringify(events.filter(event => ['file.changed', 'file.native_diff', 'engine.diff'].includes(event.type)))) };
  }
  return {
    async get(id) {
      const { turn, changes, version } = collect(id), undo = await journal(id);
      return { ...changes, turnId: id, version, active: activeTurnStates.has(turn.state), undoState: undo?.state || 'ready', undonePaths: undo?.entries.filter(entry => entry.state === 'done').map(entry => entry.path) || [] };
    },
    async undo(id, version, signal) {
      const { turn, workspace, changes, version: currentVersion } = collect(id);
      if (activeTurnStates.has(turn.state)) throw conflict('请先停止此轮再撤销');
      if (turn.state === 'unknown') throw conflict('此轮执行结果尚未确认，请先核查仍在运行的命令');
      if (version !== currentVersion) throw conflict('变更记录已更新，请刷新后重试');
      let undo = await journal(id);
      if (undo?.version && undo.version !== version) throw conflict('撤销记录与当前变更不匹配');
      if (undo?.state === 'undone') return this.get(id);
      const selected = changes.files.filter(file => file.canUndo);
      if (!selected.length) throw conflict('没有具备完整版本的可撤销文件');
      const gateway = createFileGateway({ workspace });
      async function current(file) {
        await gateway.target(file.path, true);
        const info = await lstat(file.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (info && (!info.isFile() || info.size > 2 * 1024 * 1024)) throw conflict(`文件类型或大小已变化：${file.displayPath}`);
        const bytes = await readFile(file.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        return { hash: bytes === null ? null : hash(bytes), mode: info?.mode };
      }
      undo ||= { version, state: 'undoing', startedAt: Date.now(), entries: selected.map(file => ({ path: file.path, state: 'pending' })) };
      // Preflight the complete batch before its first mutation. An interrupted
      // applying entry can be recognized using its expected restored hash.
      for (const entry of undo.entries) {
        signal.throwIfAborted();
        const file = selected.find(file => file.path === entry.path);
        if (!file) throw conflict('撤销文件记录缺失');
        const actual = await current(file);
        if (entry.state === 'done' || entry.state === 'applying' && actual.hash === file.beforeHash) {
          if (actual.hash !== file.beforeHash) throw conflict(`已恢复文件又被修改：${file.displayPath}`);
          entry.state = 'done'; continue;
        }
        if (actual.hash !== file.afterHash) throw conflict(`文件已被后续修改，未覆盖：${file.displayPath}`);
      }
      await save(id, undo);
      for (const entry of undo.entries) {
        if (entry.state === 'done') continue;
        signal.throwIfAborted();
        const file = selected.find(file => file.path === entry.path);
        entry.state = 'applying'; await save(id, undo);
        const actual = await current(file);
        if (actual.hash !== file.afterHash) throw conflict(`文件已变化，撤销已暂停：${file.displayPath}`);
        signal.throwIfAborted();
        if (file.beforeHash === null) await unlink(file.path);
        else {
          const temp = path.join(path.dirname(file.path), `.self-wiki-undo-${randomUUID()}.tmp`);
          try {
            await writeFile(temp, file.before, { flag: 'wx', mode: actual.mode });
            if ((await current(file)).hash !== file.afterHash) throw conflict(`文件已变化，撤销已暂停：${file.displayPath}`);
            signal.throwIfAborted(); await rename(temp, file.path);
          } finally { await rm(temp, { force: true }); }
        }
        entry.state = 'done'; await save(id, undo);
      }
      undo.state = 'undone'; undo.finishedAt = Date.now(); await save(id, undo);
      return this.get(id);
    },
  };
}
