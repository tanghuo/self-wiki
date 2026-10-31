// Provider statuses are normalized at the event boundary; absent fields in partial
// updates must not erase information from the original tool call.
export function toolStatus(status) {
  return ({ pending: 'queued', in_progress: 'running', success: 'completed', succeeded: 'completed', error: 'failed' })[status] || status;
}

export function workbenchTimeline(events, turn) {
  const items = [], calls = new Map();
  let lastType;
  for (const event of events) {
    if (event.turnId !== turn.id) continue;
    const data = Object.fromEntries(Object.entries(event.data || {}).filter(([, value]) => value !== undefined));
    if (event.type === 'tool.updated') {
      if (data.status !== undefined) data.status = toolStatus(data.status);
      const previous = data.id && calls.get(data.id);
      if (previous) { Object.assign(previous.data, data); lastType = event.type; continue; }
      const item = { ...event, data };
      if (data.id) calls.set(data.id, item);
      items.push(item);
    } else if (event.type === 'message.delta') {
      const previous = items.at(-1);
      if (lastType === event.type && previous?.type === event.type && previous.data.messageId === data.messageId && previous.data.phase === data.phase) previous.data.text += data.text;
      else items.push({ ...event, data });
    } else if (event.type === 'plan.updated') {
      const previous = items.find(item => item.type === event.type);
      if (previous) previous.data = data;
      else items.push({ ...event, data });
    } else if (event.type === 'command.output' || event.type === 'turn.finished' && data.error) items.push({ ...event, data });
    else continue;
    lastType = event.type;
  }
  // A stopped turn cannot leave tools spinning forever. Completion of a turn
  // alone is not proof that a tool succeeded.
  for (const item of calls.values()) {
    if (['queued', 'running', 'awaiting_approval'].includes(item.data.status) && !['queued', 'running', 'awaiting_approval', 'cancelling'].includes(turn.state)) {
      item.data.status = turn.state === 'cancelled' ? 'cancelled' : 'unknown';
    }
  }
  for (const item of items) {
    if (item.type === 'command.output' && item.data.toolCallId && calls.has(item.data.toolCallId)) {
      calls.get(item.data.toolCallId).output = item;
      if (Number.isInteger(item.data.exitCode) && item.data.exitCode !== 0) calls.get(item.data.toolCallId).data.status = 'failed';
      item.attached = true;
    }
  }
  const groups = [];
  for (const item of items) {
    if (item.attached) continue;
    const activity = ['tool.updated', 'command.output', 'plan.updated'].includes(item.type), previous = groups.at(-1);
    if (activity && previous?.activity) previous.items.push(item);
    else groups.push({ key: item.seq, activity, items: [item] });
  }
  return groups;
}
