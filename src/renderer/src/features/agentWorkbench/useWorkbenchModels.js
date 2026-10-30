import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../api.js';

export default function useWorkbenchModels(engines, enabled) {
  const [catalog, setCatalog] = useState({});
  const entries = useRef(new Map()), mounted = useRef(true);
  const publish = useCallback((engine, entry, value) => {
    if (mounted.current && entries.current.get(engine) === entry) setCatalog(previous => ({ ...previous, [engine]: value }));
  }, []);
  const load = useCallback((engine, retry = false, authenticate = false) => {
    if (!engine) return Promise.resolve(null);
    const previous = entries.current.get(engine);
    if (previous && (!retry || previous.loading)) return previous.promise || Promise.resolve(previous.value);
    const entry = { value: previous?.value, loading: true, authRequired: previous?.authRequired || false, controller: new AbortController() };
    entries.current.set(engine, entry);
    publish(engine, entry, { models: previous?.value?.models || [], loading: true, connecting: authenticate, authRequired: entry.authRequired, error: '' });
    entry.promise = request(`/api/agent/engines/${engine}/${authenticate ? 'connect' : 'models'}`, { signal: entry.controller.signal, ...(authenticate ? { method: 'POST', body: '{}' } : {}) }).then(value => {
      entry.value = value;
      entry.authRequired = false;
      publish(engine, entry, { ...value, loading: false, error: '' });
      return value;
    }).catch(error => {
      entry.authRequired = error.code === 'AUTH_REQUIRED' || (authenticate && entry.authRequired);
      if (!entry.controller.signal.aborted) publish(engine, entry, { models: previous?.value?.models || [], loading: false, authRequired: entry.authRequired, error: error.message });
      return null;
    }).finally(() => { entry.loading = false; });
    return entry.promise;
  }, [publish]);
  const connectAntigravity = useCallback(() => load('antigravity-acp', true, true), [load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const entry of entries.current.values()) entry.controller?.abort();
      entries.current.clear();
    };
  }, []);
  const engineIds = enabled ? (engines || []).map(engine => engine.id).join(',') : '';
  useEffect(() => {
    if (engineIds) for (const engine of engineIds.split(',')) void load(engine);
  }, [engineIds, load]);
  return { catalog, load, connectAntigravity };
}
