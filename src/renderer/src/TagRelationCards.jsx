import { relationLabel, elementLabel } from "../../shared/domain/elements.js";
import { ArrowUpRight, FileText, Video, Pencil, Tag, Unlink } from "lucide-react";
import { apiUrl } from "./api.js";

export default function TagRelationCards({ relations = [], busy, readOnly, onOpen, onRename, onRemove }) {
  return <>{relations.map((relation) => <div key={relation.id} className="wiki-tag-relation">
    <div className="wiki-relation-heading">{readOnly
      ? <p className="wiki-relation-label">{relationLabel(relation, relation.sourceId)}</p>
      : <button className="wiki-relation-label wiki-relation-rename text-button" disabled={busy} onClick={() => onRename(relation)} title="点击重命名" aria-label={`重命名标签关联：${relation.targetTag}：${relation.name || "普通关联"}`}><span>{relationLabel(relation, relation.sourceId)}</span><Pencil size={12} aria-hidden="true" /></button>}</div>
    <article className="wiki-card wiki-tag-card" aria-label={`标签关联：${relation.targetTag}：${relation.name || "普通关联"}`}>
      <button className="wiki-card-open" disabled={busy} onClick={() => onOpen(relation)} aria-label={`查看标签内容：${relation.targetTag}：${relation.name || "普通关联"}`}>
        <div className="wiki-tag-cover" data-count={relation.previews.length} aria-hidden="true">
          {relation.previews.length ? relation.previews.map((element) => element.kind === "image"
            ? <img key={element.id} src={apiUrl(`/api/elements/${element.id}/thumbnail`)} alt="" loading="lazy" />
            : <div className="wiki-tag-cover-text" key={element.id}>{element.kind === "video" ? <Video size={20} /> : <FileText size={20} />}<p>{elementLabel(element)}</p></div>)
            : <div className="wiki-tag-cover-empty"><Tag size={32} /><span>暂无成员</span></div>}
        </div>
        <div className="wiki-tag-card-info">
          <strong><Tag size={16} /><span>#{relation.targetTag}</span></strong>
          <p>{relation.name ? `当前内容作为该标签下内容的「${relation.name}」` : "当前内容关联该标签下的内容"}</p>
          <div><span>共 {relation.memberCount} 项</span><span>查看全部<ArrowUpRight size={14} /></span></div>
        </div>
      </button>
    </article>
    {!readOnly && <button className="wiki-unlink text-button" disabled={busy} onClick={() => onRemove(relation.id)} aria-label={`解除标签关联：${relation.targetTag}：${relation.name || "普通关联"}`}><Unlink size={13} />解除标签关联</button>}
  </div>)}</>;
}
