import { ArrowLeft } from "lucide-react";

// One page header for every page: optional "← parent" above the title, title + one-line description,
// at most two secondary actions and one primary on the right (rightmost), optional tabs underneath.
export default function PageHeader({ title, subtitle, back, actions, tabs, className = "", titleProps }) {
  return <header className={`page-header ${className}`.trim()}>
    {back && <button type="button" className="text-button button-sm page-back" onClick={back.onClick} disabled={back.disabled} aria-label={back.ariaLabel || `返回${back.label}`}>
      <ArrowLeft size={14} aria-hidden="true" />{back.label}
    </button>}
    <div className="page-header-row">
      <div className="page-header-text"><h1 {...titleProps}>{title}</h1>{subtitle && <p className="page-header-sub">{subtitle}</p>}</div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
    {tabs}
  </header>;
}
