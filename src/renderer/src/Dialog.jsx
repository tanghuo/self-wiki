import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function Dialog({ open, onClose, label, className = "", children, onKeyDown }) {
  const dialogRef = useRef(null);
  const backdropPress = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open) return;

    const previousFocus = document.activeElement;
    dialog.showModal();

    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  function isBackdrop(event) {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom;
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`dialog ${className}`.trim()}
      aria-label={label}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => { backdropPress.current = isBackdrop(event); }}
      onClick={(event) => {
        if (backdropPress.current && isBackdrop(event)) onClose();
        backdropPress.current = false;
      }}
    >
      {children}
    </dialog>,
    document.body,
  );
}
