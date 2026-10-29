import { agentError } from './contracts.js';

export const workflowAgentTools = Object.freeze(['wiki_search', 'wiki_read', 'wiki_propose', 'image_submit', 'task_status', 'task_cancel', 'artifact_read', 'workflow_list', 'workflow_read', 'workflow_submit']);
export function workflowCallChain(chain = {}, workflowId, parentTaskId = null) {
  const ancestors = chain.ancestorWorkflowIds || [], depth = chain.depth || 0;
  if (!Number.isSafeInteger(workflowId) || workflowId < 1 || !Array.isArray(ancestors) || ancestors.some(id => !Number.isSafeInteger(id) || id < 1) || !Number.isSafeInteger(depth) || depth < 0 || depth !== ancestors.length || depth >= 2 || ancestors.includes(workflowId)) throw agentError('WORKFLOW_RECURSION', '禁止重复工作流调用，且工作流调用深度最多为 2', 409);
  return { ancestorWorkflowIds: [...ancestors, workflowId], depth: depth + 1, parentTaskId };
}
