export const sessionStates = ['ready', 'running', 'needs_attention', 'archived'];
export const turnStates = ['queued', 'running', 'awaiting_approval', 'cancelling', 'completed', 'failed', 'cancelled', 'unknown'];
export const taskStates = ['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'];
export const approvalStates = ['pending', 'approved', 'rejected', 'expired'];
export const activeTurnStates = new Set(['queued', 'running', 'awaiting_approval', 'cancelling']);
export function agentError(code, message, statusCode = 400, stateKnown = true) {
  return Object.assign(new Error(message), { code, statusCode, stateKnown, retryable: false });
}
export function requestKey(value) {
  if (typeof value !== 'string' || !/^[\w-]{8,120}$/.test(value)) throw agentError('INVALID_REQUEST_KEY', '需要有效的请求标识');
  return value;
}
export function agentText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120000) throw agentError('INVALID_INPUT', '请输入任务，最多 120000 字符');
  return value;
}
