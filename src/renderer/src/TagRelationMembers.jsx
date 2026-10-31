import { relationLabel } from "../../shared/domain/elements.js";
import { useEffect, useState } from "react";
import { Tag } from "lucide-react";
import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import ElementCard from "./ElementCard.jsx";
import WikiPaging from "./WikiPaging.jsx";
import useWikiResource from "./useWikiResource.js";

export default function TagRelationMembers({ relation, revision, onClose, onOpen }) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const members = useWikiResource(`/api/tag-relations/${relation.id}/members?page=${page}&pageSize=12`, `${revision}:${retry}`);
  useEffect(() => {
    if (members.data && page > members.data.pagination.pageCount) setPage(members.data.pagination.pageCount);
  }, [members.data, page]);
  // × closes; the footer only pages (one close action per dialog).
  return <DialogFrame bare label={`标签内容：${relation.targetTag}`} title={<><Tag size={19} />#{relation.targetTag}</>} className="wiki-dialog wiki-tag-members" closeLabel="关闭标签内容" onClose={onClose}
    footer={members.data?.pagination?.pageCount > 1 ? <WikiPaging pagination={members.data?.pagination} onPage={setPage} disabled={members.loading} /> : undefined}>
    <div className="wiki-form-fields">
      <p className="wiki-muted">{`当前内容 — ${relationLabel({ ...relation, targetTag: undefined }, relation.sourceId)} — 以下成员`}；不包含当前内容自身。</p>
      {members.loading && <p className="wiki-muted" role="status">正在读取标签内容…</p>}
      {members.error && <p className="wiki-error" role="alert">{members.error}<button onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
      {members.data && <>
        <p className="wiki-muted">共 {members.data.pagination.total} 项</p>
        {members.data.elements.length === 0 && <div className="wiki-empty-inline">暂无成员，内容加入此标签后会自动显示。</div>}
        <div className="wiki-grid">{members.data.elements.map((element) => <ElementCard key={element.id} element={element} onOpen={onOpen} />)}</div>
      </>}
    </div>
  </DialogFrame>;
}
