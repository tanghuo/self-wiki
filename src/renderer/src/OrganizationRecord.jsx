import { useState } from "react";
import { ChevronDown, FileText, ImageIcon } from "lucide-react";
import { apiUrl } from "./api.js";
import useWikiResource from "./useWikiResource.js";
import { elementLabel, elementKindLabels } from "../../shared/domain/elements.js";

const changeLabels = { applied: "已添加", suggested: "待确认", corrected: "已修正", rejected: "已移除或拒绝", existing: "已存在" };

export default function OrganizationRecord({ record, expanded, onToggle, locked, onOpen, children }) {
  const { data: element, error, loading } = useWikiResource(`/api/elements/${record.elementId}`);
  const [imageFailed, setImageFailed] = useState(false);
  const title = element ? elementLabel(element) : loading ? "正在读取内容…" : "原内容暂不可用";
  const image = element?.kind === "image";
  const changes = Object.entries(changeLabels).flatMap(([state, label]) => {
    const actions = record.actions.filter((action) => action.state === state);
    if (!actions.length) return [];
    const tags = actions.filter((action) => action.kind === "tag").length, relations = actions.length - tags;
    return [`${label}${[tags && `${tags} 个标签`, relations && `${relations} 条关联`].filter(Boolean).join("、")}`];
  });
  return <article className="organization-result" id={`organization-result-${record.id}`}>
    <button className="organization-record-toggle" onClick={onToggle} disabled={locked} aria-expanded={expanded} aria-controls={`organization-details-${record.id}`} aria-label={`查看整理详情：${title}`}>
      <span className="organization-record-preview" aria-hidden="true">
        {image && !imageFailed && !element.deletedAt ? <img src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt="" loading="lazy" onError={() => setImageFailed(true)} /> : image ? <ImageIcon size={24} /> : <FileText size={24} />}
      </span>
      <span className="organization-record-overview">
        <span className="organization-record-meta">{element ? elementKindLabels[element.kind] : "内容"} · {new Date(record.createdAt).toLocaleString("zh-CN")}</span>
        <strong className="organization-record-title">{title}</strong>
        <span className="organization-record-summary">{record.summary || "本次没有补充说明"}</span>
        <span className="organization-record-changes">{record.undone ? "本次整理已撤销" : changes.join(" · ") || "没有需要添加的标签或关联"}</span>
      </span>
      <ChevronDown size={18} className="organization-record-chevron" aria-hidden="true" />
    </button>
    {expanded && <div className="organization-record-details" id={`organization-details-${record.id}`}>
      {onOpen && element && !element.deletedAt && <button className="text-button" disabled={locked} onClick={() => onOpen(record.elementId)}>打开内容</button>}
      {(error || element?.deletedAt) && <p className="wiki-muted">原内容暂不可用，仍可查看这次整理的记录。</p>}
      {children}
    </div>}
  </article>;
}
