// A list line: thumbnail, title, one muted line, actions on the right (shown on hover/focus on desktop).
export default function ListRow({ thumb, title, meta, actions, hoverActions = false, className = "", ...props }) {
  return <div className={`ui-list-row ${className}`.trim()} {...props}>
    {thumb}
    <div className="ui-list-row-text"><span className="ui-list-row-title">{title}</span>{meta && <span className="ui-list-row-meta">{meta}</span>}</div>
    {actions && <div className={`ui-list-row-actions ${hoverActions ? "is-hover" : ""}`.trim()}>{actions}</div>}
  </div>;
}
