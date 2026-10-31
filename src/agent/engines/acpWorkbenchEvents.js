import { toolStatus } from '../../shared/domain/agentWorkbench/events.js';

// ACP has no agent-message ID/phase. Keep contiguous text as one message and
// start a new segment after tool/plan activity, without inventing a final phase.
export function createAcpWorkbenchEvents(onEvent) {
  let message = 0, speaking = false;
  return value => {
    if (value.sessionUpdate === 'agent_message_chunk' && value.content?.type === 'text') {
      if (!speaking) message++;
      speaking = true;
      return onEvent('message.delta', { text: value.content.text, messageId: `acp-message-${message}` });
    }
    if (value.sessionUpdate === 'plan') {
      speaking = false;
      return onEvent('plan.updated', { entries: value.entries });
    }
    if (['tool_call', 'tool_call_update'].includes(value.sessionUpdate)) {
      speaking = false;
      return onEvent('tool.updated', { id: value.toolCallId, title: value.title, status: toolStatus(value.status ?? (value.sessionUpdate === 'tool_call' ? 'pending' : undefined)), kind: value.kind, content: value.content });
    }
  };
}
