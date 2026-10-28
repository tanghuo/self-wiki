import { createHash, randomUUID } from 'node:crypto';
import { workflowError, externalNodeTypes } from '../../shared/domain/workflow/contracts.js';
import { createElementRepository } from './elementRepository.js';

const nodeStates = ['pending', 'running', 'waiting_review', 'succeeded', 'failed', 'unknown', 'blocked', 'cancelled'];
const runStates = ['queued', 'running', 'paused', 'waiting_review', 'needs_attention', 'succeeded', 'partial_failed', 'failed', 'cancelled'];
export const workflowDigest = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const parse = (v) => JSON.parse(v);
export function createWorkflowRepository(db) {
  const wiki = createElementRepository(db);
  let generation;
  function transaction(fn) {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function requireRow(row) { if (!row) throw workflowError('工作流记录不存在', 404); return row; }
  function workflow(id) {
    const r = requireRow(db.prepare('SELECT * FROM workflows WHERE id=?').get(id));
    return { id: r.id, name: r.name, definition: parse(r.draft), revision: r.revision, archivedAt: r.archived_at, updatedAt: r.updated_at };
  }
  function run(id) {
    const r = requireRow(db.prepare(`SELECT r.*,v.definition,v.workflow_id,v.version FROM workflow_runs r JOIN workflow_versions v ON v.id=r.version_id WHERE r.id=?`).get(id));
    return { id: r.id, workflowId: r.workflow_id, versionId: r.version_id, version: r.version, definition: parse(r.definition), inputs: parse(r.inputs), executors: parse(r.executor_snapshot), parentId: r.parent_id, state: runStates[r.state], controlVersion: r.control_version, paused: !!r.paused, cancelled: !!r.cancelled, createdAt: r.created_at };
  }
  function presentInstance(r) {
    return { id: r.id, runId: r.run_id, scope: r.scope, nodeId: r.node_id, itemId: r.item_id, context: parse(r.context), state: nodeStates[r.state], attemptId: r.attempt_id, outputs: parse(r.outputs), error: r.error, data: parse(r.data) };
  }
  function instance(id) { return presentInstance(requireRow(db.prepare('SELECT * FROM workflow_node_instances WHERE id=?').get(id))); }
  function instances(runId, { scope, after = 0, limit = 20000 } = {}) {
    return db.prepare(`SELECT * FROM workflow_node_instances WHERE run_id=? AND id>? ${scope === undefined ? '' : 'AND scope=?'} ORDER BY id LIMIT ?`).all(runId, after, ...(scope === undefined ? [] : [scope]), limit).map(presentInstance);
  }
  function event(runId, type, instanceId = null, attemptId = null, data = {}) {
    db.prepare('INSERT INTO workflow_events(run_id,type,instance_id,attempt_id,data,created_at) VALUES(?,?,?,?,?,?)').run(runId, type, instanceId, attemptId, JSON.stringify(data), Date.now());
  }
  function command(scope, key, payload, fn) {
    if (typeof key !== 'string' || !/^[\w:-]{8,160}$/.test(key)) throw workflowError('命令需要 8–160 字符的 requestKey');
    return transaction(() => {
      const hash = workflowDigest(payload), old = db.prepare('SELECT * FROM workflow_commands WHERE scope=? AND request_key=?').get(scope, key);
      if (old) { if (old.hash !== hash) throw workflowError('相同请求键的载荷不同', 409); return parse(old.result); }
      const result = fn();
      db.prepare('INSERT INTO workflow_commands VALUES(?,?,?,?)').run(scope, key, hash, JSON.stringify(result));
      return result;
    });
  }
  function priorCommand(scope, key, payload) {
    const old = db.prepare('SELECT * FROM workflow_commands WHERE scope=? AND request_key=?').get(scope, key);
    if (!old) return null;
    if (old.hash !== workflowDigest(payload)) throw workflowError('相同请求键的载荷不同', 409);
    return parse(old.result);
  }
  function addInstances(runId, graph, scope = 'root', context = {}, itemId = null) {
    const insert = db.prepare('INSERT INTO workflow_node_instances(run_id,scope,node_id,item_id,context) VALUES(?,?,?,?,?)');
    for (const n of graph.nodes) insert.run(runId, scope, n.id, itemId, JSON.stringify(context));
  }
  function artifact(id) {
    const r = requireRow(db.prepare('SELECT * FROM workflow_artifacts WHERE id=?').get(id));
    return { id: r.id, runId: r.run_id, instanceId: r.instance_id, attemptId: r.attempt_id, type: r.type, value: r.value === null ? undefined : parse(r.value), storageKey: r.storage_key, hash: r.hash, byteSize: r.byte_size, metadata: parse(r.metadata), createdAt: r.created_at };
  }
  function ref(runId, instanceId, artifactId, role, port = 'value') {
    db.prepare('INSERT OR IGNORE INTO workflow_artifact_refs VALUES(?,?,?,?,?)').run(runId, instanceId, artifactId, role, port);
  }
  function putArtifact(runId, instId, attemptId, a) {
    if (a.type === 'image' && a.value?.artifactId && !a.storageKey) {
      const source = artifact(a.value.artifactId);
      if (source.type !== 'image' || !source.storageKey || !db.prepare('SELECT 1 FROM workflow_artifact_refs WHERE run_id=? AND artifact_id=?').get(runId, source.id)) throw workflowError('图片别名不属于当前运行', 403);
      ref(runId, instId, source.id, 'output', a.port || 'value');
      return source.id;
    }
    const id = a.id || randomUUID();
    db.prepare('INSERT INTO workflow_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, runId, instId, attemptId, a.type, a.value === undefined ? null : JSON.stringify(a.value), a.storageKey || null, a.hash || workflowDigest(a.value), a.byteSize ?? Buffer.byteLength(JSON.stringify(a.value)), JSON.stringify(a.metadata || {}), Date.now());
    ref(runId, instId, id, instId ? 'output' : 'input');
    return id;
  }
  function owns() { return generation && db.prepare('SELECT generation FROM workflow_owner WHERE id=1').get()?.generation === generation; }
  function current(instId, attemptId) {
    const i = instance(instId);
    return owns() && i.attemptId === attemptId && i.state === 'running';
  }
  function complete(instId, attemptId, state, artifacts = [], error = '', data = {}) {
    return transaction(() => {
      const i = instance(instId), a = requireRow(db.prepare('SELECT * FROM workflow_node_attempts WHERE id=? AND instance_id=?').get(attemptId, instId));
      const active = current(instId, attemptId) && a.generation === generation;
      // Late results belong to their original attempt, including cancelled attempts.
      const outputs = {};
      for (const value of artifacts) outputs[value.port || 'value'] = putArtifact(i.runId, instId, attemptId, value);
      db.prepare('UPDATE workflow_node_attempts SET state=?,error=?,data=? WHERE id=?').run(nodeStates.indexOf(state), error, JSON.stringify({ ...parse(a.data), ...data, outputs }), attemptId);
      if (active) db.prepare('UPDATE workflow_node_instances SET state=?,outputs=?,error=?,data=? WHERE id=? AND attempt_id=? AND state=1').run(nodeStates.indexOf(state), JSON.stringify(outputs), error, JSON.stringify(data), instId, attemptId);
      event(i.runId, active ? 'node.completed' : 'attempt.late_result', instId, attemptId, { state, artifactIds: Object.values(outputs) });
      return active;
    });
  }
  return {
    transaction, workflow, run, instance, instances, artifact, command, priorCommand, event, owns,
    list() { return db.prepare(`SELECT w.*, (SELECT r.state FROM workflow_runs r JOIN workflow_versions v ON v.id=r.version_id WHERE v.workflow_id=w.id ORDER BY r.id DESC LIMIT 1) AS latest FROM workflows w ORDER BY updated_at DESC,id DESC`).all().map((r) => ({ id: r.id, name: r.name, revision: r.revision, archivedAt: r.archived_at, updatedAt: r.updated_at, latestState: runStates[r.latest] || null })); },
    create(name, definition) {
      const id = Number(db.prepare('INSERT INTO workflows(name,draft,updated_at) VALUES(?,?,?)').run(name, JSON.stringify(definition), Date.now()).lastInsertRowid);
      return workflow(id);
    },
    save(id, { name, definition, revision, archived }) {
      const changes = db.prepare('UPDATE workflows SET name=?,draft=?,revision=revision+1,archived_at=?,updated_at=? WHERE id=? AND revision=?').run(name, JSON.stringify(definition), archived ? Date.now() : null, Date.now(), id, revision).changes;
      if (!changes) throw workflowError('草稿已改变，请重新打开后保存', 409);
      return workflow(id);
    },
    createRun(workflowId, definition, inputs, executors, images = [], parentId = null) {
      return transaction(() => {
        const w = workflow(workflowId);
        if (w.archivedAt) throw workflowError('请先恢复已归档工作流', 409);
        const v = Number(db.prepare('INSERT INTO workflow_versions(workflow_id,version,definition,hash) SELECT ?,coalesce(max(version),0)+1,?,? FROM workflow_versions WHERE workflow_id=?').run(workflowId, JSON.stringify(definition), workflowDigest(definition), workflowId).lastInsertRowid);
        const id = Number(db.prepare('INSERT INTO workflow_runs(version_id,parent_id,inputs,executor_snapshot,created_at) VALUES(?,?,?,?,?)').run(v, parentId, JSON.stringify(inputs), JSON.stringify(executors), Date.now()).lastInsertRowid);
        for (const image of images) putArtifact(id, null, null, image);
        // Shared image inputs already owned by a parent remain protected by references.
        for (const imageId of collectImageIds(inputs)) { artifact(imageId); ref(id, null, imageId, 'input'); }
        addInstances(id, definition);
        event(id, 'run.created', null, null, { parentId });
        return run(id);
      });
    },
    history(workflowId, after = Number.MAX_SAFE_INTEGER) {
      return db.prepare('SELECT r.id FROM workflow_runs r JOIN workflow_versions v ON v.id=r.version_id WHERE v.workflow_id=? AND r.id<? ORDER BY r.id DESC LIMIT 50').all(workflowId, after).map((r) => { const { definition, inputs, executors, ...summary } = run(r.id); return summary; });
    },
    pendingRuns() { return db.prepare('SELECT id FROM workflow_runs WHERE state IN(0,1,2,3,4)').all().map((r) => run(r.id)); },
    claim(instId, request = {}) {
      return transaction(() => {
        if (!owns()) return null;
        const i = instance(instId), r = run(i.runId);
        if (i.state !== 'pending' || r.paused || r.cancelled) return null;
        const number = db.prepare('SELECT coalesce(max(number),0)+1 AS n FROM workflow_node_attempts WHERE instance_id=?').get(instId).n;
        const id = Number(db.prepare('INSERT INTO workflow_node_attempts(instance_id,number,generation,request,created_at) VALUES(?,?,?,?,?)').run(instId, number, generation, JSON.stringify(request), Date.now()).lastInsertRowid);
        if (!db.prepare('UPDATE workflow_node_instances SET state=1,attempt_id=?,error=\'\' WHERE id=? AND state=0').run(id, instId).changes) throw workflowError('节点已被抢占', 409);
        event(i.runId, 'node.started', instId, id);
        return { ...instance(instId), attemptId: id };
      });
    },
    dispatch(instId, attemptId, request) {
      return transaction(() => {
        if (!current(instId, attemptId) || run(instance(instId).runId).cancelled) throw workflowError('本次尝试已失效', 409);
        if (!db.prepare('UPDATE workflow_node_attempts SET dispatch_started=1,request=? WHERE id=? AND generation=?').run(JSON.stringify(request), attemptId, generation).changes) throw workflowError('执行代次已失效', 409);
      });
    },
    attemptMetadata(attemptId, metadata) {
      const row = db.prepare('SELECT * FROM workflow_node_attempts WHERE id=?').get(attemptId);
      if (!row || row.generation !== generation || !owns()) return;
      db.prepare('UPDATE workflow_node_attempts SET data=?,remote_id=? WHERE id=?').run(JSON.stringify({ ...parse(row.data), ...metadata }), metadata.comfyui?.promptId || metadata.remoteThreadId || metadata.promptId || metadata.grokBuild?.sessionId || row.remote_id, attemptId);
    },
    complete,
    recoverUnknown(instId, attemptId, artifacts) {
      return transaction(() => {
        const i = instance(instId);
        if (!owns() || i.state !== 'unknown' || i.attemptId !== attemptId || run(i.runId).cancelled) throw workflowError('原未知尝试已失效', 409);
        db.prepare('UPDATE workflow_node_instances SET state=1 WHERE id=? AND state=5 AND attempt_id=?').run(instId, attemptId);
        db.prepare('UPDATE workflow_node_attempts SET generation=? WHERE id=?').run(generation, attemptId);
        complete(instId, attemptId, 'succeeded', artifacts, '', { recovered: true });
        db.prepare('UPDATE workflow_node_instances SET state=0,error=\'\' WHERE run_id=? AND state=6').run(i.runId);
        if (i.context.parentInstanceId && instance(i.context.parentInstanceId).state !== 'running') this.setInstance(i.context.parentInstanceId, 'pending');
        event(i.runId, 'node.recovered', instId, attemptId, { actor: 'local' });
        return instance(instId);
      });
    },
    waiting(instId, attemptId, value) {
      return transaction(() => { if (!current(instId, attemptId)) return; complete(instId, attemptId, 'waiting_review', [value]); });
    },
    review(instId, decision, value) {
      return transaction(() => {
        const i = instance(instId), r = run(i.runId);
        if (r.cancelled || i.state !== 'waiting_review') throw workflowError('此检查已处理或运行已取消', 409);
        const previous = i.outputs.value;
        let out = previous;
        if (decision === 'accept' && value !== undefined) {
          const a = artifact(previous);
          out = putArtifact(i.runId, instId, i.attemptId, { type: a.type, value, metadata: { originalArtifactId: previous, decision: 'edited', actor: 'local' } });
        }
        db.prepare('UPDATE workflow_node_instances SET state=?,outputs=? WHERE id=? AND state=2').run(decision === 'accept' ? 3 : 7, JSON.stringify({ value: out }), instId);
        db.prepare('UPDATE workflow_node_attempts SET state=? WHERE id=?').run(decision === 'accept' ? 3 : 7, i.attemptId);
        event(i.runId, 'review.decided', instId, i.attemptId, { decision, previous, artifactId: out, actor: 'local' });
        return instance(instId);
      });
    },
    setInstance(instId, state, error = '', data) {
      const i = instance(instId);
      db.prepare('UPDATE workflow_node_instances SET state=?,error=?,data=? WHERE id=?').run(nodeStates.indexOf(state), error, JSON.stringify(data ?? i.data), instId);
      event(i.runId, 'node.state', instId, i.attemptId, { state });
    },
    setRunState(id, state) { db.prepare('UPDATE workflow_runs SET state=? WHERE id=? AND state<>?').run(runStates.indexOf(state), id, runStates.indexOf(state)); },
    control(id, action, version) {
      return transaction(() => {
        const r = run(id);
        if (!['pause', 'resume', 'cancel'].includes(action)) throw workflowError('未知运行动作');
        if (r.controlVersion !== version || r.cancelled || ['succeeded', 'failed', 'partial_failed'].includes(r.state)) throw workflowError('运行状态已改变，请刷新', 409);
        if (!db.prepare('UPDATE workflow_runs SET control_version=control_version+1,paused=?,cancelled=? WHERE id=? AND control_version=?').run(action === 'pause' ? 1 : 0, action === 'cancel' ? 1 : 0, id, version).changes) throw workflowError('运行已改变', 409);
        if (action === 'cancel') db.prepare('UPDATE workflow_node_instances SET state=7 WHERE run_id=? AND state IN(0,1,2,6)').run(id);
        event(id, `run.${action}`);
        return run(id);
      });
    },
    retry(instId, allowUnknown = false) {
      return transaction(() => {
        const i = instance(instId);
        if (!(i.state === 'failed' || allowUnknown && i.state === 'unknown') || run(i.runId).cancelled) throw workflowError('节点不能重试；未知结果需要明确重新执行', 409);
        db.prepare("UPDATE workflow_node_instances SET state=0,error='',data='{}' WHERE id=?").run(instId);
        // The scheduler decides whether blocked nodes are runnable after this retry.
        db.prepare('UPDATE workflow_node_instances SET state=0,error=\'\' WHERE run_id=? AND state=6').run(i.runId);
        db.prepare('UPDATE workflow_runs SET state=1 WHERE id=?').run(i.runId);
        event(i.runId, allowUnknown ? 'node.explicit_reexecute' : 'node.retry', instId, i.attemptId, { actor: 'local' });
        return instance(instId);
      });
    },
    initializeOwner() { generation = randomUUID(); db.prepare('INSERT INTO workflow_owner VALUES(1,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation').run(generation); },
    recover() {
      for (const r of this.pendingRuns()) {
        for (const i of instances(r.id).filter((i) => i.state === 'running')) {
          const graph = i.scope === 'root' ? r.definition : r.definition.nodes.find((n) => n.id === i.context.foreachId)?.config.body;
          const n = graph?.nodes.find((n) => n.id === i.nodeId);
          const a = db.prepare('SELECT * FROM workflow_node_attempts WHERE id=?').get(i.attemptId);
          transaction(() => {
            const state = externalNodeTypes.has(n?.type) && a?.dispatch_started ? 'unknown' : 'pending';
            db.prepare('UPDATE workflow_node_attempts SET state=?,error=? WHERE id=?').run(nodeStates.indexOf(state === 'pending' ? 'cancelled' : state), '后端重启中断', i.attemptId);
            this.setInstance(i.id, state, state === 'unknown' ? '请求已开始，远端结果未知。请核查后明确重新执行或放弃。' : '');
          });
        }
      }
    },
    expand(parent, graph, index, item, captures) {
      return transaction(() => {
        const scope = `root/${parent.nodeId}/${index}`, itemId = `${parent.runId}:${parent.nodeId}:${index}`;
        if (!db.prepare('SELECT 1 FROM workflow_node_instances WHERE run_id=? AND scope=?').get(parent.runId, scope)) addInstances(parent.runId, graph, scope, { foreachId: parent.nodeId, parentInstanceId: parent.id, index, itemId, item, captures }, itemId);
      });
    },
    reuse(targetId, source) {
      transaction(() => {
        const target = instance(targetId);
        for (const id of Object.values(source.outputs)) { artifact(id); ref(target.runId, target.id, id, 'reuse'); }
        db.prepare('UPDATE workflow_node_instances SET state=3,outputs=?,data=? WHERE id=? AND state=0').run(JSON.stringify(source.outputs), JSON.stringify({ reusedFrom: { runId: source.runId, instanceId: source.id } }), targetId);
        event(target.runId, 'node.reused', targetId, null, { sourceInstanceId: source.id });
      });
    },
    addRef: ref,
    inputArtifacts(runId) {
      return db.prepare("SELECT DISTINCT a.id,a.type,a.hash,a.metadata FROM workflow_artifacts a JOIN workflow_artifact_refs r ON r.artifact_id=a.id WHERE r.run_id=? AND r.role='input'").all(runId).map((a) => ({ id: a.id, type: a.type, hash: a.hash, metadata: parse(a.metadata) }));
    },
    bumpControl(runId, expected) {
      if (!db.prepare('UPDATE workflow_runs SET control_version=control_version+1 WHERE id=? AND control_version=? AND cancelled=0').run(runId, expected).changes) throw workflowError('运行控制版本已改变，请刷新', 409);
    },
    recordValue(i, value) {
      const old = db.prepare("SELECT a.id FROM workflow_artifacts a JOIN workflow_artifact_refs r ON r.artifact_id=a.id WHERE r.instance_id=? AND r.role='save_input' LIMIT 1").get(i.id);
      if (old) return old.id;
      return transaction(() => { const id = putArtifact(i.runId, i.id, i.attemptId, value); ref(i.runId, i.id, id, 'save_input'); return id; });
    },
    hasAccess(runId, artifactId) { return !!db.prepare('SELECT 1 FROM workflow_artifact_refs WHERE run_id=? AND artifact_id=?').get(runId, artifactId); },
    events(runId, after = 0) { run(runId); return db.prepare('SELECT * FROM workflow_events WHERE run_id=? AND id>? ORDER BY id LIMIT 200').all(runId, after).map((r) => ({ id: r.id, type: r.type, instanceId: r.instance_id, attemptId: r.attempt_id, data: parse(r.data), createdAt: r.created_at })); },
    attempts(instId) { return db.prepare('SELECT * FROM workflow_node_attempts WHERE instance_id=? ORDER BY number').all(instId).map((a) => ({ id: a.id, number: a.number, state: nodeStates[a.state], dispatchStarted: !!a.dispatch_started, request: parse(a.request), remoteId: a.remote_id, error: a.error, data: parse(a.data), createdAt: a.created_at })); },
    saveLibrary(instId, artifactId, { file, body, tags, source }) {
      return transaction(() => {
        const prior = db.prepare('SELECT element_id FROM workflow_save_receipts WHERE instance_id=? AND artifact_id=?').get(instId, artifactId);
        if (prior) { if (!prior.element_id) throw workflowError('已保存元素被删除，不会重复创建', 410); return wiki.get(prior.element_id).id; }
        const i = instance(instId);
        if (run(i.runId).cancelled || !owns() || i.state !== 'running') throw workflowError('运行已取消或执行权已失效', 409);
        const element = file ? wiki.importImage({ body: '', tags, creationSource: 'unknown' }, file).element : wiki.createText({ body, tags, creationSource: 'unknown' });
        db.prepare('INSERT INTO workflow_save_receipts VALUES(?,?,?,?)').run(instId, artifactId, element.id, JSON.stringify(source));
        return element.id;
      });
    },
    libraryFileUsed(key) { return !!db.prepare('SELECT 1 FROM element_images WHERE storage_key=?').get(key); },
  };
}
export function collectImageIds(value, found = new Set()) {
  if (value && typeof value === 'object') {
    if (typeof value.artifactId === 'string') found.add(value.artifactId);
    else for (const v of Object.values(value)) collectImageIds(v, found);
  }
  return found;
}
