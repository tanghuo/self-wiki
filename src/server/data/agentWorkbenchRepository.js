import { createHash } from 'node:crypto';
import { sessionStates, turnStates, approvalStates, agentError } from '../../shared/domain/agentWorkbench/contracts.js';

export const agentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => JSON.parse(value || '{}');
const conflict = message => agentError('STATE_CONFLICT', message, 409);
export function createAgentWorkbenchRepository(db) {
  function atomic(fn) {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result?.then) throw new Error('Database transactions must be synchronous'); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function requireRow(table, id) {
    if (!['agent_sessions', 'agent_turns', 'agent_approvals', 'agent_workspaces'].includes(table)) throw new Error('Invalid repository table');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) throw agentError('NOT_FOUND', '工作台记录不存在', 404);
    return row;
  }
  const workspace = id => { const row = requireRow('agent_workspaces', id); return { id: row.id, kind: ['project', 'scratch'][row.kind], name: row.name || '', userPath: row.user_path, path: row.canonical_path, identity: row.identity, trustedAt: row.trusted_at }; };
  const session = id => {
    const row = requireRow('agent_sessions', id);
    return { id: row.id, workspaceId: row.workspace_id, engine: row.engine, purpose: ['interactive', 'workflow'][row.purpose], state: sessionStates[row.state], policy: parse(row.policy), capabilities: parse(row.capabilities), engineSessionId: row.engine_session_id, engineVersion: row.engine_version, generation: row.generation, revision: row.revision, seq: row.seq, data: parse(row.data), createdAt: row.created_at };
  };
  const turn = id => { const row = requireRow('agent_turns', id); return { id: row.id, sessionId: row.session_id, requestKey: row.request_key, inputHash: row.input_hash, input: parse(row.input), state: turnStates[row.state], delivery: row.delivery, generation: row.generation, data: parse(row.data), createdAt: row.created_at, finishedAt: row.finished_at }; };
  const approval = id => { const row = requireRow('agent_approvals', id); return { id: row.id, sessionId: row.session_id, turnId: row.turn_id, generation: row.generation, operationHash: row.operation_hash, policyRevision: row.policy_revision, state: approvalStates[row.state], operation: parse(row.operation), decision: row.decision, expiresAt: row.expires_at }; };
  function append(sessionId, turnId, generation, type, data) {
    const { seq } = db.prepare('UPDATE agent_sessions SET seq=seq+1 WHERE id=? RETURNING seq').get(sessionId);
    db.prepare('INSERT INTO agent_events(session_id,seq,turn_id,generation,type,data,created_at) VALUES(?,?,?,?,?,?,?)').run(sessionId, seq, turnId ?? null, generation, type, JSON.stringify(data), Date.now());
    return { sessionId, seq, turnId: turnId ?? null, generation, type, schemaVersion: 1, data };
  }
  function live(turnId, generation) {
    const t = turn(turnId), s = session(t.sessionId);
    if (t.generation !== generation || s.generation !== generation || !['running', 'awaiting_approval'].includes(t.state)) throw conflict('此轮已结束或执行代际已变化');
    return { t, s };
  }
  return {
    findConversion(key) { const row = db.prepare("SELECT result FROM agent_commands WHERE scope='legacy.convert' AND request_key=?").get(key); return row ? session(JSON.parse(row.result).sessionId) : null; },
    conversion(key, create) {
      return atomic(() => {
        const previous = db.prepare("SELECT result FROM agent_commands WHERE scope='legacy.convert' AND request_key=?").get(key);
        if (previous) return session(JSON.parse(previous.result).sessionId);
        const value = create();
        db.prepare("INSERT INTO agent_commands VALUES('legacy.convert',?,'',?)").run(key, JSON.stringify({ sessionId: value.id })); return value;
      });
    },
    workspace, session, turn, approval,
    createWorkspace(value) {
      const now = Date.now();
      const result = db.prepare('INSERT INTO agent_workspaces(kind,user_path,canonical_path,identity,name,trusted_at,created_at) VALUES(?,?,?,?,?,?,?)').run(value.kind === 'scratch' ? 1 : 0, value.userPath, value.path, value.identity, value.name || '', now, now);
      return workspace(Number(result.lastInsertRowid));
    },
    projectByIdentity(identity) { const row = db.prepare('SELECT id FROM agent_workspaces WHERE kind=0 AND identity=? ORDER BY id LIMIT 1').get(identity); return row ? workspace(row.id) : null; },
    listProjects() {
      return db.prepare(`SELECT w.id FROM agent_workspaces w LEFT JOIN agent_sessions s ON s.workspace_id=w.id AND s.purpose=0 WHERE w.kind=0 GROUP BY w.id ORDER BY COALESCE(MAX(s.created_at), w.created_at) DESC, w.id DESC`).all().map(row => workspace(row.id));
    },
    renameProject(id, name) { const current = workspace(id); if (current.kind !== 'project') throw agentError('INVALID_PROJECT', '只能命名项目'); db.prepare('UPDATE agent_workspaces SET name=? WHERE id=?').run(name, id); return workspace(id); },
    createSession(value) {
      return atomic(() => {
        workspace(value.workspaceId);
        const result = db.prepare('INSERT INTO agent_sessions(workspace_id,engine,purpose,policy,data,created_at) VALUES(?,?,?,?,?,?)').run(value.workspaceId, value.engine, value.purpose === 'workflow' ? 1 : 0, JSON.stringify(value.policy), JSON.stringify(value.data || {}), Date.now());
        const id = Number(result.lastInsertRowid); append(id, null, 0, 'session.created', { engine: value.engine }); return session(id);
      });
    },
    list: () => db.prepare('SELECT id FROM agent_sessions ORDER BY id DESC LIMIT 200').all().map(row => session(row.id)),
    updateSessionModel(id, model, effort) {
      return atomic(() => {
        const s = session(id);
        if (s.purpose === 'workflow') throw agentError('MODEL_LOCKED', '工作流会话的模型已冻结', 409);
        const data = { ...s.data, model, effort };
        db.prepare('UPDATE agent_sessions SET data=? WHERE id=?').run(JSON.stringify(data), id);
        append(id, null, s.generation, 'session.model_changed', { model, effort });
        return session(id);
      });
    },
    updatePolicy(id, revision, policy) {
      return atomic(() => {
        const s = session(id);
        if (s.revision !== revision) throw conflict('会话策略已变化，请刷新');
        db.prepare('UPDATE agent_sessions SET policy=?,revision=revision+1 WHERE id=?').run(JSON.stringify(policy), id);
        db.prepare('UPDATE agent_approvals SET state=3,decision=\'reject\' WHERE session_id=? AND state=0').run(id);
        append(id, null, s.generation, 'session.policy_changed', { revision: revision + 1 }); return session(id);
      });
    },
    detail(id) {
      const s = session(id);
      return { session: s, workspace: workspace(s.workspaceId), turns: db.prepare('SELECT id FROM agent_turns WHERE session_id=? ORDER BY id').all(id).map(row => turn(row.id)), approvals: db.prepare('SELECT id FROM agent_approvals WHERE session_id=? AND state=0 ORDER BY id').all(id).map(row => approval(row.id)) };
    },
    queueTurn(sessionId, key, input) {
      return atomic(() => {
        const s = session(sessionId), hash = agentHash(input);
        const previous = db.prepare('SELECT id,input_hash FROM agent_turns WHERE session_id=? AND request_key=?').get(sessionId, key);
        if (previous) { if (previous.input_hash !== hash) throw conflict('同一请求标识对应不同输入'); return { ...turn(previous.id), reused: true }; }
        if (s.state === 'archived' || db.prepare('SELECT 1 FROM agent_turns WHERE session_id=? AND state IN(0,1,2,3)').get(sessionId)) throw conflict('此会话已有运行轮次或已归档');
        const result = db.prepare('INSERT INTO agent_turns(session_id,request_key,input_hash,input,created_at) VALUES(?,?,?,?,?)').run(sessionId, key, hash, JSON.stringify(input), Date.now());
        const id = Number(result.lastInsertRowid);
        db.prepare("UPDATE agent_drafts SET text='',attachments='[]',request_key=NULL,revision=revision+1 WHERE session_id=? AND request_key=? AND text=? AND attachments=?").run(sessionId, key, input.text, JSON.stringify(input.artifactIds || []));
        db.prepare('UPDATE agent_sessions SET state=1,revision=revision+1 WHERE id=?').run(sessionId);
        append(sessionId, id, s.generation, 'turn.queued', { turnId: id }); return turn(id);
      });
    },
    startTurn(id) {
      return atomic(() => {
        const t = turn(id); if (t.state !== 'queued') throw conflict('轮次不在队列中');
        const s = session(t.sessionId), generation = s.generation + 1;
        db.prepare('UPDATE agent_sessions SET generation=?,state=1 WHERE id=?').run(generation, s.id);
        db.prepare('UPDATE agent_turns SET state=1,generation=? WHERE id=?').run(generation, id);
        append(s.id, id, generation, 'turn.started', {}); return turn(id);
      });
    },
    connected(turnId, generation, value) {
      return atomic(() => {
        const { s } = live(turnId, generation);
        db.prepare('UPDATE agent_sessions SET engine_session_id=?,engine_version=?,capabilities=? WHERE id=?').run(value.sessionId, value.version, JSON.stringify(value.capabilities), s.id);
        append(s.id, turnId, generation, 'engine.connected', value);
      });
    },
    resumed(id, value) {
      return atomic(() => {
        const s = session(id);
        if (db.prepare('SELECT 1 FROM agent_turns WHERE session_id=? AND state IN(0,1,2,3)').get(id)) throw conflict('会话正在执行');
        db.prepare('UPDATE agent_sessions SET engine_session_id=?,engine_version=?,capabilities=? WHERE id=?').run(value.sessionId, value.version, JSON.stringify(value.capabilities), id);
        append(id, null, s.generation, 'session.resumed', { version: value.version }); return session(id);
      });
    },
    delivery(id, generation, delivery) { live(id, generation); db.prepare('UPDATE agent_turns SET delivery=? WHERE id=?').run(delivery, id); },
    event(id, generation, type, data) { return atomic(() => { const { s } = live(id, generation); return append(s.id, id, generation, type, data); }); },
    events(id, after = 0, limit = 500) {
      session(id);
      return db.prepare('SELECT * FROM agent_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, Math.min(1000, Math.max(1, limit))).map(row => ({ sessionId: row.session_id, seq: row.seq, turnId: row.turn_id, generation: row.generation, type: row.type, schemaVersion: row.schema_version, data: parse(row.data) }));
    },
    // Zero means no deadline; explicit deadlines on older records still apply.
    requestApproval(id, generation, operation, expiresAt = 0) {
      return atomic(() => {
        const { s } = live(id, generation), hash = agentHash(operation);
        const result = db.prepare('INSERT INTO agent_approvals(session_id,turn_id,generation,operation_hash,policy_revision,operation,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(s.id, id, generation, hash, s.revision, JSON.stringify(operation), expiresAt, Date.now());
        const a = approval(Number(result.lastInsertRowid));
        db.prepare('UPDATE agent_turns SET state=2 WHERE id=?').run(id); append(s.id, id, generation, 'approval.requested', a); return a;
      });
    },
    decide(id, value) {
      return atomic(() => {
        const a = approval(id);
        if (!['allow', 'reject'].includes(value.decision) || value.operationHash !== a.operationHash || value.revision !== a.policyRevision) throw conflict('审批内容或策略版本不匹配');
        if (a.state !== 'pending') { if (a.decision === value.decision) return a; throw conflict('审批已处理或失效'); }
        const { s } = live(a.turnId, a.generation);
        if (s.revision !== a.policyRevision) throw conflict('审批策略已变化');
        const expired = a.expiresAt > 0 && a.expiresAt <= Date.now(), decision = expired ? 'reject' : value.decision;
        const changed = db.prepare('UPDATE agent_approvals SET state=?,decision=? WHERE id=? AND state=0').run(expired ? 3 : decision === 'allow' ? 1 : 2, decision, id);
        if (changed.changes !== 1) throw conflict('审批已被其他操作处理');
        const pending = db.prepare('SELECT 1 FROM agent_approvals WHERE turn_id=? AND state=0').get(a.turnId);
        db.prepare('UPDATE agent_turns SET state=? WHERE id=?').run(pending ? 2 : 1, a.turnId);
        const result = approval(id); append(a.sessionId, a.turnId, a.generation, 'approval.resolved', result); return result;
      });
    },
    finish(id, state, data = {}) {
      if (!['completed', 'failed', 'cancelled', 'unknown'].includes(state)) throw new Error('Invalid final turn state');
      return atomic(() => {
        const t = turn(id); if (!['queued', 'running', 'awaiting_approval', 'cancelling'].includes(t.state)) return t;
        db.prepare('UPDATE agent_approvals SET state=3,decision=\'reject\' WHERE turn_id=? AND state=0').run(id);
        db.prepare('UPDATE agent_turns SET state=?,data=?,finished_at=? WHERE id=?').run(turnStates.indexOf(state), JSON.stringify(data), Date.now(), id);
        db.prepare('UPDATE agent_sessions SET state=?,revision=revision+1 WHERE id=?').run(state === 'unknown' ? 2 : 0, t.sessionId);
        append(t.sessionId, id, t.generation, 'turn.finished', { state, ...data }); return turn(id);
      });
    },
    cancelling(id) {
      return atomic(() => {
        const t = turn(id); if (!['queued', 'running', 'awaiting_approval'].includes(t.state)) return t;
        db.prepare('UPDATE agent_turns SET state=3 WHERE id=?').run(id);
        db.prepare('UPDATE agent_approvals SET state=3,decision=\'reject\' WHERE turn_id=? AND state=0').run(id);
        append(t.sessionId, id, t.generation, 'turn.cancelling', {}); return turn(id);
      });
    },
    recover() {
      const pending = db.prepare('SELECT id FROM agent_turns WHERE state IN(0,1,2,3)').all();
      for (const row of pending) { const t = turn(row.id); this.finish(t.id, t.delivery === 'not_sent' ? 'cancelled' : 'unknown', { reason: '后端重启，未自动重发' }); }
    },
  };
}
