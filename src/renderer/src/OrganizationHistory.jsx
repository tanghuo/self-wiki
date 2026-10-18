import { relationLabel } from "../../shared/domain/elements.js";
import { useState } from "react";
import OrganizationRecord from "./OrganizationRecord.jsx";

const actionLabels = { suggested: "建议", applied: "已添加", rejected: "已移除或拒绝", existing: "已存在", corrected: "已修正" };

export default function OrganizationHistory({ results, locked, mutate, initialExpandedId, onOpen }) {
  const [selected, setSelected] = useState([]), [name, setName] = useState("");
  const [expanded, setExpanded] = useState(initialExpandedId ? [initialExpandedId] : []), [managing, setManaging] = useState(false);
  const available = results.flatMap((r) => r.undone ? [] : r.actions.flatMap((a, index) => a.state === "applied" && a.editable ? [{ resultId: r.id, index, kind: a.kind }] : []));
  const key = (item) => `${item.resultId}:${item.index}`;
  const choices = available.filter((item) => selected.includes(key(item)));
  async function correct(operation) {
    const result = await mutate("correct", { operation, name, selections: choices.map(({ resultId, index }) => ({ resultId, index })) });
    if (result) { setSelected([]); setName(""); }
  }
  return <div className="organization-history" aria-label="整理记录">
    {results.length > 0 && <div className="organization-history-toolbar"><p className="wiki-muted">展开记录查看依据、确认建议或撤销。</p>
      {(managing || available.length > 0) && <button className="text-button" disabled={locked} aria-pressed={managing} onClick={() => {
        setManaging(!managing); setSelected([]); setName("");
        if (!managing) setExpanded([...new Set([...expanded, ...available.map((item) => item.resultId)])]);
      }}>{managing ? "退出批量修正" : "批量修正"}</button>}
    </div>}
    {managing && available.length > 0 && <div className="organization-batch wiki-form-fields">
      <p className="wiki-muted">仅修改所选标签或关联；人工修改过的项会保留。</p>
      <div className="wiki-actions"><button disabled={locked} onClick={() => setSelected(choices.length === available.length ? [] : available.slice(0, 100).map(key))}>{choices.length === available.length ? "取消全选" : "选择本页可修改项"}</button><span>已选 {choices.length} 项</span>
        <button disabled={locked || !choices.length} onClick={() => correct("remove")}>移除所选</button></div>
      <label>替换为<input value={name} maxLength={60} disabled={locked} placeholder="标签或关联的新名称" onChange={(e) => setName(e.target.value)} /></label>
      <button disabled={locked || !choices.length || !name.trim() || new Set(choices.map((a) => a.kind)).size !== 1} onClick={() => correct("replace")}>替换所选名称</button>
      {new Set(choices.map((a) => a.kind)).size > 1 && <p className="wiki-muted">替换时请分别选择标签或关联。</p>}
    </div>}
    {!results.length && <p className="wiki-muted">暂无整理记录。</p>}
    {results.map((r) => <OrganizationRecord record={r} key={r.id} expanded={expanded.includes(r.id)} locked={locked} onOpen={onOpen}
      onToggle={() => setExpanded((current) => current.includes(r.id) ? current.filter((id) => id !== r.id) : [...current, r.id])}>
      {!r.tracked && <p className="wiki-muted">旧记录未跟踪逐项来源，仅支持原有的整次撤销。</p>}
      {!r.actions.length && <p className="wiki-muted">没有需要添加的标签或关联。</p>}
      {r.actions.map((a, index) => <div className="organization-action" key={index}>
        <div className="organization-action-title">
          {managing && !r.undone && a.state === "applied" && a.editable && <input type="checkbox" aria-label={`选择整理 ${r.id} 的${a.kind === "tag" ? "标签" : "关联"}：${a.name}`} disabled={locked} checked={selected.includes(key({ resultId: r.id, index }))} onChange={(e) => setSelected((s) => e.target.checked ? [...s, key({ resultId: r.id, index })].slice(0, 100) : s.filter((k) => k !== key({ resultId: r.id, index })))} />}
          <strong>{a.kind === "tag" ? `#${a.name}` : `${relationLabel({ ...a, sourceId: r.elementId }, r.elementId)} · 内容 #${a.targetId}`}</strong> <span className="wiki-muted">{actionLabels[a.state]}{a.correction && ` → ${a.correction}`}{r.tracked && a.state === "applied" && !a.editable && " · 已修改或移除"}</span>
        </div>
        <p className="wiki-muted">{a.evidence.reason}{a.note && ` · ${a.note}`}</p>
        {a.evidence.quote && <blockquote>{a.evidence.quote}</blockquote>}
        {!r.undone && a.state === "suggested" && <div className="wiki-actions"><button disabled={locked} onClick={() => mutate(`results/${r.id}/accept`, { indices: [index] })}>接受</button><button disabled={locked} onClick={() => mutate(`results/${r.id}/reject`, { indices: [index] })}>拒绝</button></div>}
      </div>)}
      {!r.undone && r.actions.some((a) => a.state === "applied") && <button disabled={locked} onClick={() => mutate(`results/${r.id}/undo`)}>撤销本次整理</button>}
      {r.undone && <p className="wiki-muted">本次整理已撤销，撤销的动作不会自动加回。</p>}
    </OrganizationRecord>)}
  </div>;
}
