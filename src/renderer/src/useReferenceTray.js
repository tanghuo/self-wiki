import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./api.js";
import { recordElementUsage } from "./elementUsage.js";

const cookieName = "selfWikiReferences";

function readSaved(enabled) {
  try {
    const cookie = enabled && document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${cookieName}=`));
    const saved = cookie && JSON.parse(decodeURIComponent(cookie.slice(cookieName.length + 1)));
    const ids = Array.isArray(saved?.ids) ? [...new Set(saved.ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 12) : [];
    return { elements: ids.map((id) => ({ id, label: `内容 #${id}` })), collapsed: saved?.collapsed === true };
  } catch { return { elements: [], collapsed: false }; }
}

export default function useReferenceTray(enabled, revision = 0) {
  const [state, setState] = useState(() => readSaved(enabled));
  const current = useRef(state);
  const [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState(""), [saveError, setSaveError] = useState("");
  const [failedIds, setFailedIds] = useState(new Set());
  const loadingRequest = useRef(null);

  function save(value) {
    if (!enabled) return;
    try {
      // Only IDs are stored, keeping the cookie small. Cookies survive the desktop
      // backend's changing ports; localStorage is scoped to a single port.
      const cookie = `${cookieName}=${encodeURIComponent(JSON.stringify({ ids: value.elements.map((element) => element.id), collapsed: value.collapsed }))}`;
      document.cookie = `${cookie}; Path=/; Max-Age=31536000; SameSite=Strict`;
      if (!document.cookie.split(";").some((entry) => entry.trim() === cookie)) throw new Error("Cookie storage unavailable");
      setSaveError("");
    } catch { setSaveError("资料篮暂未保存，请重试保存后再关闭应用。"); }
  }
  function update(field, value) {
    const next = { ...current.current, [field]: typeof value === "function" ? value(current.current[field]) : value };
    const previousIds = new Set(current.current.elements.map((element) => element.id));
    // Save in the action itself so an immediate reload cannot beat a React effect.
    save(next); current.current = next; setState(next);
    if (enabled && field === "elements") {
      for (const id of new Set(next.elements.map((element) => element.id))) {
        if (!previousIds.has(id)) recordElementUsage(id, "reference");
      }
    }
  }

  async function validate() {
    loadingRequest.current?.abort();
    const controller = new AbortController();
    loadingRequest.current = controller;
    const pending = enabled ? current.current.elements : [];
    if (!pending.length) { setLoading(false); setLoadError(""); setFailedIds(new Set()); return []; }
    setLoading(true); setLoadError("");
    const results = await Promise.allSettled(pending.map(async ({ id }) => {
      const response = await fetch(apiUrl(`/api/elements/${id}`), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }));
    if (controller.signal.aborted) return null;
    const requested = new Map(pending.map((element) => [element.id, element]));
    const loaded = new Map(results.flatMap((result, index) => result.status === "fulfilled" ? [[pending[index].id, result.value]] : []));
    update("elements", (elements) => elements.flatMap((element) => {
      // A late response must not restore removals or overwrite a newer addition.
      if (requested.get(element.id) !== element || !loaded.has(element.id)) return [element];
      return loaded.get(element.id) ? [loaded.get(element.id)] : [];
    }));
    const failed = new Set(current.current.elements.filter((element) => requested.get(element.id) === element && !loaded.has(element.id)).map((element) => element.id));
    setFailedIds(failed);
    if (failed.size) setLoadError("部分资料暂时无法读取，列表已保留，请重试。");
    setLoading(false);
    return current.current.elements.every((element) => loaded.get(element.id) === element) ? current.current.elements : null;
  }

  useEffect(() => {
    void validate();
    return () => loadingRequest.current?.abort();
  }, [enabled, revision, attempt]);

  const unresolved = state.elements.some((element) => !element.kind || failedIds.has(element.id));

  return {
    references: state.elements, setReferences: (value) => update("elements", value),
    collapsed: state.collapsed, setCollapsed: (value) => update("collapsed", value),
    loading, unresolved, error: saveError || (unresolved ? loadError : ""), validate,
    retry: () => { save(current.current); setAttempt((value) => value + 1); },
  };
}
