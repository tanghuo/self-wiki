import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "./api.js";

export default function useWikiResource(path, revision = 0, cacheSize = 0, delay = 0, initialData = null) {
  const key = `${path}:${revision}`;
  // Keep only this view's recent queries, and discard them after a content change.
  const cache = useMemo(() => new Map(), [revision, cacheSize]);
  const [state, setState] = useState(() => ({ key: initialData ? key : "", data: initialData, error: "", loading: !initialData }));
  const previousInitialData = useRef(initialData);
  const preparedKey = useRef(initialData ? key : null);
  // Adopt newly prepared content before paint without remounting the detail's controls.
  if (initialData && initialData !== previousInitialData.current) {
    previousInitialData.current = initialData;
    preparedKey.current = key;
    setState({ key, data: initialData, error: "", loading: false });
  }
  useEffect(() => {
    // A detail navigation already fetched this resource before committing the new view.
    const prepared = preparedKey.current;
    preparedKey.current = null;
    if (prepared === key) return;
    const controller = new AbortController();
    // Reconnecting a preserved workspace refreshes in place without collapsing its content.
    setState((previous) => ({ key, data: previous.key === key ? previous.data : cache.get(path) || null, error: "", loading: Boolean(path) }));
    const timer = path ? setTimeout(() => request(path, { signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        if (cacheSize > 0) {
          cache.delete(path); cache.set(path, data);
          while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
        }
        setState({ key, data, error: "", loading: false });
      },
      (error) => { if (!controller.signal.aborted) setState({ key, data: null, error: error.message, loading: false }); },
    ), delay) : null;
    return () => { clearTimeout(timer); controller.abort(); };
  }, [path, key, cache, cacheSize, delay, initialData]);
  return state.key === key ? state : { data: cache.get(path) || null, error: "", loading: Boolean(path) };
}
