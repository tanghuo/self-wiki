import { memo } from "react";
import { Handle, Position, useStore } from "@xyflow/react";
import { FileText, ImageIcon, Video, GripHorizontal } from "lucide-react";
import { apiUrl } from "./api.js";
import { elementLabel, elementKindLabels } from "../../shared/domain/elements.js";

const isZoomedOut = (state) => state.transform[2] < 0.45;

export function canvasTitle(element) {
  const label = elementLabel(element);
  if (element.kind === "image" && /^(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[\da-f]{24,})(?:\.[a-z0-9]+)?$/i.test(label)) return `${element.tags[0] || "图片"} · ${element.id}`;
  return label;
}

export default memo(function CanvasNode({ data, isConnectable }) {
  const compact = useStore(isZoomedOut);
  const element = data.element;
  const image = element.kind === "image";
  return <article className={`canvas-card ${image ? "is-image" : "is-text"} ${compact ? "is-compact" : ""}`}>
    <Handle id="left" type="target" position={Position.Left} isConnectable={isConnectable} aria-label="关联连接点" />
    <div className="canvas-node-grip">{image ? <ImageIcon size={13} /> : element.kind === "video" ? <Video size={13} /> : <FileText size={13} />}<span>{elementKindLabels[element.kind]}</span>{data.hub && <span className="canvas-hub-badge">连接中心</span>}<GripHorizontal size={17} /></div>
    <button className="canvas-node-open nodrag" onClick={() => data.onSelect(String(element.id))} title="单击预览，双击打开详情页" aria-label={`选择元素：${canvasTitle(element)}`}>
      {image ? <div className="canvas-image"><img src={apiUrl(element.thumbnailUrl)} alt="" loading="lazy" draggable={false} onError={(event) => { event.currentTarget.hidden = true; }} /><ImageIcon className="canvas-image-placeholder" size={27} /></div>
        : element.kind === "video" ? <div className="canvas-video"><Video size={27} /><span>{compact ? "" : "点击预览视频"}</span></div> : <p className="canvas-summary">{compact ? "" : element.summary || "点击查看内容"}</p>}
      <strong title={elementLabel(element)}>{canvasTitle(element)}</strong>
      <div className="canvas-node-tags"><span>{element.tags.slice(0, 2).map((tag) => `${tag}${element.aiTags?.some((a) => a.name === tag) ? " · AI" : ""}`).join(" · ") || `${elementKindLabels[element.kind]}元素`}</span>{data.degree > 0 && <small>{data.degree} 个连接</small>}</div>
    </button>
    <Handle id="right" type="source" position={Position.Right} isConnectable={isConnectable} aria-label="关联连接点" />
  </article>;
});
