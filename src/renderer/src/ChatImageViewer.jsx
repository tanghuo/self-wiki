import { randomUUID } from "./browserCrypto.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, ChevronRight, Download, Maximize2, Pencil, Scan, Undo2, X } from "lucide-react";
import Dialog from "./Dialog.jsx";
import { apiUrl } from "./api.js";
import "./chatImageViewer.css";

export const chatImageUrl = (image) => apiUrl(`/api/chat/turns/${image.turnId}/artifacts/${image.artifact}`);

export default function ChatImageViewer({ initial, images, turns, progressNotice, stopping, disabled, onEdit, onStop, onClose }) {
  const [selected, setSelected] = useState(initial.artifact);
  const [drafts, setDrafts] = useState({ [initial.artifact]: { text: initial.text || "", region: initial.region, editing: Boolean(initial.editing) } });
  const [selecting, setSelecting] = useState(false), [zoom, setZoom] = useState(false), [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false);
  const pan = useRef(null), zoomAnchor = useRef(null), moved = useRef(false);
  const [imageSize, setImageSize] = useState(null), [stageSize, setStageSize] = useState(null);
  const stage = useRef(null);
  const [submitting, setSubmitting] = useState(false), [job, setJob] = useState(null), [error, setError] = useState("");
  const drag = useRef(null), request = useRef(null), prompt = useRef(null);
  const current = images.find((image) => image.artifact === selected) || initial;
  const index = images.findIndex((image) => image.artifact === current.artifact);
  const draft = drafts[current.artifact] || { text: "", region: undefined, editing: false };
  const waiting = submitting || job !== null;
  const imageErrors = [...new Set((turns.find((turn) => turn.id === job)?.events || []).filter((event) => event.state === "failed" && event.error).map((event) => event.error))].join("\n");
  const scale = imageSize && stageSize ? Math.min(1, stageSize.width / imageSize.width, stageSize.height / imageSize.height) : 1;
  const surfaceStyle = imageSize ? { width: imageSize.width * (zoom ? Math.max(1, scale * 2) : scale), height: imageSize.height * (zoom ? Math.max(1, scale * 2) : scale) } : undefined;
  function toggleZoom(event) {
    if (!loaded || failed || selecting) return;
    const container = stage.current, surface = container.querySelector(".chat-image-surface");
    const rect = surface.getBoundingClientRect(), viewport = container.getBoundingClientRect();
    const fromImage = event.currentTarget === surface;
    zoomAnchor.current = {
      x: fromImage ? (event.clientX - rect.left) / rect.width : .5,
      y: fromImage ? (event.clientY - rect.top) / rect.height : .5,
      left: fromImage ? event.clientX - viewport.left : container.clientWidth / 2,
      top: fromImage ? event.clientY - viewport.top : container.clientHeight / 2,
    };
    setZoom(!zoom);
  }
  useLayoutEffect(() => {
    const container = stage.current;
    if (!zoom) { container.scrollTo(0, 0); return; }
    const anchor = zoomAnchor.current;
    if (!anchor) return;
    const rect = container.querySelector(".chat-image-surface").getBoundingClientRect(), viewport = container.getBoundingClientRect();
    container.scrollLeft += rect.left - viewport.left + rect.width * anchor.x - anchor.left;
    container.scrollTop += rect.top - viewport.top + rect.height * anchor.y - anchor.top;
    zoomAnchor.current = null;
  }, [zoom]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => { setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  function changeDraft(patch) { setDrafts((previous) => ({ ...previous, [current.artifact]: { ...previous[current.artifact], ...patch } })); }
  function select(image) {
    if (image.artifact === selected) return;
    pan.current = null; moved.current = false;
    setSelected(image.artifact); setSelecting(false); setZoom(false); setLoaded(false); setFailed(false); setError(""); drag.current = null;
  }
  useEffect(() => {
    pan.current = null; moved.current = false;
    if (draft.editing) prompt.current?.focus();
  }, [selected, draft.editing, selecting]);
  useEffect(() => {
    if (!job) return;
    const turn = turns.find((turn) => turn.id === job);
    if (!turn || turn.state === "running") return;
    const artifact = turn.events.findLast((event) => event.artifact)?.artifact;
    setJob(null); request.current = null;
    if (artifact) {
      setDrafts((previous) => ({ ...previous, [selected]: { text: "", editing: false } }));
      select({ turnId: turn.id, artifact });
    } else setError(turn.error || imageErrors || (turn.state === "interrupted" ? "编辑已停止，可以调整要求后重试。" : "本轮没有返回新图片，可以调整要求后重试。"));
  }, [job, turns, imageErrors]);

  function point(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function regionAt(event) {
    const end = point(event), start = drag.current;
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
  }
  async function submit(event) {
    event.preventDefault();
    if (!draft.text?.trim() || waiting || disabled || !loaded || failed) return;
    const imageEdit = { turnId: current.turnId, artifact: current.artifact, ...(draft.region && { region: draft.region }) };
    const key = JSON.stringify({ text: draft.text.trim(), imageEdit });
    if (request.current?.key !== key) request.current = { key, id: randomUUID() };
    setSubmitting(true); setError("");
    try { const turnId = await onEdit(draft.text.trim(), imageEdit, request.current.id); setJob(turnId); }
    catch (error) { setError(error.message); }
    finally { setSubmitting(false); }
  }
  const parent = current.imageEdit && images.find((image) => image.artifact === current.imageEdit.artifact);
  return <Dialog open label="生成图片预览" className="chat-image-viewer" onClose={onClose}>
    <div className="chat-image-viewer-layout" onKeyDown={(event) => {
      if (waiting || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); select(images[index - 1]); }
      if (event.key === "ArrowRight" && index < images.length - 1) { event.preventDefault(); select(images[index + 1]); }
    }}>
      <header className="chat-image-toolbar">
        <button className="icon-only" aria-label="关闭图片预览" title="关闭 · Esc" onClick={onClose}><X size={21} /></button>
        <div className="chat-image-title"><strong>{draft.editing ? "编辑图片" : "图片"}</strong><span>{index + 1} / {images.length}</span></div>
        <div className="chat-image-toolbar-actions">
          {parent && <button disabled={waiting} onClick={() => select(parent)}><Undo2 size={16} /><span>编辑前</span></button>}
          <button aria-label="放大图片" title={zoom ? "适应窗口" : "放大图片"} aria-pressed={zoom} disabled={!loaded || failed || selecting} onClick={toggleZoom}><Maximize2 size={17} /></button>
          <a className="button" href={chatImageUrl(current)} download={`wiki-${current.turnId}.png`} aria-label="下载当前图片"><Download size={17} /><span>下载</span></a>
        </div>
      </header>
      <div ref={stage} className={`chat-image-stage ${zoom ? "is-zoomed" : ""}`} tabIndex={0} aria-label="图片浏览区">
        {images.length > 1 && <button className="chat-image-nav previous" aria-label="上一张图片" disabled={waiting || index <= 0} onClick={() => select(images[index - 1])}><ChevronLeft size={23} /></button>}
        <div className={`chat-image-surface ${!draft.editing ? "is-browsing" : ""}`} style={surfaceStyle} key={current.artifact}
          onClick={(event) => { if (!draft.editing && !moved.current) toggleZoom(event); }}
          onPointerDown={(event) => {
            moved.current = false;
            if (!zoom || draft.editing || event.button !== 0 || !event.isPrimary) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.current.scrollLeft, top: stage.current.scrollTop };
          }} onPointerMove={(event) => {
            const start = pan.current;
            if (!start || start.id !== event.pointerId) return;
            const dx = event.clientX - start.x, dy = event.clientY - start.y;
            if (Math.hypot(dx, dy) > 4) moved.current = true;
            if (moved.current) { stage.current.scrollLeft = start.left - dx; stage.current.scrollTop = start.top - dy; }
          }} onPointerUp={(event) => {
            if (pan.current?.id !== event.pointerId) return;
            pan.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => { pan.current = null; moved.current = true; }} onLostPointerCapture={() => { pan.current = null; }}>
          <img src={chatImageUrl(current)} alt="生成的图片原图" draggable={false} onLoad={(event) => { setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true); setFailed(false); }} onError={() => { setFailed(true); setLoaded(false); }} />
          {loaded && !failed && <div className={`chat-image-selection ${selecting ? "is-selecting" : ""}`} aria-label="图片选区" onPointerDown={(event) => {
            if (!selecting || waiting || event.button !== 0) return;
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = point(event); changeDraft({ region: undefined });
          }} onPointerMove={(event) => { if (drag.current) changeDraft({ region: regionAt(event) }); }} onPointerUp={(event) => {
            if (!drag.current) return;
            const region = regionAt(event); drag.current = null;
            changeDraft({ region: region.width > .005 && region.height > .005 ? region : undefined });
            event.currentTarget.releasePointerCapture(event.pointerId); prompt.current?.focus();
          }} onPointerCancel={() => { drag.current = null; changeDraft({ region: undefined }); }}>
            {draft.editing && draft.region && <div className="chat-image-region" style={{ left: `${draft.region.x * 100}%`, top: `${draft.region.y * 100}%`, width: `${draft.region.width * 100}%`, height: `${draft.region.height * 100}%` }} />}
          </div>}
        </div>
        {failed && <p className="chat-image-load-error" role="alert">图片无法加载，请关闭后重新打开。</p>}
        {images.length > 1 && <button className="chat-image-nav next" aria-label="下一张图片" disabled={waiting || index >= images.length - 1} onClick={() => select(images[index + 1])}><ChevronRight size={23} /></button>}
      </div>
      <footer className="chat-image-editor">
        {!draft.editing && !waiting && <p className="chat-image-browse-hint">{zoom ? "拖动查看细节，再次点击恢复全图" : "点击图片放大查看"}</p>}
        {waiting ? <div className="chat-image-waiting" role="status"><span className="chat-busy-dot" />{submitting ? "正在提交编辑…" : stopping ? "正在停止生成…" : "正在编辑图片…"}<button disabled={submitting || stopping} onClick={() => onStop().catch((error) => setError(error.message))}>{stopping ? "正在停止…" : "停止"}</button></div> : draft.editing ? <>
          <div className="chat-image-edit-tools"><button aria-pressed={selecting} disabled={!loaded || failed} onClick={() => { setSelecting(!selecting); setZoom(false); }}><Scan size={16} />选择区域</button>{draft.region && <button onClick={() => changeDraft({ region: undefined })}>清除选区</button>}<span>{selecting ? "拖动框选要修改的位置" : "描述你想修改的内容"}</span></div>
          <form className="chat-image-edit-composer" onSubmit={submit}>
            <textarea ref={prompt} aria-label="图片修改要求" placeholder={draft.region ? "想怎样修改选中的区域？" : "描述你想对这张图片做的修改…"} value={draft.text || ""} maxLength={12000} rows={2} disabled={disabled} onChange={(event) => changeDraft({ text: event.target.value })} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
            }} />
            <button className="primary" type="submit" aria-label="提交图片编辑" disabled={disabled || !loaded || failed || !draft.text?.trim()}><ArrowUp size={20} /></button>
          </form>
          <p className="chat-image-edit-hint">{disabled ? "等待当前会话结束后即可编辑" : draft.region ? "选区用于指示修改位置 · Enter 发送" : "生成新版本，原图会保留 · Enter 发送"}</p>
        </> : <button className="chat-image-start-edit" disabled={disabled || !loaded || failed} onClick={() => changeDraft({ editing: true })}><Pencil size={17} />编辑这张图片</button>}
        {waiting && progressNotice && <p className="chat-progress" role="status">{progressNotice}</p>}
        {waiting && imageErrors && <p className="chat-image-edit-error" role="alert">{imageErrors}</p>}
        {error && <p className="chat-image-edit-error" role="alert">{error}</p>}
        {!draft.editing && !waiting && images.length > 1 && <div className="chat-image-filmstrip" aria-label="会话图片">{images.map((image, i) => <button key={image.artifact} aria-label={`查看第 ${i + 1} 张图片`} aria-pressed={image.artifact === current.artifact} onClick={() => select(image)}><img src={chatImageUrl(image)} alt="" /></button>)}</div>}
      </footer>
    </div>
  </Dialog>;
}
