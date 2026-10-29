import { randomUUID } from 'node:crypto';
import { agentHash } from './agentWorkbenchRepository.js';
import { agentError, taskStates, approvalStates } from '../../shared/domain/agentWorkbench/contracts.js';

const parse = value => JSON.parse(value || '{}');
const conflict = message => agentError('STATE_CONFLICT', message, 409);
export function createAgentTaskRepository(db) {
  function atomic(fn) { if (db.isTransaction) return fn(); db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function row(table, id) {
    if (!['agent_turns', 'agent_tasks', 'agent_task_attempts', 'agent_operations'].includes(table)) throw new Error('Invalid task table');
    const result = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!result) throw agentError('NOT_FOUND', '任务记录不存在', 404); return result;
  }
  function event(sessionId, turnId, type, data) {
    const t = row('agent_turns', turnId);
    if (t.session_id !== sessionId) throw agentError('OWNER_MISMATCH', '任务所属会话不匹配', 403);
    const { seq } = db.prepare('UPDATE agent_sessions SET seq=seq+1 WHERE id=? RETURNING seq').get(sessionId);
    db.prepare('INSERT INTO agent_events(session_id,seq,turn_id,generation,type,data,created_at) VALUES(?,?,?,?,?,?,?)').run(sessionId, seq, turnId, t.generation, type, JSON.stringify(data), Date.now());
  }
  const task = id => { const t = row('agent_tasks', id); return { id: t.id, sessionId: t.owner_session_id, turnId: t.origin_turn_id, operationId: t.operation_id, kind: t.kind, inputHash: t.input_hash, executor: parse(t.executor), state: taskStates[t.state], attemptId: t.attempt_id, cancelRequested: !!t.cancel_requested, revision: t.revision, data: parse(t.data) }; };
  const operation = id => {
    const r = db.prepare('SELECT * FROM agent_operations WHERE public_id=?').get(id);
    if (!r) throw agentError('NOT_FOUND', '付费操作不存在', 404);
    return { id: r.public_id, internalId: r.id, sessionId: r.owner_session_id, turnId: r.origin_turn_id, kind: r.kind, hash: r.input_hash, input: parse(r.input), executor: parse(r.executor), state: approvalStates[r.state], taskId: r.task_id, expiresAt: r.expires_at };
  };
  const artifact = (id, sessionId) => {
    const a = db.prepare('SELECT a.* FROM agent_artifacts a JOIN agent_artifact_refs r ON a.id=r.artifact_id WHERE a.id=? AND r.session_id=?').get(id, sessionId);
    if (!a) throw agentError('ARTIFACT_DENIED', '产物不存在或未授权给此会话', 404);
    return { id: a.id, type: a.type, storageKey: a.storage_key, hash: a.hash, byteSize: a.byte_size, mimeType: a.mime_type, producer: a.producer, taskId: a.task_id, turnId: a.turn_id, metadata: parse(a.metadata) };
  };
  function notify(id) { const t = task(id); event(t.sessionId, t.turnId, 'task.updated', t); return t; }
  return {
    task, operation, artifact,
    workflowChain(runId) { const row = db.prepare('SELECT chain FROM agent_workflow_runs WHERE run_id=?').get(runId); return row ? parse(row.chain) : null; },
    activeWorkflowRuns() { return !!db.prepare('SELECT 1 FROM agent_workflow_runs b JOIN workflow_runs r ON r.id=b.run_id WHERE r.state IN(0,1,2,3) LIMIT 1').get(); },
    workflowBinding(id, attemptId) { const row = db.prepare('SELECT * FROM agent_workflow_runs WHERE task_id=? AND attempt_id=?').get(id, attemptId); return row ? { runId: row.run_id, workflowId: row.workflow_id, chain: parse(row.chain) } : null; },
    bindWorkflow(id, attemptId, run, chain) {
      return atomic(() => {
        const t = task(id);
        if (t.attemptId !== attemptId || !['running', 'unknown'].includes(t.state)) throw conflict('工作流任务尝试已失效');
        const previous = this.workflowBinding(id, attemptId);
        if (previous) { if (previous.runId !== run.id) throw conflict('同一尝试不能绑定不同运行'); return t; }
        const bound = { ...chain, parentTaskId: t.id };
        db.prepare('INSERT INTO agent_workflow_runs VALUES(?,?,?,?,?,?)').run(attemptId, id, run.workflowId, run.id, chain.parentTaskId ?? null, JSON.stringify(bound));
        db.prepare('UPDATE agent_tasks SET data=?,revision=revision+1 WHERE id=?').run(JSON.stringify({ ...t.data, workflowRunId: run.id, workflowId: run.workflowId, workflowState: run.state }), id);
        return notify(id);
      });
    },
    wikiReceipt(id) { const row = db.prepare("SELECT result FROM agent_commands WHERE scope='artifact.wiki' AND request_key=?").get(String(id)); return row ? parse(row.result) : null; },
    saveWikiReceipt(id, elementId) { db.prepare("INSERT OR IGNORE INTO agent_commands(scope,request_key,hash,result) VALUES('artifact.wiki',?,'',?)").run(String(id), JSON.stringify({ elementId })); return this.wikiReceipt(id); },
    findOperation(id) { return db.prepare('SELECT 1 FROM agent_operations WHERE public_id=?').get(id) ? operation(id) : null; },
    storageKeys: () => new Set(db.prepare('SELECT storage_key FROM agent_artifacts').all().map(row => row.storage_key)),
    artifacts: sessionId => db.prepare('SELECT artifact_id FROM agent_artifact_refs WHERE session_id=? ORDER BY artifact_id DESC LIMIT 200').all(sessionId).map(row => artifact(row.artifact_id, sessionId)),
    publishArtifact(sessionId, a) {
      return atomic(() => {
        if (!db.prepare('SELECT 1 FROM agent_sessions WHERE id=?').get(sessionId)) throw agentError('NOT_FOUND', '会话不存在', 404);
        const result = db.prepare('INSERT INTO agent_artifacts(type,storage_key,hash,byte_size,mime_type,producer,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)').run(a.type, a.storageKey, a.hash, a.byteSize, a.mimeType, 'user-upload', JSON.stringify(a.metadata || {}), Date.now());
        const id = Number(result.lastInsertRowid); db.prepare('INSERT INTO agent_artifact_refs VALUES(?,?,NULL)').run(id, sessionId);
        return artifact(id, sessionId);
      });
    },
    expire() {
      const expired = db.prepare('SELECT public_id FROM agent_operations WHERE state=0 AND expires_at<=? LIMIT 100').all(Date.now());
      for (const item of expired) atomic(() => {
        const op = operation(item.public_id);
        if (db.prepare('UPDATE agent_operations SET state=3 WHERE id=? AND state=0').run(op.internalId).changes) event(op.sessionId, op.turnId, 'operation.updated', operation(op.id));
      });
    },
    taskOperation(id) { const t = task(id), op = row('agent_operations', t.operationId); return operation(op.public_id); },
    list: sessionId => db.prepare('SELECT id FROM agent_tasks WHERE owner_session_id=? ORDER BY id DESC LIMIT 100').all(sessionId).map(t => task(t.id)),
    operations: sessionId => db.prepare('SELECT public_id FROM agent_operations WHERE owner_session_id=? ORDER BY id DESC LIMIT 100').all(sessionId).map(r => operation(r.public_id)),
    submit({ operationId = randomUUID(), sessionId, turnId, kind, input, executor }) {
      return atomic(() => {
        const t = row('agent_turns', turnId), inputHash = agentHash({ kind, input, executor });
        if (t.session_id !== sessionId) throw agentError('OWNER_MISMATCH', '操作不属于此会话', 403);
        const previous = db.prepare('SELECT public_id,input_hash,owner_session_id FROM agent_operations WHERE public_id=?').get(operationId);
        if (previous) { if (previous.input_hash !== inputHash || previous.owner_session_id !== sessionId) throw conflict('同一 operationId 对应不同操作'); return operation(operationId); }
        if ([3, 6].includes(t.state) && kind !== 'task.retry') throw conflict('已停止的轮次不能新增付费操作');
        db.prepare('INSERT INTO agent_operations(public_id,owner_session_id,origin_turn_id,kind,input_hash,input,executor,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(operationId, sessionId, turnId, kind, inputHash, JSON.stringify(input), JSON.stringify(executor), Date.now() + 600000, Date.now());
        const result = operation(operationId); event(sessionId, turnId, 'operation.updated', result); return result;
      });
    },
    decide(id, value) {
      return atomic(() => {
        const op = operation(id), key = `${op.sessionId}:operation:${id}`, hash = agentHash({ decision: value.decision, hash: value.hash });
        const previous = db.prepare('SELECT hash,result FROM agent_commands WHERE scope=? AND request_key=?').get(key, value.requestKey);
        if (previous) { if (previous.hash !== hash) throw conflict('控制请求标识对应不同决定'); return parse(previous.result); }
        if (value.hash !== op.hash || !['allow', 'reject'].includes(value.decision)) throw conflict('批准内容与操作快照不匹配');
        if (op.state !== 'pending') {
          if ((op.state === 'approved') !== (value.decision === 'allow') || op.state === 'expired') throw conflict('操作已处理或已过期');
          return op;
        }
        const expired = op.expiresAt <= Date.now(), state = expired ? 3 : value.decision === 'allow' ? 1 : 2;
        const changed = db.prepare('UPDATE agent_operations SET state=? WHERE id=? AND state=0').run(state, op.internalId); if (changed.changes !== 1) throw conflict('操作已被处理');
        if (state === 1) {
          let taskId;
          if (op.kind === 'task.retry') {
            const target = task(op.input.taskId);
            if (target.sessionId !== op.sessionId || target.revision !== op.input.revision || !['unknown', 'failed', 'cancelled'].includes(target.state)) throw conflict('任务已变化，不能批准此重试');
            taskId = target.id;
            db.prepare('UPDATE agent_tasks SET state=0,attempt_id=NULL,cancel_requested=0,revision=revision+1,data=? WHERE id=?').run(JSON.stringify({ previous: target.data }), taskId);
          } else {
            const result = db.prepare('INSERT INTO agent_tasks(owner_session_id,origin_turn_id,operation_id,kind,input_hash,executor,created_at) VALUES(?,?,?,?,?,?,?)').run(op.sessionId, op.turnId, op.internalId, op.kind, op.hash, JSON.stringify(op.executor), Date.now());
            taskId = Number(result.lastInsertRowid);
          }
          db.prepare('UPDATE agent_operations SET task_id=? WHERE id=?').run(taskId, op.internalId);
          notify(taskId);
        }
        const result = operation(id);
        db.prepare('INSERT INTO agent_commands VALUES(?,?,?,?)').run(key, value.requestKey, hash, JSON.stringify(result));
        event(op.sessionId, op.turnId, 'operation.updated', result); return result;
      });
    },
    start(id) {
      return atomic(() => {
        const t = task(id); if (t.state !== 'queued' || t.cancelRequested || t.attemptId !== null) throw conflict('任务无法开始或已有尝试等待资源');
        const next = db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM agent_task_attempts WHERE task_id=?').get(id).n;
        const result = db.prepare('INSERT INTO agent_task_attempts(task_id,number,created_at) VALUES(?,?,?)').run(id, next, Date.now());
        db.prepare('UPDATE agent_tasks SET attempt_id=?,revision=revision+1 WHERE id=?').run(Number(result.lastInsertRowid), id); return notify(id);
      });
    },
    dispatch(id, attemptId) {
      return atomic(() => {
        const t = task(id); if (t.attemptId !== attemptId || t.state !== 'queued' || t.cancelRequested) throw conflict('任务已取消或代际已变化');
        db.prepare('UPDATE agent_task_attempts SET dispatch=1,state=2 WHERE id=?').run(attemptId);
        db.prepare('UPDATE agent_tasks SET state=2,revision=revision+1 WHERE id=?').run(id); return notify(id);
      });
    },
    progress(id, attemptId, data) {
      return atomic(() => {
        const t = task(id); if (t.attemptId !== attemptId || !['queued', 'running'].includes(t.state)) return t;
        db.prepare('UPDATE agent_tasks SET data=?,revision=revision+1 WHERE id=?').run(JSON.stringify({ ...t.data, ...data, ...(data.metadata && { metadata: { ...t.data.metadata, ...data.metadata } }) }), id);
        if (data.remoteId) db.prepare('UPDATE agent_task_attempts SET remote_id=? WHERE id=?').run(data.remoteId, attemptId);
        return notify(id);
      });
    },
    finish(id, attemptId, state, data = {}, artifacts = []) {
      return atomic(() => {
        const t = task(id); if (t.attemptId !== attemptId) throw conflict('任务尝试已变化');
        if (!['queued', 'running', 'unknown'].includes(t.state)) return t;
        if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(state) || state === 'succeeded' && !artifacts.length) throw new Error('Invalid task result');
        const refs = [];
        for (const a of artifacts) {
          const result = db.prepare('INSERT INTO agent_artifacts(type,storage_key,hash,byte_size,mime_type,producer,task_id,turn_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(a.type, a.storageKey, a.hash, a.byteSize, a.mimeType, a.producer, id, t.turnId, JSON.stringify(a.metadata || {}), Date.now());
          const artifactId = Number(result.lastInsertRowid); db.prepare('INSERT INTO agent_artifact_refs VALUES(?,?,?)').run(artifactId, t.sessionId, id); refs.push(artifactId);
          event(t.sessionId, t.turnId, 'artifact.created', artifact(artifactId, t.sessionId));
        }
        const resultData = { ...t.data, ...data, ...(refs.length && { artifactIds: refs }), ...(t.cancelRequested && state === 'succeeded' && { completedAfterCancel: true }) };
        db.prepare('UPDATE agent_tasks SET state=?,data=?,revision=revision+1 WHERE id=?').run(taskStates.indexOf(state), JSON.stringify(resultData), id);
        db.prepare('UPDATE agent_task_attempts SET state=?,data=? WHERE id=?').run(taskStates.indexOf(state), JSON.stringify(resultData), attemptId); return notify(id);
      });
    },
    cancel(id, revision) {
      return atomic(() => {
        const t = task(id); if (t.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(t.state)) return t;
        if (t.revision !== revision) throw conflict('任务状态已变化，请刷新');
        const dispatch = t.attemptId && row('agent_task_attempts', t.attemptId).dispatch;
        db.prepare('UPDATE agent_tasks SET cancel_requested=1,state=?,revision=revision+1 WHERE id=?').run(dispatch ? 6 : 5, id); return notify(id);
      });
    },
    expireTurn(turnId) { return atomic(() => {
      const pending = db.prepare('SELECT public_id FROM agent_operations WHERE origin_turn_id=? AND state=0').all(turnId);
      db.prepare('UPDATE agent_operations SET state=3 WHERE origin_turn_id=? AND state=0').run(turnId);
      for (const p of pending) { const op = operation(p.public_id); event(op.sessionId, op.turnId, 'operation.updated', op); }
    }); },
    queued: () => db.prepare('SELECT id FROM agent_tasks WHERE state=0 AND cancel_requested=0 ORDER BY id').all().map(t => task(t.id)),
    recover() {
      atomic(() => {
        db.prepare('UPDATE agent_operations SET state=3 WHERE state=0').run();
        const candidates = db.prepare('SELECT t.id,a.dispatch FROM agent_tasks t LEFT JOIN agent_task_attempts a ON a.id=t.attempt_id WHERE t.state IN(0,1,2)').all();
        for (const t of candidates) {
          db.prepare('UPDATE agent_tasks SET state=?,attempt_id=CASE WHEN ? THEN attempt_id ELSE NULL END,revision=revision+1 WHERE id=?').run(t.dispatch ? 6 : 0, t.dispatch ? 1 : 0, t.id);
          notify(t.id);
        }
      });
    },
  };
}
