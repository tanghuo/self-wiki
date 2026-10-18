import { memo } from "react";
import { useStore } from "@xyflow/react";
import { FolderOpen, FileText, ImageIcon, Video, ArrowUpRight } from "lucide-react";
import { apiUrl } from "./api.js";

const isZoomedOut = (state) => state.transform[2] < 0.45;

export default memo(function CanvasTagNode({ data }) {
  const compact = useStore(isZoomedOut);
  const { group, onOpen } = data;
  return <button className="canvas-tag-card nodrag" aria-label={`打开标签：${group.name}，${group.count} 个元素`} onClick={() => onOpen(group)}>
    <div className="canvas-tag-heading"><FolderOpen size={21} /><span>标签分组</span><ArrowUpRight size={17} /></div>
    <strong title={group.name}>{group.name}</strong>
    <span className="canvas-tag-count">{group.count} 个元素</span>
    <div className="canvas-tag-previews" aria-hidden="true">{group.previews.map((element) => <div className="canvas-tag-preview" key={element.id}>
      {element.kind === "image" ? <>{!compact && <img src={apiUrl(element.thumbnailUrl)} alt="" loading="lazy" draggable={false} onError={(event) => { event.currentTarget.hidden = true; }} />}<ImageIcon size={19} /></>
        : <>{element.kind === "video" ? <Video size={16} /> : <FileText size={16} />}{!compact && <p>{element.summary || element.video?.originalName}</p>}</>}
    </div>)}</div>
    
  </button>;
});
