import { useEffect, useRef, useState } from 'react';
import { request } from '../../api.js';

// Each session owns its queue. A slow save for A cannot replace B's editor.
export default function useWorkbenchDraft(sessionId, onError) {
  const entries = useRef(new Map()), timers = useRef(new Map()), current = useRef(sessionId);
  current.current = sessionId;
  const [, render] = useState(0);
  const notify = () => render(value => value + 1);
  function hydrate(id, saved) {
    if (!entries.current.has(id)) { entries.current.set(id, { ...saved, edit: 0, saved: 0, queue: Promise.resolve() }); notify(); }
  }
  async function flush(id = current.current) {
    clearTimeout(timers.current.get(id));
    const entry = entries.current.get(id);
    if (!entry) throw new Error('草稿尚未加载');
    const operation = entry.queue.catch(() => {}).then(async () => {
      if (entry.saved === entry.edit && entry.requestKey) return { ...entry };
      const edit = entry.edit, text = entry.text, attachments = [...entry.attachments];
      const saved = await request(`/api/agent/sessions/${id}/draft`, { method: 'PUT', body: JSON.stringify({ revision: entry.revision, text, attachments }) });
      entry.revision = saved.revision; entry.requestKey = saved.requestKey; entry.saved = edit;
      if (current.current === id) notify();
      return { ...saved };
    });
    entry.queue = operation; return operation;
  }
  function update(change) {
    const id = current.current, entry = entries.current.get(id); if (!entry) return;
    Object.assign(entry, change); entry.edit++; notify();
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => { flush(id).catch(error => onError(error.message)); }, 500));
  }
  function submitted(id, saved) {
    const entry = entries.current.get(id);
    if (entry) { Object.assign(entry, saved); entry.saved = entry.edit; if (current.current === id) notify(); }
  }
  useEffect(() => {
    const guard = event => { if ([...entries.current.values()].some(entry => entry.saved !== entry.edit)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('beforeunload', guard); for (const [id, entry] of entries.current) { clearTimeout(timers.current.get(id)); if (entry.saved !== entry.edit) void flush(id).catch(() => {}); } };
  }, []);
  return { value: entries.current.get(sessionId), hydrate, update, flush, submitted };
}
