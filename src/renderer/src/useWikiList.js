import { useEffect, useMemo, useRef, useState } from "react";
import { request } from "./api.js";

// Keep loaded cards mounted when opening details and refresh the loaded range after edits.
export default function useWikiList(path, revision, delay, active) {
  const key = `${path}:${revision}`;
  const cache = useMemo(() => new Map(), [revision]);
  const session = useRef(null);
  const sentinel = useRef(null);
  const [state, setState] = useState({ key: "", data: null, loading: true, error: "" });
  useEffect(() => {
    const previous = session.current;
    const retained = previous?.path === path ? previous.data : cache.get(path) || null;
    const targetPage = retained?.pagination.page || 1;
    const controller = new AbortController();
    const current = { path, data: retained, loading: Boolean(path), error: "" };
    session.current = current;
    function publish() {
      if (!controller.signal.aborted) setState({ key, data: current.data, loading: current.loading && !current.refreshing, refreshing: current.refreshing, error: current.error });
    }
    async function fetchPage(page, throughPage = page) {
      return request(`${path}&page=${page}${throughPage > page ? `&throughPage=${throughPage}` : ""}`, { signal: controller.signal });
    }
    async function load(refresh = false) {
      if (controller.signal.aborted || (!refresh && (current.loading || !current.data || current.data.pagination.page >= current.data.pagination.pageCount))) return;
      current.loading = true; current.refreshing = refresh && Boolean(current.data); current.error = ""; publish();
      try {
        let data;
        if (refresh) {
          const rangePages = Math.floor(50000 / (retained?.pagination.pageSize || 36));
          data = await fetchPage(1, Math.min(targetPage, rangePages));
          while (data.pagination.page < Math.min(targetPage, data.pagination.pageCount)) {
            const next = await fetchPage(data.pagination.page + 1, Math.min(targetPage, data.pagination.page + rangePages));
            data = { ...data, elements: [...data.elements, ...next.elements], pagination: next.pagination };
          }
        } else {
          const next = await fetchPage(current.data.pagination.page + 1);
          data = { ...current.data, elements: [...current.data.elements, ...next.elements], pagination: next.pagination };
        }
        if (controller.signal.aborted) return;
        // Concurrent changes can shift offset pages; never render duplicate cards.
        data.elements = [...new Map(data.elements.map((element) => [element.id, element])).values()];
        current.data = data;
        cache.delete(path);
        cache.set(path, data);
        // Bound cached cards as well as query count when browsing long lists.
        let count = [...cache.values()].reduce((total, value) => total + value.elements.length, 0);
        while (cache.size > 8 || count > 288) {
          const oldest = cache.keys().next().value;
          count -= cache.get(oldest).elements.length;
          cache.delete(oldest);
        }
      } catch (error) {
        if (!controller.signal.aborted) current.error = error.message;
      } finally {
        if (refresh) current.refreshFailed = Boolean(current.error);
        current.loading = false; current.refreshing = false; publish();
        const loadAfterRefresh = current.loadAfterRefresh;
        current.loadAfterRefresh = false;
        if (loadAfterRefresh && !current.error && !controller.signal.aborted) void load();
      }
    }
    current.loadMore = () => {
      if (current.refreshing) { current.loadAfterRefresh = true; return; }
      return load();
    };
    current.retry = () => { if (!current.loading) return load(!current.data || current.refreshFailed); };
    publish();
    const timer = path ? setTimeout(() => load(true), delay) : null;
    return () => { clearTimeout(timer); controller.abort(); };
  }, [path, key, delay, cache]);
  const visible = state.key === key ? state : { data: session.current?.path === path ? session.current.data : cache.get(path) || null, loading: Boolean(path), error: "" };
  const hasMore = Boolean(visible.data && visible.data.pagination.page < visible.data.pagination.pageCount);
  useEffect(() => {
    if (!active || visible.loading || visible.refreshing || visible.error || !hasMore || !sentinel.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) session.current?.loadMore();
    }, { rootMargin: `${Math.max(1200, window.innerHeight * 2)}px` });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [active, visible.loading, visible.refreshing, visible.error, visible.data, hasMore]);
  return { ...visible, hasMore, sentinel, loadMore: () => session.current?.loadMore(), retry: () => session.current?.retry() };
}
