import { relationPresets } from "../../shared/domain/elements.js";

export default function RelationFields({ value, onChange, disabled, nameLabel = "关系名称", currentLabel = "当前内容", targetLabel = "所选内容" }) {
  const { name = "", direction = "symmetric", reverseName = "" } = value;
  const directed = direction === "forward" || direction === "reverse";
  const preset = relationPresets.find((p) => p.name === name && p.reverseName === reverseName && (p.direction === direction || directed && p.direction === "forward"));
  return <div className="wiki-relation-fields">
    <label>关系类型<select aria-label="关系类型" disabled={disabled} value={preset?.label || "custom"} onChange={(event) => {
      const next = relationPresets.find((p) => p.label === event.target.value);
      onChange(next ? { name: next.name, direction: next.direction, reverseName: next.reverseName } : { name: "", direction: "symmetric", reverseName: "" });
    }}><option value="custom">自定义</option>{relationPresets.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}</select></label>
    <label>{nameLabel}<input aria-label={nameLabel} value={name} maxLength={60} disabled={disabled} onChange={(event) => onChange({ ...value, name: event.target.value })} placeholder="可留空，如：参考图" /></label>
    <label>关系方向<select aria-label="关系方向" disabled={disabled} value={direction} onChange={(event) => onChange({ ...value, direction: event.target.value, reverseName: event.target.value === "symmetric" ? "" : reverseName })}>
      <option value="symmetric">双向同名</option><option value="forward">当前内容 → 对方内容</option><option value="reverse">对方内容 → 当前内容</option>
      {direction === "unknown" && <option value="unknown">方向待确认</option>}
    </select></label>
    {directed && <><label>反向名称<input aria-label="反向名称" value={reverseName} maxLength={60} disabled={disabled} required onChange={(event) => onChange({ ...value, reverseName: event.target.value })} placeholder="例如：被参考" /></label>
      <button type="button" disabled={disabled} onClick={() => onChange({ ...value, direction: direction === "forward" ? "reverse" : "forward" })}>交换方向</button></>}
    <p className="wiki-muted" aria-label="关系预览">{direction === "unknown" ? "旧关联没有记录方向，请选择关系类型或确认方向。" : <>
      {currentLabel} — {direction === "reverse" ? reverseName || "反向名称" : name || "普通关联"} {directed ? "→" : "↔"} {targetLabel}
      {directed && <><br />{targetLabel} — {direction === "reverse" ? name || "正向名称" : reverseName || "反向名称"} → {currentLabel}</>}
    </>}</p>
  </div>;
}
