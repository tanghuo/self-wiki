import { elementQuery } from '../../../shared/domain/elements.js';
import { chatProposal } from '../../../shared/domain/chat.js';
import { agentError, requestKey } from '../../../shared/domain/agentWorkbench/contracts.js';

const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const string = { type: 'string' }, integer = { type: 'integer', minimum: 1 }, ids = { type: 'array', maxItems: 8, items: integer };
export const agentToolCatalog = [
  { name: 'wiki_search', description: '只读检索 Wiki。结果含引用；修改只能提出建议，不能直接采纳。', inputSchema: schema({ query: string, page: integer }, ['query']) },
  { name: 'wiki_read', description: '读取一份 Wiki 内容及版本。建议所引用的内容必须先读。', inputSchema: schema({ elementId: integer }, ['elementId']) },
  { name: 'wiki_propose', description: '提出 create_text/add_tags/add_relation 建议。返回待采纳卡；不会修改 Wiki。不得携带旧聊天 excerpts。', inputSchema: schema({ requestKey: string, proposal: { type: 'object' } }, ['requestKey', 'proposal']) },
  { name: 'image_submit', description: '申请独立生图或改图操作，返回待用户批准的 operationId，尚未派发。复用 operationId 不重复生图。任务使用 Grok Build；不要同步等待同引擎排队任务，应结束本轮释放资源。', inputSchema: schema({ operationId: string, prompt: string, referenceArtifactIds: ids, aspectRatio: string }, ['prompt']) },
  { name: 'task_status', description: '读取本会话任务。相同状态最多查询三次；资源等待时结束本轮，不重新提交。', inputSchema: schema({ taskId: integer }, ['taskId']) },
  { name: 'task_cancel', description: '取消本会话任务。派发后无法证明取消时为 unknown，不会自动重新生成。', inputSchema: schema({ taskId: integer, revision: integer, requestKey: string }, ['taskId', 'revision', 'requestKey']) },
  { name: 'artifact_read', description: '读取本会话有引用权限的产物。图片按受控内容返回，不能传入服务器路径。', inputSchema: schema({ artifactId: integer }, ['artifactId']) },
  { name: 'workflow_list', description: '列出可用工作流。提交前须读取定义。', inputSchema: schema({}) },
  { name: 'workflow_read', description: '读取工作流定义、版本和输入要求。', inputSchema: schema({ workflowId: integer }, ['workflowId']) },
  { name: 'workflow_submit', description: '冻结已读取的工作流版本和输入，申请独立任务；须用户批准才执行。不要同步等待同引擎任务，应结束本轮释放资源。图片输入可用 {agentArtifactId: 已授权产物编号}。', inputSchema: schema({ operationId: string, workflowId: integer, revision: integer, inputs: { type: 'object' } }, ['workflowId', 'revision', 'inputs']) },
];
function validate(schema, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 64000) throw agentError('INVALID_TOOL_INPUT', '工具参数无效或过大');
  if (Object.keys(value).some(key => !(key in schema.properties)) || schema.required.some(key => !(key in value))) throw agentError('INVALID_TOOL_INPUT', '工具参数缺失或包含未声明字段');
  for (const [key, input] of Object.entries(value)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof input !== 'string' || input.length > 12000) || rule.type === 'integer' && (!Number.isSafeInteger(input) || input < 1) || rule.type === 'array' && (!Array.isArray(input) || input.length > rule.maxItems || input.some(id => !Number.isSafeInteger(id) || id < 1)) || rule.type === 'object' && (!input || typeof input !== 'object' || Array.isArray(input))) throw agentError('INVALID_TOOL_INPUT', `无效参数：${key}`);
  }
}
export function createAgentTools({ wiki, repo, tasks }) {
  return {
    catalog: agentToolCatalog,
    forTurn({ sessionId, turnId, assertLive, onResourceWait, allowedTools }) {
      const read = new Map(), workflows = new Map(), polls = new Map();
      return async ({ name, input }) => {
        assertLive(); const tool = agentToolCatalog.find(tool => tool.name === name);
        if (!tool || allowedTools && !allowedTools.includes(name)) throw agentError('TOOL_DENIED', '未声明的应用工具', 403);
        validate(tool.inputSchema, input);
        if (name === 'wiki_search') {
          const query = new URLSearchParams({ q: input.query.slice(0, 200), page: String(input.page || 1), pageSize: '20' });
          const result = wiki.list(elementQuery(query));
          return { ...result, elements: result.elements.map(element => ({ id: element.id, kind: element.kind, excerpt: element.body.slice(0, 1000), reference: `wiki:${element.id}` })) };
        }
        if (name === 'wiki_read') { const snapshot = repo.snapshot(input.elementId); read.set(snapshot.id, snapshot); return { ...snapshot, version: snapshot.fingerprint, reference: `wiki:${snapshot.id}` }; }
        if (name === 'wiki_propose') {
          requestKey(input.requestKey);
          if (input.proposal.excerpts !== undefined) throw agentError('INVALID_PROPOSAL', '新工作台建议不接受旧聊天轮次引用');
          const payload = chatProposal(input.proposal);
          const required = [...new Set([...payload.sourceIds, ...[payload.elementId, payload.sourceId, payload.targetId].filter(Boolean)])];
          const snapshots = required.map(id => { const snapshot = read.get(id); if (!snapshot) throw agentError('READ_REQUIRED', `请先读取 wiki:${id}`); return snapshot; });
          return repo.propose(sessionId, turnId, input.requestKey, payload, snapshots);
        }
        if (name === 'image_submit') return tasks.submit(sessionId, turnId, input);
        if (name === 'workflow_list') return tasks.workflowList();
        if (name === 'workflow_read') { const value = tasks.workflowRead(input.workflowId); workflows.set(value.id, value.revision); return value; }
        if (name === 'workflow_submit') {
          if (workflows.get(input.workflowId) !== input.revision) throw agentError('READ_REQUIRED', '请先读取所提交版本的工作流');
          const result = await tasks.submitWorkflow(sessionId, turnId, input, assertLive); assertLive(); return result;
        }
        if (name === 'task_cancel') return tasks.cancel(input.taskId, sessionId, input);
        if (name === 'task_status') {
          const task = tasks.get(input.taskId, sessionId), signature = `${task.state}:${task.revision}`, previous = polls.get(task.id);
          const count = previous?.signature === signature ? previous.count + 1 : 1; polls.set(task.id, { signature, count });
          if (count >= 3 && ['queued', 'running'].includes(task.state)) { onResourceWait(task); return { task, waitReason: 'resource_wait', message: '本轮结束后释放资源，独立任务将继续；不要重新提交' }; }
          return task;
        }
        if (name === 'artifact_read') {
          const artifact = tasks.artifact(input.artifactId, sessionId);
          const content = artifact.type === 'image' ? [await tasks.modelImage(input.artifactId, sessionId)] : [{ type: 'text', text: (await tasks.content(input.artifactId, sessionId)).bytes.toString('utf8').slice(0, 64000) }]; assertLive();
          return { artifact, content };
        }
      };
    },
    proposals: id => repo.list(Number(id)),
    decideProposal(id, sessionId, value) { requestKey(value.requestKey); return repo.decide(Number(id), Number(sessionId), value.decision); },
    draft: id => repo.draft(Number(id)),
    saveDraft(id, value) {
      if (typeof value.text !== 'string' || value.text.length > 120000 || !Array.isArray(value.attachments) || value.attachments.length > 8 || value.attachments.some(id => !Number.isSafeInteger(id) || id < 1)) throw agentError('INVALID_DRAFT', '草稿无效或过大');
      for (const artifactId of value.attachments) tasks.artifact(artifactId, Number(id));
      return repo.saveDraft(Number(id), value);
    },
  };
}
