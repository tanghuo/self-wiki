// Tabs change what is shown; Segmented changes how the same thing is shown. Neither is a button style.
export function Tabs({ items, value, onChange, label, end, className = "" }) {
  return <div className={`ui-tabs ${className}`.trim()} role="tablist" aria-label={label}>
    {items.map((item) => <button key={item.value} type="button" role="tab" aria-selected={value === item.value} disabled={item.disabled} title={item.title}
      onClick={() => (item.onSelect ? item.onSelect() : onChange?.(item.value))}>
      {item.label}{item.count !== undefined && item.count !== null && <span className="ui-tab-count">{item.count}</span>}
    </button>)}
    {end && <div className="ui-tabs-end">{end}</div>}
  </div>;
}

export function Segmented({ items, value, onChange, label, disabled, className = "" }) {
  return <div className={`ui-segmented ${className}`.trim()} role="group" aria-label={label}>
    {items.map(({ value: key, label: text, icon: Icon, title, ariaLabel }) => <button key={key} type="button" aria-pressed={value === key} disabled={disabled}
      title={title} aria-label={ariaLabel} onClick={() => onChange(key)}>{Icon && <Icon size={14} aria-hidden="true" />}{text && <span>{text}</span>}</button>)}
  </div>;
}
