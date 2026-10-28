import { CheckCircle2, X } from "lucide-react";

// Bottom-centre, dark, short; may offer one undo action and a close button.
export function Toast({ children, action, onClose, closeLabel = "关闭提示", icon: Icon = CheckCircle2, as: Tag = "div", className = "", ...props }) {
  return <Tag className={`ui-toast ${className}`.trim()} role="status" {...props}>
    {Icon && <Icon size={16} aria-hidden="true" />}
    <span>{children}</span>
    {action}
    {onClose && <button type="button" className="icon-only button-sm" aria-label={closeLabel} onClick={onClose}><X size={14} /></button>}
  </Tag>;
}
