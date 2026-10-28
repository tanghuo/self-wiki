import { useId } from "react";

// One form row: label and a one-line help on the left (200px), control on the right; stacked on phones.
export default function Field({ label, help, error, layout = "row", children, htmlFor, className = "" }) {
  const helpId = useId();
  return <div className={`ui-field ${layout === "stack" ? "is-stack" : ""} ${className}`.trim()}>
    <div>
      {htmlFor ? <label className="ui-field-label" htmlFor={htmlFor}>{label}</label> : <div className="ui-field-label">{label}</div>}
      {help && <p className="ui-field-help" id={helpId}>{help}</p>}
    </div>
    <div className="ui-field-control">{children}{error && <p className="ui-field-error" role="alert">{error}</p>}</div>
  </div>;
}
