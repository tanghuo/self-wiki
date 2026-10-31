import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Maximize2, MessageCircle, Plus, X } from "lucide-react";
import { request } from "./api.js";
import useNewChatDraft from "./useNewChatDraft.js";
import useChatActivity from "./useChatActivity.js";
import Select from "./Select.jsx";
import { post } from "./chatContext.js";
import Conversation from "./ChatConversation.jsx";
import AgentShell from "./ui/AgentShell.jsx";
import PageHeader from "./ui/PageHeader.jsx";
import "./chat.css";
import { chatEngineLabel } from "../../shared/domain/chatEngine.js";

export default function ChatPanel({ selection, onSelectionConsumed, currentIds, onOpen, onClose, onExpand, onChanged, externalBusy, presentation = "dock", visible = true }) {
  const [sessions, setSessions] = useState([]), [id, setId] = useState(undefined), [hasMore, setHasMore] = useState(false);
  const { activity, refresh: refreshActivity } = useChatActivity(id, visible);
  const newDraft = useNewChatDraft();
  const [preference, setPreference] = useState(null);
  const [workbenchEnabled, setWorkbenchEnabled] = useState(false);
  useEffect(() => { request('/api/agent/status').then(value => setWorkbenchEnabled(value.agentWorkbenchEnabled)).catch(error => setError(error.message)); }, []);
  const [imagePreference, setImagePreference] = useState(null);
  const [status, setStatus] = useState(null), [checking, setChecking] = useState(false), [error, setError] = useState("");
  const [catalog, setCatalog] = useState(null), [modelsLoading, setModelsLoading] = useState(false), [modelsError, setModelsError] = useState("");
  const isPage = presentation === "page";
  const [resourceHost, setResourceHost] = useState(null);
  const requestedSession = useRef(selection?.newSession ? null : selection?.session?.id);
  if (selection?.newSession) requestedSession.current = null;
  else if (selection?.session) requestedSession.current = selection.session.id;
  useEffect(() => {
    if (selection?.newSession) { setId(null); return; }
    if (!selection?.session) return;
    setSessions((current) => [selection.session, ...current.filter((session) => session.id !== selection.session.id)]);
    setId(selection.session.id);
  }, [selection]);
  async function refreshModels() {
    setModelsLoading(true); setModelsError("");
    try { setCatalog(await request("/api/chat/models")); }
    catch (e) { setModelsError(e.message); } finally { setModelsLoading(false); }
  }
  async function load(more = false) {
    const value = await request(`/api/chat/sessions${more && sessions.length ? `?before=${sessions.at(-1).id}` : ""}`);
    setSessions((p) => [...new Map([...p, ...value.sessions].map((s) => [s.id, s])).values()].sort((a, b) => b.id - a.id)); setHasMore(value.hasMore);
    return value.sessions;
  }
  useEffect(() => {
    if (!newDraft.ready) return;
    let disposed = false;
    void refreshModels();
    request("/api/chat/image-generation/preference").then(setImagePreference).catch((e) => setError(e.message));
    request("/api/chat/model-preference").then(setPreference).catch((e) => { if (!disposed) setError(e.message); });
    (async () => {
      const entries = await load(); if (disposed) return;
      const params = new URLSearchParams(window.location.hash.split("?")[1] || ""), target = Number(params.get("session"));
      if (requestedSession.current !== undefined) setId(requestedSession.current);
      else if (target) { const selected = await request(`/api/chat/sessions/${target}`); setSessions((p) => [...new Map([...p, selected.session].map((s) => [s.id, s])).values()]); setId(requestedSession.current === undefined ? target : requestedSession.current); }
      else setId(params.has("new") || newDraft.text || newDraft.sources.length || newDraft.attachments.length ? null : entries[0]?.id ?? null);
      if (!disposed) {
        setChecking(true);
        try {
          const value = await post("probe");
          if (!disposed) setStatus(value);
          await refreshModels();
        } catch (e) {
          if (!disposed) {
            try { setStatus(await request("/api/chat/status")); } catch { /* ignore */ }
            setError(e.message);
          }
        } finally { if (!disposed) setChecking(false); }
      }
      await load();
    })().catch((e) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [newDraft.ready]);
  useEffect(() => {
    const focus = () => {
      const params = new URLSearchParams(window.location.hash.split("?")[1] || ""), target = Number(params.get("session"));
      if (params.has("new")) { requestedSession.current = null; setId(null); return; }
      if (!target) return;
      requestedSession.current = target;
      request(`/api/chat/sessions/${target}`).then((value) => { setSessions((p) => [...new Map([...p, value.session].map((s) => [s.id, s])).values()]); if (requestedSession.current === target) setId(target); }).catch((e) => setError(e.message));
    };
    window.addEventListener("hashchange", focus); return () => window.removeEventListener("hashchange", focus);
  }, []);
  function create() {
    if (workbenchEnabled) { request('/api/agent/wiki-template', { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), text: newDraft.text, sourceIds: newDraft.sources.map(s => s.id), attachmentIds: newDraft.attachments.map(a => a.id) }) }).then(session => { window.location.hash = '#workbench?session=' + session.id; }).catch(error => setError(error.message)); return; }
    requestedSession.current = null; setId(null);
    if (isPage) window.history.replaceState(null, "", "#agent?new=1");
    request("/api/chat/image-generation/preference").then(setImagePreference).catch((e) => setError(e.message));
    request("/api/chat/model-preference").then(setPreference).catch((e) => setError(e.message));
  }
  function openSession(session) {
    requestedSession.current = session.id;
    setSessions((current) => [...new Map([...current, session].map((entry) => [entry.id, entry])).values()].sort((a, b) => b.id - a.id)); setId(session.id);
    if (isPage) window.history.replaceState(null, "", `#agent?session=${session.id}`);
  }
  function started(session) {
    setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)]);
    refreshActivity();
    if (requestedSession.current === null || requestedSession.current === undefined) openSession(session);
  }
  async function probe() { setChecking(true); try { setStatus(await post("probe")); await refreshModels(); } catch (e) { setError(e.message); } finally { setChecking(false); } }
  const timeline = <>
    {/* The page uses the shared PageHeader (新会话 lives in the session list); the dock keeps its compact bar. */}
    {isPage ? <PageHeader className="chat-header" title="Agent 对话" subtitle="从内容库选好资料后再问，回答会标出引用的内容。" titleProps={{ className: "page-title" }} />
      : <header className="chat-header"><div><MessageCircle size={19} /><strong>对话</strong></div><div>
      <button className="icon-only chat-header-new" title="新会话" aria-label="新会话" disabled={id === undefined || newDraft.sending} onClick={create}><Plus size={18} /></button>
      <button className="icon-only" title="进入 Agent 工作区" aria-label="进入 Agent 工作区" onClick={onExpand}><Maximize2 size={17} /></button><button className="icon-only" aria-label="关闭对话" onClick={onClose}><X size={18} /></button>
    </div></header>}
    <div className="chat-session-bar"><span className="chat-session-title">{sessions.find((s) => s.id === id)?.title || "新会话"}</span>{/* On the Agent page sessions switch only in the left list; the compact dock keeps a picker. */}{!isPage && <><Select className="chat-session-select" aria-label="历史会话" value={id || ""} disabled={newDraft.sending} onChange={(next) => next ? openSession(sessions.find((s) => s.id === Number(next))) : create()} options={[{ value: "", label: "新会话" }, ...sessions.map((s) => ({ value: s.id, label: s.title }))]} />{hasMore && <button className="text-button chat-session-more" onClick={() => load(true).catch((e) => setError(e.message))}>更多</button>}</>}<div className="chat-connection-actions">
    {status && <details className="chat-connection" data-available={status.available ? "true" : "false"}><summary><i aria-hidden="true" />{chatEngineLabel(status.engine)} {status.available ? "已连接" : "未连接 · 查看原因"}</summary><div className="chat-connection-info"><p>{status.message}</p><p>聊天引擎和程序沿用「设置 → Agent 连接」。可在输入框旁单独选择本会话的模型。</p></div></details>}
    {status?.available !== false && <button className="text-button button-sm" disabled={checking} onClick={probe}>{checking ? "检测中…" : "检测连接"}</button>}</div></div>
    {error && <p className="wiki-error" role="alert">{error}</p>}
    {id === undefined && newDraft.error && <p className="wiki-error" role="alert">{newDraft.error}<button onClick={newDraft.retry}>重试恢复草稿</button></p>}
    {id !== undefined && <Conversation key={id || "new"} id={id} newDraft={newDraft}
      session={{
        onStarted: started,
        selection: selection?.newSession ? id === null ? selection : null : !selection?.session || selection.session.id === id ? selection : null,
        onSelectionConsumed,
        onSessionsChanged: () => load().catch((e) => setError(e.message)),
        onActivityChange: refreshActivity,
        onForkCreated: openSession,
      }}
      connectionApi={{ status, onConnection: setStatus, onProbe: probe, probing: checking }}
      models={{
        catalog, loading: modelsLoading, error: modelsError, onRefresh: refreshModels,
        preference, onPreference: setPreference, imagePreference, onImagePreference: setImagePreference,
      }}
      shell={{ currentIds, onOpen, onChanged, externalBusy, presentation, workbenchEnabled, resourceHost: isPage ? resourceHost : null }}
    />}
  </>;
  return <section className={`chat-panel ${isPage ? "chat-page" : ""}`} role={isPage ? "main" : "complementary"} aria-label={isPage ? "Agent 对话" : "对话"} hidden={!visible}>
    {/* The same tree in page and dock mode (so the conversation never remounts); the dock just shows the centre column. */}
    <AgentShell className={`chat-shell${isPage ? "" : " is-dock"}`} sessionsClassName="chat-history" sessionsLabel="会话列表" resourcesClassName="chat-resources" resourcesLabel="生成结果与引用资料"
        sessions={<>
      <button className="chat-history-new" aria-label="新会话" disabled={id === undefined || newDraft.sending} onClick={create}><Plus size={16} />新建对话</button>
      <p>会话记录</p><div className="chat-history-items">{sessions.map((s) => <div className="chat-history-item" key={s.id}><button title={s.title} data-session-id={s.id} disabled={newDraft.sending} aria-current={id === s.id ? "true" : undefined} onClick={() => openSession(s)}><MessageCircle size={14} /><span className="chat-history-title">{s.title}</span>
        {activity[s.id]?.running ? <span className="chat-history-status" role="img" aria-label="正在执行" title="正在执行"><LoaderCircle size={14} className="chat-history-spinner" aria-hidden="true" /></span>
          : activity[s.id]?.unread ? <span className="chat-history-status" role="img" aria-label="已完成，未查看" title="已完成，未查看"><span className="chat-history-unread" /></span> : null}
      </button></div>)}</div>
      {hasMore && <button className="text-button" onClick={() => load(true).catch((e) => setError(e.message))}>更多会话</button>}
        </>}
        resources={<div className="chat-resources-host" ref={setResourceHost} />}>{timeline}</AgentShell>
  </section>;
}
