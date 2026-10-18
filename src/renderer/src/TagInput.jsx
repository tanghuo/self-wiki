import { useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { elementTags, maxElementTags, maxTagLength } from "../../shared/domain/elements.js";
import useWikiResource from "./useWikiResource.js";

export function readTagInput(value, existingTags = []) {
  return elementTags([...value.tags, ...value.draft.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean)], { existing: existingTags });
}

export default function TagInput({ value, onChange, disabled, label = "标签", existingTags = [] }) {
  const inputId = useId();
  const input = useRef(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const suggestions = useWikiResource("/api/tags", retry);
  function add() {
    try {
      const tags = readTagInput(value, existingTags);
      onChange({ tags, draft: "" }); setError("");
    }
    catch (failure) { setError(failure.message); }
  }
  return <div className="wiki-tag-input">
    <label htmlFor={inputId}>{label}</label>
    <div className="wiki-tag-field" data-disabled={disabled || undefined} onClick={(event) => { if (event.target === event.currentTarget) input.current?.focus(); }}>
      {value.tags.map((tag) => <span className="wiki-tag wiki-tag-token" key={tag}>
        <span>{tag}</span><button type="button" className="icon-only" disabled={disabled} aria-label={`移除标签：${tag}`} onClick={() => {
          onChange({ ...value, tags: value.tags.filter((name) => name !== tag) }); setError(""); input.current?.focus({ preventScroll: true });
        }}><X size={13} /></button>
      </span>)}
      <input ref={input} id={inputId} list={`${inputId}-suggestions`} value={value.draft} disabled={disabled} maxLength={maxTagLength * maxElementTags}
        aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ""}`} aria-invalid={Boolean(error)}
        placeholder={value.tags.length ? "继续输入…" : "输入标签，按回车确认"} onChange={(event) => { onChange({ ...value, draft: event.target.value }); setError(""); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (["Enter", ",", "，"].includes(event.key)) { event.preventDefault(); add(); }
        }} />
    </div>
    <datalist id={`${inputId}-suggestions`}>{suggestions.data?.tags.filter((name) => !value.tags.some((tag) => tag.toLowerCase() === name.toLowerCase())).map((name) => <option key={name} value={name} />)}
      {suggestions.data?.aliases?.map((a) => <option key={`alias:${a.alias}`} value={a.alias}>{a.name}</option>)}
    </datalist>
    <p id={`${inputId}-hint`} className="wiki-muted">{value.tags.length > maxElementTags
      ? `当前有 ${value.tags.length} 个历史标签，可保留或减少。添加新标签时总数须不超过 ${maxElementTags} 个。`
      : `按回车生成标签，继续输入可添加下一个。最多 ${maxElementTags} 个。`}</p>
    {error && <p id={`${inputId}-error`} className="wiki-error" role="alert">{error}</p>}
    {suggestions.error && <p className="wiki-muted">已有标签读取失败，仍可输入标签。<button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>重试读取标签</button></p>}
  </div>;
}
