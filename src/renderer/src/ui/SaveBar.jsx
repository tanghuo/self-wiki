// The single save bar for settings that need an explicit save (connections and services).
// Appearance settings apply immediately and never use this.
export default function SaveBar({ dirtyCount = 0, dirtyLabels = [], busy = false, onSave, onDiscard, saveLabel = "保存", message, children }) {
  const dirty = dirtyCount > 0;
  return <div className="ui-save-bar" role="region" aria-label="保存设置">
    <span className={`ui-save-bar-status ${dirty ? "" : "is-idle"}`} role="status">{message || (dirty ? `${dirtyCount} 项改动未保存${dirtyLabels.length ? `：${dirtyLabels.join("、")}` : ""}` : "所有改动已保存")}</span>
    {dirty && <button type="button" className="text-button" disabled={busy} onClick={onDiscard}>放弃改动</button>}
    {children}
    <button type="button" className="primary" disabled={busy || !dirty} title={!dirty && !busy ? "没有需要保存的改动" : undefined} onClick={onSave}>{busy ? "正在保存…" : saveLabel}</button>
  </div>;
}
