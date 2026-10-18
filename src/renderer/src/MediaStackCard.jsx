import { Layers } from "lucide-react";
import ElementCard from "./ElementCard.jsx";

export default function MediaStackCard({ onShowStack, ...props }) {
  const count = props.element.similarStack?.count;
  if (!count || props.onSelect) return <ElementCard {...props} />;
  return <div className="wiki-media-stack">
    <ElementCard {...props} />
    <button className="wiki-stack-count" disabled={props.disabled} onClick={() => onShowStack(props.element.id)}
      aria-label={`展开相似堆叠：${count} 项`} title={props.element.kind === "text" ? "查看通过相似关联连接的全部文字" : "查看通过相似关联连接的全部图片和视频"}>
      <Layers size={15} /><span>{count} 项</span>
    </button>
  </div>;
}
