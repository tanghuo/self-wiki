import { MoreHorizontal } from "lucide-react";

// The "···" menu. Destructive items are always listed last, after a divider, in red.
export default function Menu({ label = "更多操作", items, size = "md", className = "", disabled, onKeyDown }) {
  const visible = items.filter(Boolean);
  const safe = visible.filter((item) => !item.danger), danger = visible.filter((item) => item.danger);
  function close(event) { event.currentTarget.closest("details").open = false; }
  return <details className={`library-menu ${size === "sm" ? "is-sm" : ""} ${className}`.trim()} onKeyDown={(event) => {
    if (event.key === "Escape" && event.currentTarget.open) { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
    onKeyDown?.(event);
  }}>
    <summary aria-label={label} title={label} aria-disabled={disabled || undefined} onClick={(event) => { if (disabled) event.preventDefault(); }}><MoreHorizontal size={size === "sm" ? 16 : 18} /></summary>
    <div className="menu-panel">
      {safe.map(({ key, label: text, icon: Icon, onSelect, disabled: off, ariaLabel }) => <button key={key || text} type="button" disabled={off} aria-label={ariaLabel} onClick={(event) => { close(event); onSelect(event); }}>{Icon && <Icon size={15} />}<span>{text}</span></button>)}
      {safe.length > 0 && danger.length > 0 && <hr />}
      {danger.map(({ key, label: text, icon: Icon, onSelect, disabled: off, ariaLabel }) => <button key={key || text} type="button" className="danger-quiet" disabled={off} aria-label={ariaLabel} onClick={(event) => { close(event); onSelect(event); }}>{Icon && <Icon size={15} />}<span>{text}</span></button>)}
    </div>
  </details>;
}
