import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { maxElementTags } from "../../shared/domain/elements.js";

export default function TagFilter({ tags, aliases = [], selected, onChange, match = "any", disabled }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const query = search.trim().toLowerCase();
  const names = [...new Set([...selected, ...tags])].filter((name) => name.toLowerCase().includes(query) || aliases.some((a) => a.name === name && a.alias.toLowerCase().includes(query)));
  return <div className="wiki-tag-filter" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} aria-label="按标签筛选" aria-expanded={open} disabled={disabled} onClick={() => { setOpen(!open); setSearch(""); }}>
      {selected.length ? `已选 ${selected.length} 个标签` : "全部标签"}<ChevronDown size={16} />
    </button>
    {open && <div className="wiki-tag-filter-menu" role="group" aria-label="标签筛选选项">
      <p>{match === "all" ? "同时包含所有所选标签" : "包含任意一个所选标签"}</p>
      <input aria-label="搜索标签" placeholder="搜索标签…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="wiki-tag-filter-options">{names.map((name) => <label key={name}>
        <input type="checkbox" checked={selected.includes(name)} disabled={disabled || (selected.length >= maxElementTags && !selected.includes(name))} onChange={() => onChange(selected.includes(name) ? selected.filter((tag) => tag !== name) : [...selected, name])} />
        <span>{name}</span>
      </label>)}{!names.length && <p>没有匹配的标签</p>}</div>
      <button disabled={!selected.length || disabled} onClick={() => onChange([])}>清空标签</button>
    </div>}
    {selected.length > 0 && <div className="wiki-tag-filter-selected">{selected.map((name) => <button key={name} disabled={disabled} aria-label={`取消筛选标签：${name}`} onClick={() => onChange(selected.filter((tag) => tag !== name))}>{name}<X size={12} /></button>)}</div>}
  </div>;
}
