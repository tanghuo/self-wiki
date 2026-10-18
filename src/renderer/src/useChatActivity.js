import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, request } from "./api.js";

export default function useChatActivity(selectedId, visible) {
  const key = `wikiChatActivity:${apiUrl("/api/chat/activity")}`;
  const [activity, setActivity] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
      return Object.fromEntries(Object.entries(saved).filter(([id, value]) => /^\d+$/.test(id) && value
        && (value.turnId === null || Number.isSafeInteger(value.turnId))
        && [null, "running", "completed", "interrupted", "failed"].includes(value.state)
        && typeof value.unread === "boolean"));
    } catch { return {}; }
  });
  const viewing = useRef({ selectedId, visible });
  viewing.current = { selectedId, visible };
  const poll = useRef(null);
  const refresh = useCallback(() => poll.current?.(), []);
  const markViewed = useCallback(() => {
    const { selectedId, visible } = viewing.current;
    if (!visible || document.hidden || !document.hasFocus()) return;
    setActivity((current) => current[selectedId]?.unread
      ? { ...current, [selectedId]: { ...current[selectedId], unread: false } } : current);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(activity)); }
    catch { /* Indicators still work when local preferences cannot be saved. */ }
  }, [key, activity]);
  useEffect(markViewed, [selectedId, visible, markViewed]);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false, repeat = false, initialized = false;
    async function load() {
      if (controller.signal.aborted || document.hidden) return;
      if (loading) { repeat = true; return; }
      loading = true;
      try {
        const value = await request("/api/chat/activity", { signal: controller.signal });
        if (controller.signal.aborted) return;
        const first = !initialized;
        initialized = true;
        const { selectedId, visible } = viewing.current;
        const viewedId = visible && !document.hidden && document.hasFocus() ? selectedId : null;
        setActivity((current) => {
          const next = Object.fromEntries(value.sessions.map(({ id, turnId, state, running }) => {
            const previous = current[id];
            // Baseline old history once; subsequent completed turns count even if a whole run occurred between polls.
            const completed = state === "completed" && (previous
              ? previous.turnId !== turnId || previous.state !== "completed" : !first);
            return [id, { turnId, state, running, unread: id !== viewedId && state === "completed"
              && (completed || Boolean(previous?.unread)) }];
          }));
          return JSON.stringify(next) === JSON.stringify(current) ? current : next;
        });
      } catch { /* Keep the last status during transient connection failures; the next poll retries. */ }
      finally {
        loading = false;
        if (repeat) { repeat = false; void load(); }
      }
    }
    poll.current = load;
    const focus = () => { markViewed(); void load(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      controller.abort(); clearInterval(timer); poll.current = null;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [markViewed]);

  return { activity, refresh };
}
