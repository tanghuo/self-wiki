import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Images, ChevronDown, ChevronUp } from "lucide-react";
import { apiUrl } from "./api.js";

export default memo(function CanvasClusterNode({ data }) {
  const { group, onToggle } = data;
  return <article className={`canvas-cluster ${group.open ? "is-expanded" : ""}`}>
    {!group.open && <><Handle id="left" type="target" position={Position.Left} isConnectable={false} /><Handle id="right" type="source" position={Position.Right} isConnectable={false} /></>}
    <button className="canvas-cluster-toggle nodrag" aria-expanded={group.open} aria-label={`${group.open ? "收起" : "展开"}图片组：${group.members.length} 张图片`} onClick={() => onToggle(group.id)}>
      <Images size={17} /><strong>{group.label}</strong><span>{group.members.length}</span>{group.open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
    </button>
    {!group.open && <button className="canvas-cluster-preview nodrag" onClick={() => onToggle(group.id)} aria-label={`查看图片组：${group.members.length} 张图片`}>
      <div className="canvas-cluster-images">{group.members.slice(0, 3).map((node) => <img key={node.id} src={apiUrl(node.data.element.thumbnailUrl)} alt="" loading="lazy" draggable={false} />)}</div>
      <span>连接相同内容 · 点击展开</span>
    </button>}
  </article>;
});
