import { useLayoutEffect, useRef, useState } from "react";
import { ImageIcon, RotateCcw } from "lucide-react";
import { preloadImage } from "./imagePreload.js";
import VideoCardPreview from "./VideoCardPreview.jsx";
import { apiUrl } from "./api.js";
import { elementLabel, imagePreviewWidths } from "../../shared/domain/elements.js";

// Keep measured proportions across filter changes without retaining decoded images.
const previewRatios = new Map();

export default function ElementCard({ element, onOpen, onRestore, onSelect, selected = false, disabled, loading = "lazy" }) {
  const title = elementLabel(element);
  const image = element.kind === "image";
  const canPreview = image && (!element.deletedAt || Boolean(element.image.thumbnailUrl));
  const thumbnailUrl = element.image?.thumbnailUrl || `/api/elements/${element.id}/thumbnail`;
  const sizedThumbnail = (width) => apiUrl(`${thumbnailUrl}${thumbnailUrl.includes("?") ? "&" : "?"}width=${width}${attempt ? `&retry=${attempt}` : ""}`);
  const [preview, setPreview] = useState("loading");
  const [imageRatio, setImageRatio] = useState(() => element.image?.width && element.image?.height ? element.image.width / element.image.height : previewRatios.get(element.id));
  const [attempt, setAttempt] = useState(0);
  const card = useRef(null), imageNode = useRef(null), finishPreload = useRef(null);
  const [requested, setRequested] = useState(loading === "eager");
  useLayoutEffect(() => {
    if (!canPreview) return;
    if (loading === "eager") { setRequested(true); return; }
    if (imageNode.current?.complete && imageNode.current.naturalWidth) return;
    setRequested(false);
    const finish = preloadImage(card.current, () => setRequested(true));
    finishPreload.current = finish;
    return () => { finish(); if (finishPreload.current === finish) finishPreload.current = null; };
  }, [canPreview, loading, attempt]);
  const [previewSize, setPreviewSize] = useState(null);
  useLayoutEffect(() => {
    if (!canPreview) return;
    function measure() {
      const width = card.current.getBoundingClientRect().width;
      if (width > 0) setPreviewSize(`${Math.ceil(width)}px`);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(card.current);
    measure();
    return () => observer.disconnect();
  }, [canPreview]);
  async function loaded(event) {
    const img = event.currentTarget, finish = finishPreload.current;
    // Decode while the card is still ahead of the viewport, not during the next scroll paint.
    try { await img.decode(); } catch { /* onError handles broken responses; a changed src can also interrupt decode. */ }
    finish?.();
    if (imageNode.current !== img || !img.complete || !img.naturalWidth) return;
    const ratio = (element.image?.width && element.image?.height ? element.image.width / element.image.height : imageRatio) || previewRatios.get(element.id) || img.naturalWidth / img.naturalHeight;
    previewRatios.delete(element.id);
    previewRatios.set(element.id, ratio);
    if (previewRatios.size > 256) previewRatios.delete(previewRatios.keys().next().value);
    setImageRatio(ratio);
    setPreview("ready");
  }
  const pending = canPreview && preview === "loading";
  return <article data-element-id={element.id} ref={card} className={`wiki-card is-${element.kind} ${element.material ? "has-material" : ""} ${element.deletedAt ? "is-trashed" : ""} ${selected ? "is-selected" : ""} ${pending ? "is-loading" : ""}`} aria-busy={pending || undefined}>
    {onSelect && <input className="wiki-card-select" type="checkbox" aria-label={`选择内容：${title}`} checked={selected} disabled={disabled} onChange={() => onSelect(element.id)} />}
    <button className={`wiki-card-open${element.tags?.length ? " has-tags" : ""}`} disabled={disabled || (Boolean(element.deletedAt) && !onSelect)} onClick={() => onSelect ? onSelect(element.id) : onOpen(element.id)} aria-label={`${onSelect ? "选择内容" : "打开内容"}：${title}`} aria-pressed={onSelect ? selected : undefined}>
      {image ? <div className={`wiki-card-image${imageRatio ? " has-ratio" : ""}`} style={imageRatio ? { "--wiki-image-ratio": imageRatio } : undefined}>{!canPreview ? <ImageIcon size={34} /> : preview === "error" ? <span className="wiki-card-image-error"><ImageIcon size={24} />预览无法加载</span> : <>{previewSize && requested && <img ref={imageNode} key={attempt} src={sizedThumbnail(400)} srcSet={imagePreviewWidths.map((width) => `${sizedThumbnail(width)} ${width}w`).join(", ")} sizes={previewSize} alt={title} loading="eager" decoding="async" onLoad={loaded} onError={() => { finishPreload.current?.(); setPreview("error"); }} />}{pending && <span className="wiki-card-image-loading" aria-hidden="true"><ImageIcon size={24} />正在加载预览…</span>}</>}</div>
        : element.kind === "video" ? <VideoCardPreview key={element.id} element={element} disabled={disabled || Boolean(onSelect)} />
          : <div className="wiki-card-text"><p>{element.body || "打开查看关联内容"}</p></div>}
      {element.tags?.length > 0 && <div className="wiki-card-tags" title={element.tags.join(" · ")}>{element.tags.slice(0, 2).map((tag) => <span className="wiki-tag" key={tag}>{tag}{element.aiTags?.some((a) => a.name === tag) && <span className="ai-source" title="AI 添加，打开内容查看整理记录">AI</span>}</span>)}{element.tags.length > 2 && <span className="wiki-card-tag-count">+{element.tags.length - 2}</span>}</div>}
    </button>
    {element.material && <span className="wiki-material-badge">素材</span>}
    {preview === "error" && <button className="wiki-preview-retry" disabled={disabled} onClick={() => { setAttempt((value) => value + 1); setPreview("loading"); }}>重试预览</button>}
    {element.deletedAt && <div className="wiki-trash-meta">{image && <strong title={element.image.originalName}>{element.image.originalName}</strong>}<time dateTime={element.deletedAt}>删除于 {new Date(element.deletedAt).toLocaleString("zh-CN")}</time></div>}
    {element.deletedAt && <button className="wiki-restore" disabled={disabled} onClick={() => onRestore(element.id)}><RotateCcw size={14} />恢复内容</button>}
  </article>;
}
