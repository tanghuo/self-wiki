// Search on the left, filters next to it, view options and "···" at the end.
export default function Toolbar({ children, end, className = "", ...props }) {
  return <div className={`ui-toolbar ${className}`.trim()} {...props}>{children}{end && <div className="ui-toolbar-end">{end}</div>}</div>;
}
