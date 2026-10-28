import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

// A styled single-choice dropdown that follows the ARIA combobox + listbox pattern.
// Focus stays on the trigger; arrow keys, Home/End, typeahead, Enter/Space and Escape work as in a native select.
// options: [{ value, label }]; onChange receives the chosen value.
export default function Select({ value, options, onChange, disabled, className = "", title, "aria-label": label, placement }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const index = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));
  const current = options.find((option) => String(option.value) === String(value)) || options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("focusin", close); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [open, active]);
  function show() {
    const rect = trigger.current?.getBoundingClientRect();
    const height = Math.min(320, options.length * 36 + 12);
    setUp(placement === "top" || Boolean(rect && rect.bottom + height + 8 > window.innerHeight && rect.top > height + 8));
    setActive(index);
    setOpen(true);
  }
  function choose(option) {
    setOpen(false);
    trigger.current?.focus();
    if (option && String(option.value) !== String(value)) onChange(option.value);
  }
  function keyDown(event) {
    const last = options.length - 1;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); return; }
      setActive((at) => event.key === "Home" ? 0 : event.key === "End" ? last : Math.min(last, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(options[active]); else show();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const found = options.findIndex((option) => String(option.label).toLowerCase().startsWith(typed.current.text));
      if (found < 0) return;
      if (open) setActive(found); else if (String(options[found].value) !== String(value)) onChange(options[found].value);
    }
  }
  return <div className={`ui-select ${className}`.trim()} ref={root}>
    <button ref={trigger} type="button" role="combobox" aria-label={label} title={title} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined} data-value={current ? String(current.value) : ""} disabled={disabled}
      onClick={() => open ? setOpen(false) : show()} onKeyDown={keyDown}>
      <span>{current?.label ?? ""}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <ul ref={list} id={`${id}-list`} role="listbox" aria-label={`${label}选项`} className="ui-select-list" data-placement={up ? "top" : "bottom"}>
      {options.map((option, at) => <li key={String(option.value)} id={`${id}-${at}`} role="option" data-index={at} data-value={String(option.value)} aria-selected={at === index}
        className={at === active ? "is-active" : undefined} onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActive(at)} onClick={() => choose(option)}>
        <span>{option.label}</span>{at === index && <Check size={14} aria-hidden="true" />}
      </li>)}
    </ul>}
  </div>;
}
