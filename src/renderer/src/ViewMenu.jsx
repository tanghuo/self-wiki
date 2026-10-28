import { useEffect, useRef, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

// Toolbar popover for secondary view options. Closes on outside pointer or focus, and on Escape.
export default function ViewMenu({ label = "视图", changed = false, disabled, children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("focusin", close); };
  }, [open]);
  return <div className="wiki-view-menu" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="wiki-view-menu-trigger" aria-expanded={open} aria-haspopup="true" disabled={disabled} data-changed={changed || undefined} onClick={() => setOpen(!open)}>
      <SlidersHorizontal size={16} aria-hidden="true" /><span>{label}</span>{changed && <i aria-hidden="true" />}<ChevronDown size={14} aria-hidden="true" />
    </button>
    <div className="wiki-view-menu-panel" role="group" aria-label="视图选项" hidden={!open}>{children}</div>
  </div>;
}
