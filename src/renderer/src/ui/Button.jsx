import { useId } from "react";
import { LoaderCircle } from "lucide-react";

// Four levels only. "secondary" is the plain look; "ghost" is a text button; "danger" is red text and
// "danger-solid" is reserved for the confirm button of a destructive dialog.
const variants = { primary: "primary", secondary: "", ghost: "text-button", danger: "danger-quiet", "danger-solid": "danger" };
const sizes = { sm: "button-sm", md: "", lg: "button-lg" };

export function buttonClass({ variant = "secondary", size = "md", iconOnly = false, className = "" } = {}) {
  if (!(variant in variants)) throw new Error(`Unknown button variant: ${variant}`);
  if (!(size in sizes)) throw new Error(`Unknown button size: ${size}`);
  return [variants[variant], sizes[size], iconOnly && "icon-only", className].filter(Boolean).join(" ");
}

// disabledReason is shown next to a disabled button so people know why it cannot be used.
export function Button({ variant, size, icon: Icon, busy = false, busyLabel, disabledReason, disabled, className, children, type = "button", ...props }) {
  const reasonId = useId();
  const showReason = Boolean(disabled && disabledReason);
  const button = <button type={type} className={buttonClass({ variant, size, className })} disabled={disabled || busy} aria-busy={busy || undefined}
    aria-describedby={showReason ? reasonId : props["aria-describedby"]} {...props}>
    {busy ? <LoaderCircle className="ui-button-busy spin" size={size === "sm" ? 14 : 16} aria-hidden="true" /> : Icon && <Icon size={size === "sm" ? 14 : 16} aria-hidden="true" />}
    {busy && busyLabel ? busyLabel : children}
  </button>;
  if (!showReason) return button;
  return <>{button}<span id={reasonId} className="ui-disabled-reason">{disabledReason}</span></>;
}

// Icon-only buttons always carry a name; the shortcut is part of the tooltip.
export function IconButton({ icon: Icon, label, shortcut, variant = "ghost", size = "md", className, type = "button", ...props }) {
  if (!label) throw new Error("IconButton needs a label");
  return <button type={type} className={buttonClass({ variant: variant === "ghost" ? "secondary" : variant, size, iconOnly: true, className })} aria-label={label}
    title={shortcut ? `${label} · ${shortcut}` : label} aria-keyshortcuts={props["aria-keyshortcuts"]} {...props}>
    <Icon size={size === "sm" ? 14 : 18} aria-hidden="true" />
  </button>;
}
