import { Trash2, X } from "lucide-react";
import Dialog from "../Dialog.jsx";

// Standard dialog frame: title (+ ×) · body · footer with status on the left and [取消] [具体动作] on the right.
// `onSubmit` wraps header/body/footer in one <form> so Enter and the footer's submit button share it.
// `bare` renders children without the padded .ui-dialog-body, for dialogs that bring their own body layout
// (pickers, previews); the header and footer are still the shared ones.
export function DialogFrame({ title, description, onClose, closeLabel, busy, footer, status, children, className = "", tone, icon, label, size, onSubmit, bare = false, onKeyDown, headerClassName = "", footerClassName = "" }) {
  const content = <>
    <header className={`ui-dialog-header ${headerClassName}`.trim()}>
      {icon && <span className={`ui-dialog-tone ${tone === "danger" ? "is-bad" : ""}`} aria-hidden="true">{icon}</span>}
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {closeLabel && <button type="button" className="icon-only" aria-label={closeLabel} disabled={busy} onClick={onClose}><X size={18} /></button>}
    </header>
    {children !== undefined && (bare ? children : <div className="ui-dialog-body">{children}</div>)}
    {(footer || status) && <footer className={`ui-dialog-footer ${footerClassName}`.trim()}>{status && <span className="ui-dialog-status" role="status">{status}</span>}{footer}</footer>}
  </>;
  return <Dialog open label={label || (typeof title === "string" ? title : undefined)} onKeyDown={onKeyDown} className={`ui-dialog ${tone === "danger" ? "is-danger" : ""} ${size === "wide" ? "is-wide" : ""} ${className}`.trim()} onClose={() => { if (!busy) onClose(); }}>
    {onSubmit ? <form className="ui-dialog-form" onSubmit={onSubmit}>{content}</form> : content}
  </Dialog>;
}

// Destructive confirmation: the title says the action and the count, the body says the consequence,
// the confirm button repeats the specific verb ("永久删除 3 项"), never "确定". Focus starts on 取消.
export default function ConfirmDialog({ title, children, confirmLabel, busyLabel = "正在处理…", cancelLabel = "取消", onConfirm, onCancel, busy = false, confirmDisabled = false, tone = "danger", label, extra }) {
  const danger = tone === "danger";
  return <DialogFrame title={title} label={label} tone={tone} busy={busy} onClose={onCancel} icon={danger ? <Trash2 size={18} /> : undefined}
    footer={<>
      <button type="button" autoFocus={!confirmDisabled} disabled={busy} onClick={onCancel}>{cancelLabel}</button>
      {extra}
      <button type="button" className={danger ? "danger" : "primary"} disabled={busy || confirmDisabled} onClick={onConfirm}>{danger && <Trash2 size={16} aria-hidden="true" />}{busy ? busyLabel : confirmLabel}</button>
    </>}>{children}</DialogFrame>;
}
