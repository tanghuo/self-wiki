import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import ElementCard from "./ElementCard.jsx";
import WikiGrid from "./WikiGrid.jsx";
import useWikiList from "./useWikiList.js";

export default function MediaStackDialog({ id, revision, readOnly = false, onClose, onOpen }) {
  const list = useWikiList(`/api/elements?scope=library&stackOf=${id}`, revision, 0, true);
  return <DialogFrame label="相似堆叠" title={`相似堆叠${list.data ? ` · ${list.data.pagination.total} 项` : ""}`} className="wiki-dialog wiki-stack-dialog" closeLabel="关闭相似堆叠" onClose={onClose}
    description={list.data?.elements[0]?.kind === "text"
      ? readOnly ? "显示整组文字，按最近更新排列。" : "显示整组文字，按使用次数从多到少排列；同次数按最近更新排列。"
      : "显示整组图片和视频，按添加时间从新到旧排列。"}>
    {list.error && <p className="wiki-error" role="alert">{list.error}<button onClick={list.retry}>重试</button></p>}
    <WikiGrid masonry cardWidth={240}>{list.data?.elements.map((element, index) =>
      <ElementCard key={element.id} element={element} loading={index < 8 ? "eager" : "lazy"} onOpen={onOpen} />)}</WikiGrid>
    <div className="wiki-load-more" ref={list.sentinel}>
      {list.loading ? <span role="status">正在读取堆叠内容…</span> : list.hasMore ? <button onClick={list.error ? list.retry : list.loadMore}>加载更多</button> : null}
    </div>
  </DialogFrame>;
}
