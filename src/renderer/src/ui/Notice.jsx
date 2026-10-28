import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

const icons = { info: Info, warn: AlertTriangle, bad: XCircle, good: CheckCircle2 };

// One-line notice under the page header. Features that are not set up yet use this with a text
// action ("去打开 →"), never a primary button.
export function Notice({ tone = "info", title, children, actions, role, className = "" }) {
  const Icon = icons[tone] || Info;
  return <div className={`ui-notice ${tone === "info" ? "" : `is-${tone}`} ${className}`.trim()} role={role || (tone === "bad" ? "alert" : "status")}>
    <Icon size={16} aria-hidden="true" />
    <div className="ui-notice-body">{title && <strong>{title}</strong>}{children}</div>
    {actions && <div className="ui-notice-actions">{actions}</div>}
  </div>;
}

// Icon block, one sentence of title, one sentence of how to start, at most one primary action.
export function EmptyState({ icon: Icon, title, children, actions, headingLevel = 2, className = "" }) {
  const Heading = `h${headingLevel}`;
  return <div className={`ui-empty ${className}`.trim()}>
    {Icon && <span className="ui-empty-icon" aria-hidden="true"><Icon size={26} /></span>}
    <Heading>{title}</Heading>
    {children && <p>{children}</p>}
    {actions && <div className="ui-empty-actions">{actions}</div>}
  </div>;
}
