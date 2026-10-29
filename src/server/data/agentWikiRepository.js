import { createElementRepository } from './elementRepository.js';
import { createChatRepository } from './chatRepository.js';
import { agentError } from '../../shared/domain/agentWorkbench/contracts.js';
import { elementContent, elementTags } from '../../shared/domain/elements.js';
import { randomUUID } from 'node:crypto';

export function createAgentWikiRepository(db) {
  const wiki = createElementRepository(db), versions = createChatRepository(db);
  function atomic(fn) { if (db.isTransaction) return fn(); db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function proposal(id, sessionId) {
    const row = db.prepare('SELECT * FROM agent_wiki_proposals WHERE id=? AND session_id=?').get(id, sessionId);
    if (!row) throw agentError('PROPOSAL_DENIED', '建议不属于此会话', 404);
    return { id: row.id, sessionId: row.session_id, turnId: row.turn_id, state: ['pending', 'accepted', 'rejected'][row.state], payload: JSON.parse(row.payload), snapshots: JSON.parse(row.snapshots), result: JSON.parse(row.result) };
  }
  return {
    snapshot: versions.snapshot,
    list: sessionId => db.prepare('SELECT id FROM agent_wiki_proposals WHERE session_id=? ORDER BY id DESC LIMIT 100').all(sessionId).map(row => proposal(row.id, sessionId)),
    propose(sessionId, turnId, key, payload, snapshots) {
      return atomic(() => {
        const owner = db.prepare('SELECT session_id,state FROM agent_turns WHERE id=?').get(turnId);
        if (owner?.session_id !== sessionId || ![1, 2].includes(owner.state)) throw agentError('STALE_TURN', '建议轮次已结束', 409);
        const previous = db.prepare('SELECT id,payload FROM agent_wiki_proposals WHERE turn_id=? AND request_key=?').get(turnId, key);
        if (previous) { if (previous.payload !== JSON.stringify(payload)) throw agentError('REQUEST_CONFLICT', '同一请求对应不同建议', 409); return proposal(previous.id, sessionId); }
        versions.unchanged(snapshots);
        if (db.prepare('SELECT count(*) n FROM agent_wiki_proposals WHERE turn_id=?').get(turnId).n >= 20) throw agentError('PROPOSAL_LIMIT', '本轮建议已达上限');
        const result = db.prepare('INSERT INTO agent_wiki_proposals(session_id,turn_id,request_key,payload,snapshots,created_at) VALUES(?,?,?,?,?,?)').run(sessionId, turnId, key, JSON.stringify(payload), JSON.stringify(snapshots), Date.now());
        return proposal(Number(result.lastInsertRowid), sessionId);
      });
    },
    decide(id, sessionId, decision) {
      return atomic(() => {
        const value = proposal(id, sessionId), desired = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : null;
        if (!desired) throw agentError('INVALID_DECISION', '请选择采纳或拒绝');
        if (value.state !== 'pending') { if (value.state === desired) return value; throw agentError('STATE_CONFLICT', '建议已处理', 409); }
        let result = {};
        if (desired === 'accepted') {
          versions.unchanged(value.snapshots); const p = value.payload;
          if (p.kind === 'create_text') {
            const created = wiki.createText({ ...elementContent({ body: p.body, tags: p.tags }), creationSource: 'chat' }); result = { elementId: created.id };
            for (const sourceId of p.sourceIds) {
              const relation = wiki.relate(created.id, sourceId, 'related', '参考了', { direction: 'forward', reverseName: '被参考' });
              db.prepare('INSERT OR IGNORE INTO element_provenance(relation_id) VALUES(?)').run(relation.id);
            }
          } else if (p.kind === 'add_tags') {
            const element = wiki.get(p.elementId); wiki.update(element.id, { body: element.body, tags: elementTags([...element.tags, ...p.tags]) }); result = { elementId: element.id };
          } else if (p.kind === 'add_relation') result = { relationId: wiki.relate(p.sourceId, p.targetId, 'related', p.name, p).id };
          else throw agentError('INVALID_PROPOSAL', '不支持的建议类型');
        }
        const changed = db.prepare('UPDATE agent_wiki_proposals SET state=?,result=? WHERE id=? AND state=0').run(desired === 'accepted' ? 1 : 2, JSON.stringify(result), id);
        if (changed.changes !== 1) throw agentError('STATE_CONFLICT', '建议已处理', 409);
        return proposal(id, sessionId);
      });
    },
    draft(sessionId) {
      if (!db.prepare('SELECT 1 FROM agent_sessions WHERE id=?').get(sessionId)) throw agentError('NOT_FOUND', '会话不存在', 404);
      const row = db.prepare('SELECT * FROM agent_drafts WHERE session_id=?').get(sessionId);
      return row ? { revision: row.revision, text: row.text, attachments: JSON.parse(row.attachments), requestKey: row.request_key } : { revision: 0, text: '', attachments: [], requestKey: null };
    },
    saveDraft(sessionId, value) {
      return atomic(() => {
        const previous = this.draft(sessionId);
        if (previous.text === value.text && JSON.stringify(previous.attachments) === JSON.stringify(value.attachments) && previous.requestKey) return previous;
        if (previous.revision !== value.revision) {
          if (previous.text === value.text && JSON.stringify(previous.attachments) === JSON.stringify(value.attachments)) return previous;
          throw agentError('DRAFT_CONFLICT', '草稿已在另一窗口变化，请先保留本地内容再刷新', 409);
        }
        db.prepare('INSERT INTO agent_drafts(session_id,revision,text,attachments,request_key) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,text=excluded.text,attachments=excluded.attachments,request_key=excluded.request_key').run(sessionId, previous.revision + 1, value.text, JSON.stringify(value.attachments), randomUUID()); return this.draft(sessionId);
      });
    },
  };
}
