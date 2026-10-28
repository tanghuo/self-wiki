import { BaseEdge } from "@xyflow/react";
import { Pencil } from "lucide-react";

export default function CanvasEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, style, label, data }) {
  const bend = Math.max(65, Math.abs(targetX - sourceX) * 0.45);
  const offset = data.offset || 0;
  const c1x = sourceX + (sourcePosition === "left" ? -bend : bend);
  const c2x = targetX + (targetPosition === "right" ? bend : -bend);
  const labelX = (sourceX + 3 * c1x + 3 * c2x + targetX) / 8;
  const labelY = (sourceY + targetY) / 2 + offset * 0.75;
  const text = label || (data.type === "title" ? "是标题" : "关联");
  const width = Math.min(240, Math.max(74, text.length * 11 + 34));
  return <>
    <BaseEdge id={id} path={`M ${sourceX},${sourceY} C ${c1x},${sourceY + offset} ${c2x},${targetY + offset} ${targetX},${targetY}`} markerStart={markerStart} markerEnd={markerEnd} style={style} interactionWidth={24}
      label={data.onRename ? undefined : label} labelX={labelX} labelY={labelY} labelStyle={{ fill: "var(--ink)", fontSize: 11 }} labelBgPadding={[7, 4]} labelBgBorderRadius={4} labelBgStyle={{ fill: "var(--panel)", fillOpacity: 0.96 }} />
    {data.onRename && <foreignObject className="react-flow__edge-textwrapper canvas-edge-editor" x={labelX - width / 2} y={labelY - 16} width={width} height={32}>
      <button className="canvas-edge-rename nodrag nopan" disabled={data.renameDisabled} title={`点击${data.relationIds?.length > 1 ? "批量" : ""}重命名：${text}`}
        aria-label={`${data.relationIds?.length > 1 ? "批量重命名关联" : "重命名关联"}：${text}`}
        onClick={(event) => { event.stopPropagation(); data.onRename(); }}><span>{text}</span><Pencil size={11} aria-hidden="true" /></button>
    </foreignObject>}
  </>;
}
