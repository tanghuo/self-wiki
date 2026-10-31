import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import useWikiResource from "./useWikiResource.js";
import { apiUrl } from "./api.js";
import "./elementUsage.css";

function localTime(value) {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function ElementUsagePanel({ onClose }) {
  const [period, setPeriod] = useState("7"), [sort, setSort] = useState("total");
  const [now, setNow] = useState(Date.now);
  const [from, setFrom] = useState(() => localTime(Date.now() - 7 * 86400000));
  const [to, setTo] = useState(() => localTime(Date.now() + 60000));
  const start = period === "custom" ? new Date(from).getTime() : period === "all" ? 0
    : period === "today" ? new Date(now).setHours(0, 0, 0, 0) : now - Number(period) * 86400000;
  const end = period === "custom" ? new Date(to).getTime() : now + 1;
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < end;
  const result = useWikiResource(valid ? `/api/element-usage?${new URLSearchParams({ from: start, to: end, sort })}` : null, now);
  const data = result.data;
  return <DialogFrame bare title="内容使用统计" description="了解一段时间里常用的内容" className="wiki-dialog element-usage-dialog" closeLabel="关闭使用统计" onClose={onClose}
    footer={<><p className="wiki-muted">使用次数 = 引用次数 + 复制次数。展示前 50 条。复制成功、加入资料篮时记录；重复加入和恢复资料篮不计。时间按本地时区显示，自定义时段不含结束时刻。历史未记录的操作不补算；永久删除内容会清除其记录。</p></>}>
    <div className="element-usage-body">
      <div className="element-usage-filters">
        <label>时间范围<select aria-label="时间范围" value={period} onChange={(event) => { setPeriod(event.target.value); setNow(Date.now()); }}><option value="today">今天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="all">全部</option><option value="custom">自定义</option></select></label>
        <label>排序<select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="total">使用次数</option><option value="copy">复制次数</option><option value="reference">引用次数</option></select></label>
        <button className="text-button" onClick={() => setNow(Date.now())}><RefreshCw size={15} />刷新统计</button>
      </div>
      {period === "custom" && <div className="element-usage-filters"><label>开始时间<input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>结束时间<input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>}
      {!valid ? <p role="alert">请选择有效的起止时间，结束时间需晚于开始时间。</p> : result.loading ? <p role="status">正在读取统计…</p> : result.error ? <p role="alert">{result.error}</p> : data && <>
        <p className="element-usage-summary">{data.summary.elements} 条内容 · 使用 <strong>{data.summary.total}</strong> 次 · 复制 <strong>{data.summary.copies}</strong> 次 · 引用 <strong>{data.summary.references}</strong> 次</p>
        {!data.elements.length ? <p className="wiki-muted">这个时段还没有对应的使用记录。</p> : <div className="element-usage-table"><table aria-label="常用内容排行"><thead><tr><th>内容</th><th>复制</th><th>引用</th><th>使用次数</th><th>最近使用</th></tr></thead><tbody>{data.elements.map((element) => <tr key={element.id}>
          <td><div className="element-usage-content">{element.kind === "image" && !element.deletedAt && <img src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt="" />}<span title={element.label}>{element.label}<small>#{element.id}{element.deletedAt ? " · 回收站" : ""}</small></span></div></td><td>{element.copies}</td><td>{element.references}</td><td>{element.total}</td><td>{new Date(element.lastUsedAt).toLocaleString()}</td>
        </tr>)}</tbody></table></div>}
      </>}
    </div>
  </DialogFrame>;
}
