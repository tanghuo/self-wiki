import { ChevronLeft, ChevronRight } from "lucide-react";

export default function WikiPaging({ pagination, onPage, disabled }) {
  if (!pagination || pagination.pageCount <= 1) return null;
  return <nav className="wiki-paging" aria-label="内容分页">
    <button disabled={disabled || pagination.page <= 1} onClick={() => onPage(pagination.page - 1)} aria-label="上一页"><ChevronLeft size={17} /></button>
    <span>{pagination.page} / {pagination.pageCount}</span>
    <button disabled={disabled || pagination.page >= pagination.pageCount} onClick={() => onPage(pagination.page + 1)} aria-label="下一页"><ChevronRight size={17} /></button>
  </nav>;
}
