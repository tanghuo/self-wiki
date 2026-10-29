import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, useExternalStoreRuntime, MessageNotSentError } from "@assistant-ui/react";
import { ArrowUp, BookOpen, FileText, LoaderCircle, MessageCircle, Network, Plus, Search, Square, X } from "lucide-react";
import { imageExecutorDefinition } from "../../shared/domain/imageGeneration.js";
import { chatEngineLabel } from "../../shared/domain/chatEngine.js";
import { randomUUID } from "./browserCrypto.js";
import { apiUrl, request } from "./api.js";
import { elementLabel, maxImageBytes } from "../../shared/domain/elements.js";
import { clipboardImages } from "./contentDrafts.js";
import { REFERENCE_DRAG_TYPE, readReferenceDrag } from "./referenceDrag.js";
import ChatSourcePicker from "./ChatSourcePicker.jsx";
import ChatImageViewer, { chatImageUrl } from "./ChatImageViewer.jsx";
import ChatModelPicker from "./ChatModelPicker.jsx";
import ChatImagePicker from "./ChatImagePicker.jsx";
import useChatDraft from "./useChatDraft.js";
import useChatAttachmentDraft from "./useChatAttachmentDraft.js";
import { chatMessageParts } from "../../shared/domain/chatMessageParts.js";
import { maxChatImages, chatImageCount, checkChatImageCount } from "../../shared/domain/chat.js";
import { ChatContext, post } from "./chatContext.js";
import { Sources, PastedImages, UserMessage, AssistantMessage } from "./ChatMessages.jsx";

export default function Conversation({ id, newDraft, session, connectionApi, models, shell }) {
  const { onStarted, selection, onSelectionConsumed, onSessionsChanged, onActivityChange, onForkCreated } = session;
  const { status: connection, onConnection, onProbe, probing } = connectionApi;
  const { catalog, loading: modelsLoading, error: modelsError, onRefresh: onRefreshModels, preference, onPreference, imagePreference, onImagePreference } = models;
  const { currentIds, onOpen, onChanged, externalBusy, presentation } = shell;
  const [data, setData] = useState(null), [older, setOlder] = useState([]), [olderAvailable, setOlderAvailable] = useState(false);
  const [olderProposals, setOlderProposals] = useState([]);
  const [gap, setGap] = useState(null), [gapLoading, setGapLoading] = useState(false);
  const [savedSources, setSavedSources] = useState([]), [picker, setPicker] = useState(false), [error, setError] = useState(""), [sending, setSending] = useState(false), [connected, setConnected] = useState(false);
  const [composerTools, setComposerTools] = useState(null);
  const sources = id ? savedSources : newDraft.sources, setSources = id ? setSavedSources : newDraft.setSources;
  const savedImages = useChatAttachmentDraft(id, data?.session.imageDraft);
  const attachments = id ? savedImages.attachments : newDraft.attachments, setAttachments = id ? savedImages.setAttachments : newDraft.setAttachments;
  const [uploadingImages, setUploadingImages] = useState(false);
  const imageUpload = useRef(null);
  useEffect(() => () => imageUpload.current?.abort(), []);
  const [receivingReference, setReceivingReference] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [pendingImageOptions, setPendingImageOptions] = useState(null);
  const [modelBusy, setModelBusy] = useState(false), [switchingVersion, setSwitchingVersion] = useState(false);
  const viewportRef = useRef(null), versionAnchor = useRef(null);
  const onVersionRendered = useCallback((turnId, node) => {
    const anchor = versionAnchor.current, viewport = viewportRef.current;
    if (!anchor || anchor.turnId !== turnId || !node || !viewport) return;
    const controls = node.querySelector(".chat-versions");
    if (controls) viewport.scrollTo({ top: viewport.scrollTop + controls.getBoundingClientRect().top - anchor.top, behavior: "instant" });
    versionAnchor.current = null;
  }, []);
  const [stopping, setStopping] = useState(false);
  const stopRequest = useRef(null);
  const [preview, setPreview] = useState(null);
  const savedDraft = useChatDraft(id, data?.session.draft);
  const draft = id ? savedDraft : newDraft;
  const sendInFlight = useRef(false);
  const pending = useRef(null), hasLoadedOlder = useRef(false);
  const consumed = useRef(null);
  const focus = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const focusedTurn = Number(focus.get("session")) === id ? Number(focus.get("turn")) : 0;
  const scrolledTo = useRef(0);
  const snapshot = useRef(null);
  useEffect(() => {
    if (!selection || selection.newSession && id || consumed.current === selection || !draft.ready || !savedImages.ready || newDraft.sending || uploadingImages) return;
    consumed.current = selection;
    const elements = selection.elements || [selection.element];
    const combined = [...new Map([...sources, ...elements.map((e) => ({ id: e.id, kind: e.kind, label: e.label || elementLabel(e) }))].map((e) => [e.id, e])).values()];
    const accepted = fitSources(combined);
    setSources(accepted);
    onSelectionConsumed(accepted.map((element) => element.id));
  }, [id, selection, sources, attachments.length, onSelectionConsumed, draft.ready, savedImages.ready, newDraft.sending, uploadingImages]);
  // A POST acknowledgement may arrive after newer SSE data. A new server instance resets the sequence.
  const update = useCallback((value) => {
    const current = snapshot.current;
    if (current && current.streamId === value.streamId && value.revision < current.revision) return;
    if (current && (current.streamId !== value.streamId || current.session.branchRevision !== value.session.branchRevision)) {
      setOlder([]); setOlderProposals([]); setGap(null); setPreview(null);
      hasLoadedOlder.current = false; setOlderAvailable(value.hasOlder);
    }
    snapshot.current = value; setData(value);
  }, []);
  function currentPage(value) { return snapshot.current?.streamId === value.streamId && snapshot.current?.session.branchRevision === value.session.branchRevision; }
  useEffect(() => {
    if (!id) return;
    const stream = new EventSource(apiUrl(`/api/chat/sessions/${id}/events`));
    // Streaming deltas replace one turn of the current page; anything else waits for a snapshot.
    stream.addEventListener("turn", (e) => {
      const value = JSON.parse(e.data), current = snapshot.current;
      if (!current || current.streamId !== value.streamId || value.revision <= current.revision) return;
      const index = current.turns.findIndex((t) => t.id === value.turn.id);
      if (index < 0) return;
      const turns = current.turns.slice(); turns[index] = { ...turns[index], ...value.turn };
      const next = { ...current, turns, running: value.running, progressNotice: value.progressNotice, connection: value.connection, revision: value.revision };
      snapshot.current = next; setData(next); onConnection(value.connection);
    });
    stream.addEventListener("snapshot", (e) => { const value = JSON.parse(e.data); update(value); onConnection(value.connection); setConnected(true); if (!hasLoadedOlder.current) setOlderAvailable(value.hasOlder); });
    stream.onerror = () => setConnected(false);
    return () => stream.close();
  }, [id, onConnection, update]);
  const turns = useMemo(() => [...new Map([...older, ...(data?.turns || [])].map((t) => [t.id, t])).values()].sort((a, b) => a.id - b.id), [older, data]);
  useEffect(() => {
    if (!focusedTurn || scrolledTo.current === focusedTurn || !turns.some((t) => t.id === focusedTurn)) return;
    let frame, attempts = 0;
    const scroll = () => {
      const node = document.querySelector(`[data-turn-id="${focusedTurn}"]`);
      if (node?.getClientRects().length) { scrolledTo.current = focusedTurn; node.scrollIntoView({ block: "center" }); }
      else if (++attempts < 30) frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [focusedTurn, turns.length]);
  useEffect(() => {
    if (!data || !focusedTurn || scrolledTo.current === focusedTurn || turns.some((t) => t.id === focusedTurn)) return;
    let disposed = false;
    request(`/api/chat/sessions/${id}?around=${focusedTurn}`).then((value) => {
      if (!disposed && currentPage(value)) {
        if (value.requestedVersion) { void selectVersion(value.requestedVersion); return; }
        setOlder((p) => [...p, ...value.turns, ...data.turns]); setOlderProposals((p) => [...p, ...value.proposals, ...data.proposals]);
        hasLoadedOlder.current = true; setOlderAvailable(value.hasOlder);
        if (value.turns.at(-1)?.id < data.turns[0]?.id) setGap({ before: data.turns[0].id, after: value.turns.at(-1).id });
      }
    }).catch((e) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [id, Boolean(data), focusedTurn, data?.session.branchRevision]);
  const running = data?.running || turns.some((t) => t.state === "running");
  useEffect(() => { if (data) onActivityChange(); }, [Boolean(data), running, turns.at(-1)?.id, turns.at(-1)?.state, onActivityChange]);
  const images = useMemo(() => {
    const entries = new Map();
    for (const turn of turns) {
      if (turn.imageEdit && !turn.imageEdit.deleted && !entries.has(turn.imageEdit.artifact)) entries.set(turn.imageEdit.artifact, { turnId: turn.imageEdit.turnId, artifact: turn.imageEdit.artifact });
      for (const event of turn.events) if (event.artifact) entries.set(event.artifact, { turnId: turn.id, artifact: event.artifact, imageEdit: turn.imageEdit });
    }
    return [...entries.values()];
  }, [turns]);
  const composerBlocked = uploadingImages || sending || (!id && newDraft.sending) || switchingVersion || stopping || modelBusy || (id ? !data : !preference || !imagePreference) || !draft.ready || !savedImages.ready || externalBusy;
  const codexDown = Boolean(connection && connection.available === false);
  const blocked = composerBlocked || imageBusy;
  const imageOptions = pendingImageOptions ?? (id ? data?.session.imageOptions : newDraft.imageOptions ?? (newDraft.directImage ? { executor: "chatgpt-web", direct: true } : newDraft.directImage === false ? { ...imagePreference, direct: false } : imagePreference));
  const directImage = Boolean(imageOptions?.direct);
  const needsCodex = !directImage;
  const sendBlocked = blocked || codexDown && needsCodex;
  const legacyPending = !id && newDraft.pending && !newDraft.imageOptions;
  const imageReady = legacyPending || imageOptions?.executor !== "comfyui" || Boolean(imageOptions.workflowId && imageOptions.prompt && imageOptions.outputNodeId);
  async function selectImageOptions(options) {
    setPendingImageOptions(options); setImageBusy(true); setError("");
    try {
      const value = await request(id ? `/api/chat/sessions/${id}/image-options` : "/api/chat/image-generation/preference", {
        method: "PATCH", body: JSON.stringify(id ? { options, revision: data.session.imageOptionsRevision } : options),
      });
      const saved = id ? value.session.imageOptions : value;
      if (id) update(value); else newDraft.setImageOptions(saved);
      onImagePreference(saved); return true;
    } catch (failure) { setError(failure.message); return false; }
    finally { setPendingImageOptions(null); setImageBusy(false); }
  }
  const hasImages = attachments.length > 0 || sources.some((source) => source.kind === "image");
  const model = id ? data?.session.model || "" : newDraft.model ?? preference?.model ?? "";
  const effort = id ? data?.session.effort || "" : newDraft.effort ?? preference?.effort ?? "";
  async function selectModel(model, effort) {
    setModelBusy(true); setError("");
    try {
      const value = await request(id ? `/api/chat/sessions/${id}` : "/api/chat/model-preference", { method: "PATCH", body: JSON.stringify({ model, effort }) });
      if (id) update(value); else newDraft.setModel(model, effort);
      onPreference({ model, effort }); return true;
    }
    catch (e) { setError(e.message); return false; } finally { setModelBusy(false); }
  }
  async function send(message) {
    if (codexDown && needsCodex) throw new MessageNotSentError(`请先检测并连接 ${chatEngineLabel(connection?.engine)}`);
    if (imageUpload.current) throw new MessageNotSentError("图片正在加入，请稍候");
    if (sendInFlight.current) throw new MessageNotSentError("消息正在发送，请稍候");
    if (!imageReady) throw new MessageNotSentError("请先选择工作流并完成提示词和输出映射");
    const text = directImage ? draft.text : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    try { checkChatImageCount(sources, attachments); }
    catch (e) { setError(e.message); throw new MessageNotSentError(e.message); }
    // A pre-upgrade pending first send must retain its old wire payload/hash.
    const input = { text, ...(!legacyPending && { imageOptions }), ...(directImage && { directImage: true }), sourceIds: sources.map((s) => s.id), ...(attachments.length && { attachmentIds: attachments.map((image) => image.id) }), model, effort }, key = JSON.stringify(input);
    if (pending.current?.key !== key) pending.current = { key, requestKey: randomUUID(), payload: { ...input, branchRevision: data?.session.branchRevision ?? 0 }, submitted: false };
    const payload = pending.current.payload;
    sendInFlight.current = true; setSending(true); setError("");
    if (!id) newDraft.setSending(true);
    try {
      const workbench = await request('/api/agent/status');
      if (workbench.agentWorkbenchEnabled) {
        await draft.flush(); if (id) await savedImages.flush();
        const converted = await request(id ? `/api/agent/legacy/${id}/continue` : '/api/agent/wiki-template', { method: 'POST', body: JSON.stringify({ requestKey: pending.current.requestKey, text: payload.text, sourceIds: payload.sourceIds, attachmentIds: payload.attachmentIds || [] }) });
        window.location.hash = `#workbench?session=${converted.id}`; return;
      }
      if (!id) {
        await draft.flush();
        const value = await post("sessions/start", { ...payload, requestKey: await newDraft.prepare(payload) });
        await newDraft.clear(); onStarted(value.session); return;
      }
      // A lost acknowledgement may already have cleared both server drafts and advanced
      // the branch. Replay that exact request before attempting another draft write.
      if (!pending.current.submitted) { await draft.flush(); await savedImages.flush(); }
      pending.current.submitted = true;
      const value = await post(`sessions/${id}/turns`, { ...payload, requestKey: pending.current.requestKey });
      update(value); draft.accept(value.session.draft);
      setSources((current) => current.filter((source) => !payload.sourceIds.includes(source.id)));
      savedImages.accept(value.session.imageDraft);
      pending.current = null; onSessionsChanged();
    }
    catch (e) { setError(e.message); throw new MessageNotSentError(e.message); } finally { sendInFlight.current = false; setSending(false); if (!id) newDraft.setSending(false); }
  }
  async function archive(turnId, value) {
    const saved = await post(`turns/${turnId}/save`, value); onChanged(); return saved;
  }
  async function editMessage(turnId, text, sourceIds, requestKey, attachmentIds) {
    setSending(true); setError("");
    try {
      const value = await post(`turns/${turnId}/edit`, { text, sourceIds, attachmentIds, requestKey, model, effort, branchRevision: data.session.branchRevision });
      update(value); onSessionsChanged();
    } finally { setSending(false); }
  }
  async function selectVersion(turnId) {
    const current = turns.find((turn) => turn.versions?.includes(turnId));
    const controls = viewportRef.current?.querySelector(`[data-user-turn-id="${current?.id}"] .chat-versions`);
    versionAnchor.current = controls ? { turnId, top: controls.getBoundingClientRect().top } : null;
    setSwitchingVersion(true); setError("");
    try { update(await post(`turns/${turnId}/select`, { branchRevision: snapshot.current.session.branchRevision })); }
    catch (e) { versionAnchor.current = null; setError(e.message); } finally { setSwitchingVersion(false); }
  }
  async function fork(turnId, requestKey) {
    setSending(true); setError("");
    try {
      await draft.flush();
      const session = await post(`turns/${turnId}/fork`, { requestKey, branchRevision: data.session.branchRevision });
      onForkCreated(session);
    } catch (e) { setError(e.message); } finally { setSending(false); }
  }
  async function extract(turnId) {
    setSending(true); setError("");
    try { update(await post(`turns/${turnId}/extract`, { requestKey: randomUUID() })); onSessionsChanged(); }
    catch (e) { setError(e.message); } finally { setSending(false); }
  }
  function stop() {
    if (stopRequest.current) return stopRequest.current;
    setStopping(true); setError("");
    stopRequest.current = request(`/api/chat/sessions/${id}/stop`, { method: "POST", body: "{}", signal: AbortSignal.timeout(10000) })
      .then(update)
      .catch((error) => { throw new Error(error.name === "TimeoutError" ? "停止请求未收到响应，尚未确认生成已停止。请重试；若仍无响应，请重启应用。" : error.message); })
      .finally(() => { stopRequest.current = null; setStopping(false); });
    return stopRequest.current;
  }
  async function editImage(text, imageEdit, requestKey) {
    if (running || blocked) throw new Error("请等待当前会话结束后再编辑");
    if (imageOptions?.executor === "comfyui") throw new Error("ComfyUI 改图请将原图作为附件发送，并选择有图片入口的工作流；暂不支持此处的选区编辑");
    setSending(true);
    try {
      const value = await post(`sessions/${id}/turns`, { text, imageEdit, requestKey, sourceIds: [], model, effort, imageOptions: { ...imageOptions, direct: false }, branchRevision: data.session.branchRevision });
      update(value); onSessionsChanged();
      return value.turns.find((turn) => turn.requestKey === requestKey).id;
    } finally { setSending(false); }
  }
  async function loadOlder() {
    try {
      const value = await request(`/api/chat/sessions/${id}?before=${turns[0].id}`);
      if (!currentPage(value)) return;
      hasLoadedOlder.current = true; setOlder((p) => [...value.turns, ...p]); setOlderAvailable(value.hasOlder);
      setOlderProposals((p) => [...new Map([...p, ...value.proposals].map((item) => [item.id, item])).values()]);
    } catch (e) { setError(e.message); }
  }
  async function loadGap() {
    if (!gap || gapLoading) return;
    setGapLoading(true);
    try {
      const value = await request(`/api/chat/sessions/${id}?before=${gap.before}`);
      if (!currentPage(value)) return;
      setOlder((p) => [...p, ...value.turns]); setOlderProposals((p) => [...p, ...value.proposals]);
      setGap(value.turns[0]?.id > gap.after && value.hasOlder ? { ...gap, before: value.turns[0].id } : null);
    } catch (e) { setError(e.message); } finally { setGapLoading(false); }
  }
  async function addCurrent() {
    try {
      const values = await Promise.all(currentIds.slice(0, 12).map((id) => request(`/api/elements/${id}`)));
      setSources(fitSources([...new Map([...sources, ...values.map((e) => ({ id: e.id, kind: e.kind, label: elementLabel(e) }))].map((e) => [e.id, e])).values()]));
    } catch (e) { setError(e.message); }
  }
  async function pasteImages(event) {
    const files = clipboardImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    if (running || blocked || imageUpload.current || sendInFlight.current) { setError("请等待当前操作完成后再粘贴图片。"); return; }
    if (sources.length + attachments.length + files.length > 12) { setError("最多加入 12 份资料，请移除部分资料后重新粘贴。"); return; }
    if (chatImageCount(sources, attachments) + files.length > maxChatImages) { setError(`本轮图片合计最多 ${maxChatImages} 张，请减少 Wiki 图片或粘贴图片后重试。`); return; }
    if (files.some((file) => file.size > maxImageBytes)) { setError("每张图片必须在 25 MiB 以内。"); return; }
    const upload = new AbortController();
    imageUpload.current = upload; setUploadingImages(true); setError("");
    try {
      for (const file of files) {
        const image = await request("/api/chat/attachments", { method: "POST", headers: {
          "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "粘贴图片.png"),
        }, body: file });
        if (upload.signal.aborted) { await request(`/api/chat/attachments/${image.id}`, { method: "DELETE" }); return; }
        setAttachments((current) => [...current, image]);
      }
    } catch (e) {
      if (!upload.signal.aborted) setError(`图片未全部加入：${e.message}。已加入的图片会保留，请重新粘贴未加入的图片。`);
    } finally {
      if (!upload.signal.aborted) { imageUpload.current = null; setUploadingImages(false); }
    }
  }
  function reference(element) {
    if (element.kind === "video") { setError("视频暂不支持作为 AI 资料，可在内容库播放。"); return; }
    if (sources.some((source) => source.id === element.id)) return;
    if (sources.length + attachments.length >= 12) { setError("最多加入 12 份资料，请移除部分资料后重新选择。"); return; }
    try { checkChatImageCount([...sources, element], attachments); }
    catch (e) { setError(e.message); return; }
    setSources((current) => current.some((source) => source.id === element.id) ? current : [...current, { id: element.id, kind: element.kind, label: element.label || elementLabel(element) }].slice(0, 12 - attachments.length));
  }
  function fitSources(values) {
    const accepted = [];
    for (const source of values) {
      if (source.kind === "video") { setError("视频暂不支持作为 AI 资料，可在内容库播放。"); continue; }
      if (accepted.length + attachments.length >= 12) { setError("最多加入 12 份资料，请移除部分资料后重新选择。"); continue; }
      try { checkChatImageCount([...accepted, source], attachments); accepted.push(source); }
      catch (e) { setError(e.message); }
    }
    return accepted;
  }
  async function removeImage(id) {
    try {
      await request(`/api/chat/attachments/${id}`, { method: "DELETE" });
      setAttachments((current) => current.filter((image) => image.id !== id));
    } catch (e) { setError(`图片未移除：${e.message}`); }
  }
  const messages = useMemo(() => turns.flatMap((t) => [
    { id: `u-${t.id}`, role: "user", content: [{ type: "text", text: t.text }], metadata: { custom: { turnId: t.id, versions: t.versions, imageEdit: t.imageEdit, attachments: t.inputAttachments, sources: t.inputSources.map((id) => t.sources.find((source) => source.id === id) || { id, label: `内容 ${id}` }) } } },
    { id: `a-${t.id}`, role: "assistant", content: chatMessageParts(t.answer, t.events).map((part) => part.type === "image" ? { type: "image", image: chatImageUrl({ artifact: part.artifact, turnId: t.id }) } : part),
      status: t.state === "running" ? { type: "running" } : { type: "complete", reason: "stop" },
      metadata: { custom: { turnId: t.id, answer: t.answer, model: t.model, createdAt: t.createdAt, updatedAt: t.updatedAt, sources: t.sources, events: t.events, state: t.state, stopping, error: t.error, saved: t.saved, focused: t.id === focusedTurn, requestTraceVersion: t.requestTraceVersion } } },
  ]), [turns, focusedTurn, stopping]);
  const runtime = useExternalStoreRuntime({ messages, isRunning: running || sending, isDisabled: composerBlocked, isSendDisabled: sendBlocked || !imageReady, onNew: send, onCancel: () => stop().catch((e) => setError(e.message)) });
  useEffect(() => { runtime.thread.composer.setText(draft.text); }, [runtime, draft.text]);
  const proposals = [...new Map([...olderProposals, ...(data?.proposals || [])].map((p) => [p.id, p])).values()].sort((a, b) => b.id - a.id);
  return <ChatContext.Provider value={{ onOpen, onArchive: archive, onExtract: extract, onEdit: editMessage, onSelectVersion: selectVersion, onVersionRendered, onFork: fork, onPreview: setPreview, onReference: reference, referenceDisabled: running || blocked, changed: (proposal) => { setOlderProposals((p) => [...p.filter((item) => item.id !== proposal.id), proposal]); onChanged(); onSessionsChanged(); }, externalBusy, proposals, setError }}>
    <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="chat-thread">
      <ThreadPrimitive.Viewport ref={viewportRef} className="chat-viewport" autoScroll={running || sending} scrollToBottomOnInitialize={!focusedTurn}>
        {olderAvailable && <button className="text-button" onClick={loadOlder}>加载更早消息</button>}
        {gap && <button className="text-button" disabled={gapLoading} onClick={loadGap}>{gapLoading ? "正在加载…" : "加载跳转位置与最近消息之间的会话"}</button>}
        {!turns.length && <div className="chat-empty">{presentation !== "page" && <span className="chat-welcome-mark"><MessageCircle size={28} /></span>}
          {presentation === "page" ? <><h2>新会话</h2>
            <div className="chat-starters">{[
              { title: "查找资料", icon: Search, example: "例：海边旅行相关的笔记有哪些？", prompt: "帮我查找 Wiki 中关于…的资料，梳理要点并标明来源。" },
              { title: "整理知识", icon: Network, example: "例：给最近的图片建议标签和关联", prompt: "帮我梳理 Wiki 中的内容，建议可以整理的主题、标签和关联。" },
              { title: "生成内容", icon: FileText, example: "例：用选中的资料写一份旅行计划", prompt: "根据我选择的资料，帮我写一份新笔记，并附上参考来源。" },
            ].map(({ title, icon: Icon, example, prompt }) => <button key={title} disabled={running || sendBlocked} onClick={() => draft.setText(prompt)}><Icon size={19} /><strong>{title}</strong><span>{example}</span></button>)}</div>
          </> : <><h3>新会话</h3></>}
        </div>}
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>
      <div className={`chat-compose-area${receivingReference && !running && !blocked ? " is-receiving-reference" : ""}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return;
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = running || blocked ? "none" : "copy";
          setReceivingReference(!running && !blocked);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setReceivingReference(false); }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return;
          event.preventDefault(); event.stopPropagation(); setReceivingReference(false);
          if (running || blocked) return;
          const source = readReferenceDrag(event.dataTransfer);
          if (source) reference(source);
        }}>
        {codexDown && needsCodex && <div className="chat-codex-needed" role="status">
          <strong>{chatEngineLabel(connection?.engine)} 未连接</strong>
          <p>{connection?.message || "连接后即可发送消息。程序与登录沿用「设置 → Agent 连接」。"}</p>
          <button type="button" disabled={probing} onClick={onProbe}>{probing ? "检测中…" : "检测连接"}</button>
        </div>}
        {error && <p className="wiki-error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>关闭提示</button></p>}
        {id && !connected && <p className="wiki-muted" role="status">正在连接会话…</p>}
        {running && data?.progressNotice && <p className="chat-progress" role="status">{data.progressNotice}</p>}
        {picker && <ChatSourcePicker selected={sources} limit={12 - attachments.length} imageLimit={maxChatImages - attachments.length} onChange={setSources} busy={running || blocked} onClose={() => setPicker(false)} />}
        <PastedImages images={attachments} onRemove={removeImage} disabled={running || blocked} label="本轮图片附件" />
        {id && savedImages.error && <p className="wiki-error" role="alert">{savedImages.error}<button className="text-button" onClick={savedImages.retry}>重试保存附件草稿</button></p>}
        {sources.length > 0 && <div className="chat-selected" aria-label="本轮资料">{sources.map((s) => <span key={s.id} title={s.label}>{s.kind === "image" && <img src={apiUrl(`/api/elements/${s.id}/thumbnail?width=400`)} alt={s.label} />}{s.label.slice(0, 22)}<button className="icon-only" aria-label={`移除资料 ${s.id}`} disabled={running || blocked} onClick={() => setSources((p) => p.filter((x) => x.id !== s.id))}><X size={11} /></button></span>)}</div>}
        {draft.error && <p className="wiki-error" role="alert">草稿尚未保存：{draft.error}<button className="text-button" onClick={draft.retry}>重试保存草稿</button></p>}
        {uploadingImages && <p className="wiki-muted" role="status">正在加入图片附件…</p>}
        <ChatImagePicker options={imageOptions} chatEngine={connection?.engine || data?.session.chatEngine} disabled={running || blocked} onChange={selectImageOptions} toolbarTarget={composerTools} />
        <ComposerPrimitive.Root className="chat-composer" onSubmit={(event) => {
          if (draft.text.trim()) return;
          // Images are managed by this application, outside the composer's attachment store.
          event.preventDefault();
          if (!(hasImages || directImage && sources.length) || blocked || running) return;
          void send({ content: [] }).catch(() => {});
        }}><ComposerPrimitive.Input aria-label="会话消息" placeholder="输入你的想法，也可直接粘贴图片" rows={2} maxLength={12000} addAttachmentOnPaste={false} onPaste={pasteImages} disabled={(!draft.ready || !savedImages.ready || !id && newDraft.sending || undefined) || undefined} value={draft.text} onChange={(e) => draft.setText(e.target.value)} onKeyDown={(event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const input = event.currentTarget;
          const cursor = input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
          const end = input.value.indexOf("\n", cursor);
          const target = event.key === "ArrowLeft" ? input.value.slice(0, cursor).lastIndexOf("\n") + 1 : end < 0 ? input.value.length : end;
          const anchor = event.shiftKey ? input.selectionDirection === "backward" ? input.selectionEnd : input.selectionStart : target;
          input.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? "backward" : "forward");
        }} />
          <div className="chat-composer-footer">
            <div className="chat-composer-sources"><button type="button" className="text-button" aria-label="从库中选择" title="从资料库加入本轮（资料篮是跨会话收藏）" aria-expanded={picker} disabled={running || blocked} onClick={() => setPicker(!picker)}><Plus size={20} /><span>从库中选择{sources.length ? ` · ${sources.length}` : ""}</span></button>{currentIds.length > 0 && <button type="button" className="text-button" disabled={running || blocked} onClick={addCurrent}>加入当前内容</button>}</div>
            <div className="chat-composer-tools" ref={setComposerTools} />
            {directImage ? <span className="wiki-muted">{imageExecutorDefinition(imageOptions.executor).label}</span> : <ChatModelPicker model={model} effort={effort} catalog={catalog} disabled={running || sendBlocked} loading={modelsLoading} error={modelsError} onChange={selectModel} onRefresh={onRefreshModels} />}
            {running ? <ComposerPrimitive.Cancel aria-label="停止生成" title={stopping ? "正在停止…" : "停止生成"} aria-busy={stopping} disabled={stopping}><Square size={15} fill="currentColor" aria-hidden="true" /></ComposerPrimitive.Cancel> : <button type="submit" className="primary" aria-label="发送消息" title={sendBlocked && codexDown && needsCodex ? `请先连接 ${chatEngineLabel(connection?.engine)} 再发送` : !draft.text.trim() && !hasImages ? "输入问题后发送" : "发送（Enter）"} disabled={sendBlocked || !imageReady || (!draft.text.trim() && !hasImages && !(directImage && sources.length))}><ArrowUp size={17} /></button>}</div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root></AssistantRuntimeProvider>
    {preview && <ChatImageViewer initial={preview} images={images} turns={turns} progressNotice={data?.progressNotice} stopping={stopping} disabled={running || blocked} onEdit={editImage} onStop={stop} onClose={() => setPreview(null)} />}
  </ChatContext.Provider>;
}
