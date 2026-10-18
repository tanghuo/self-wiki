import { Fragment, useState } from "react";
import { Activity, ArrowDownWideNarrow, BarChart3, ChevronDown, Info, RefreshCw, X } from "lucide-react";
import Dialog from "./Dialog.jsx";
import useWikiResource from "./useWikiResource.js";
import "./tokenUsage.css";

const purposes = { chat: "Agent 对话", organization: "自动整理", "image-description": "图片描述", "embedding-index": "建立向量索引", "embedding-search": "向量检索", "embedding-probe": "向量连接检测" };
const states = { running: "进行中", completed: "完成", failed: "失败", interrupted: "中断" };
const number = (n) => n == null ? "—" : n.toLocaleString();
const uncached = (r) => r.input != null && r.cached != null && r.cached <= r.input ? r.input - r.cached : null;
const contextLabels = { jobId: "任务", elementId: "内容", round: "轮次", sessionId: "会话", turnId: "对话轮次", promptChars: "输入字符", imageCount: "图片", sourceCount: "引用内容", descriptionCount: "复用图片描述", toolCalls: "工具调用", toolOutputChars: "工具返回字符", segments: "分段" };

export default function TokenUsagePanel({ onClose }) {
  const [days, setDays] = useState(7), [revision, setRevision] = useState(0), [costly, setCostly] = useState(false);
  const { data, error, loading } = useWikiResource(`/api/token-usage?days=${days}`, revision);
  const summary = data?.summary;
  const [page, setPage] = useState(1), [expanded, setExpanded] = useState(null);
  const records = (costly ? data?.costly : data?.recent) || [];
  const pageCount = Math.max(1, Math.ceil(records.length / 10)), currentPage = Math.min(page, pageCount);
  const coverage = summary?.calls ? Math.round(summary.measured / summary.calls * 100) : null;
  return <Dialog open onClose={onClose} label="Token 用量" className="token-usage-dialog">
    <header className="usage-header">
      <div className="usage-title"><span className="usage-title-icon"><Activity size={20} /></span><div><h2>Token 用量</h2></div></div>
      <button className="usage-close" aria-label="关闭" onClick={onClose}><X size={19} /></button>
    </header>
    <div className="usage-body">
      <div className="usage-toolbar"><label>时间范围 <select value={days} onChange={(e) => { setDays(Number(e.target.value)); setPage(1); setExpanded(null); }}><option value={1}>最近 24 小时</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={0}>全部</option></select></label><button className="usage-refresh" onClick={() => setRevision((r) => r + 1)} disabled={loading}><RefreshCw size={14} />刷新</button></div>
      {error && <p className="usage-error" role="alert">{error}</p>}
      {loading && <p className="usage-loading" role="status">正在读取用量…</p>}
      {data && <>
        <div className="usage-metrics">
          <div className="usage-metric usage-metric-primary"><span>已知总用量</span><strong>{number(summary.calls ? summary.total : 0)}<small>tokens</small></strong><p>输入 {number(summary.calls ? summary.input : 0)}<i />输出 {number(summary.calls ? summary.output : 0)}</p></div>
          <div className="usage-metric"><span>调用次数</span><strong>{number(summary.calls)}<small>次</small></strong></div>
          <div className="usage-metric"><span>统计覆盖率</span><strong>{number(coverage)}{coverage !== null && <small>%</small>}</strong><p>{summary.calls ? `${summary.measured} 次有用量 · ${summary.calls - summary.measured} 次未知` : "等待首次调用"}</p></div>
        </div>
        <div className="usage-input-breakdown"><span>缓存输入 <b>{number(summary.calls ? summary.cached : 0)}</b></span><span>非缓存输入 <b>{number(summary.calls ? summary.uncached : 0)}</b></span><span>缓存归属未知 <b>{number(summary.calls ? summary.unsplitInput : 0)}</b></span></div>
        {!data.groups.length ? <section className="usage-empty"><span className="usage-empty-icon"><BarChart3 size={29} strokeWidth={1.4} /></span><h3>还没有用量数据</h3><p>还没有调用记录，使用 Agent 或语义索引后可在这里查看。</p></section> : <>
          <section className="usage-section"><div className="usage-section-heading"><h3>消耗分布</h3><span>按已知用量排序</span></div>
            <div className="usage-table-scroll"><table><thead><tr><th>用途 / 模型</th><th>消耗占比</th><th>调用 / 有用量</th><th>缓存输入</th><th>非缓存输入</th><th>输出<small>含推理</small></th><th>总量</th></tr></thead><tbody>
              {data.groups.map((g) => { const share = g.total != null && summary.total ? 100 * g.total / summary.total : null; return <tr key={`${g.purpose}:${g.model}`}>
                <td><b>{purposes[g.purpose] || g.purpose}</b><small>{g.model || "默认模型 · 名称未知"}</small></td><td><div className="usage-share"><span>{share === null ? "—" : `${share.toFixed(1)}%`}</span><div><i style={{ width: `${share ?? 0}%` }} /></div></div></td><td>{g.calls}<span className="usage-muted"> / {g.measured}</span></td><td>{number(g.cached)}</td><td>{number(g.uncached)}{g.unsplitInput > 0 && <small>另有 {number(g.unsplitInput)} 未区分</small>}</td><td>{number(g.output)}<small>推理 {number(g.reasoning)}</small></td><td><b>{number(g.total)}</b></td>
              </tr>; })}
            </tbody></table></div>
          </section>
          <section className="usage-section"><div className="usage-section-heading"><h3>调用明细 <small>每页 10 条 · 最多 100 条</small></h3><label className="usage-sort"><ArrowDownWideNarrow size={14} /><input type="checkbox" checked={costly} onChange={(e) => { setCostly(e.target.checked); setPage(1); setExpanded(null); }} />优先查看高消耗</label></div>
            <div className="usage-table-scroll usage-calls-table"><table aria-label="调用明细"><thead><tr><th>用途 / 时间</th><th>状态</th><th>缓存输入</th><th>非缓存输入</th><th>输出</th><th>总量</th><th>详情</th></tr></thead><tbody>
              {records.slice((currentPage - 1) * 10, currentPage * 10).map((r) => <Fragment key={r.id}>
                <tr className={expanded === r.id ? "usage-row-open" : ""}><td><b>{purposes[r.purpose] || r.purpose}</b><small>{new Date(r.started_at).toLocaleString()}</small></td><td><span className={`usage-state usage-state-${r.state}`}>{states[r.state]}</span></td><td>{number(r.cached)}</td><td>{number(uncached(r))}</td><td>{number(r.output)}</td><td><b>{number(r.total)}</b></td><td><button className="usage-row-toggle" aria-label={`查看${purposes[r.purpose] || r.purpose}调用详情`} aria-expanded={expanded === r.id} onClick={() => setExpanded(expanded === r.id ? null : r.id)}><ChevronDown size={15} /></button></td></tr>
                {expanded === r.id && <tr className="usage-detail-row"><td colSpan={7}><div className="usage-detail-grid"><span>模型<b>{r.model || "默认模型（名称未知）"}</b></span><span>耗时<b>{(r.elapsed_ms / 1000).toFixed(1)} 秒</b></span><span>输入总量<b>{number(r.input)}</b></span><span>缓存输入<b>{number(r.cached)}</b></span><span>非缓存输入<b>{number(uncached(r))}</b></span><span>输出 / 其中推理<b>{number(r.output)} / {number(r.reasoning)}</b></span></div><p className="usage-context">{Object.entries(r.context).filter(([, v]) => v != null).map(([k, v]) => `${contextLabels[k] || k}：${v}`).join(" · ")}</p></td></tr>}
              </Fragment>)}
            </tbody></table></div>
            <div className="usage-pagination"><span>{records.length ? `${(currentPage - 1) * 10 + 1}–${Math.min(currentPage * 10, records.length)} / ${records.length} 条` : "暂无记录"}</span><div><button disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); setExpanded(null); }}>上一页</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage === pageCount} onClick={() => { setPage(currentPage + 1); setExpanded(null); }}>下一页</button></div></div>
          </section>
          <p className="usage-coverage">{summary.calls} 次调用 · {summary.measured} 次有用量 · {summary.calls - summary.measured} 次未知</p>
        </>}
      </>}
    </div>
    <footer className="usage-footer"><details><summary><Info size={14} />统计说明<ChevronDown size={13} /></summary><p>从接入统计后开始记录。未知用量显示为「—」，不计入总数。非缓存输入逐次按「输入 − 缓存输入」计算后汇总；缺少缓存计数的输入列为「缓存归属未知」，不会当作非缓存。缓存只拆分输入，输出单列，推理包含在输出中，不重复相加。输入字符、图片数量和工具次数用于辅助定位，不等同于 token 数，也不包含模型内部历史上下文。</p></details></footer>
  </Dialog>;
}
