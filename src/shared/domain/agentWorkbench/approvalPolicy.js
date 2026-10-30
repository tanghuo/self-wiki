import { agentError } from './contracts.js';

export const approvalModes = Object.freeze([
  { id: 'ask', label: '手动审批' },
  { id: 'auto', label: '自动审批' },
  { id: 'allow', label: '全部允许' },
]);

export function approvalMode(value = 'ask', engine = 'grok-build') {
  if (!approvalModes.some(mode => mode.id === value)) throw agentError('INVALID_POLICY', '无效的审批模式');
  if (engine !== 'grok-build' && value !== 'ask') throw agentError('UNSUPPORTED_POLICY', '此引擎暂不支持该审批模式');
  return value;
}
