import React, { useEffect, useRef } from 'react';

function canReceiveFocus(element) {
  return element?.isConnected && typeof element.focus === 'function'
    && element !== element.ownerDocument.body
    && element !== element.ownerDocument.documentElement
    && !element.closest('[inert], [hidden], [aria-hidden="true"]')
    && !element.matches(':disabled, [aria-disabled="true"]')
    && element.getClientRects().length > 0;
}

export function WorkoutResultDialog({ children, labelledBy, describedBy, restoreFocusRef }) {
  const dialogRef = useRef(null);
  const restoreRef = useRef(restoreFocusRef);
  restoreRef.current = restoreFocusRef;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = dialog.ownerDocument.activeElement;
    dialog.showModal();

    return () => {
      dialog.close();
      // Wait until React has removed the result and revealed the camera controls.
      queueMicrotask(() => {
        // A Strict Mode effect replay may already have reopened this dialog.
        if (dialog.open) return;
        const fallback = [...(restoreRef.current?.current?.querySelectorAll('.button, a[href]') ?? [])]
          .find((element) => element.tabIndex >= 0 && canReceiveFocus(element));
        const target = canReceiveFocus(previousFocus) ? previousFocus : fallback;
        target?.focus({ preventScroll: true });
      });
    };
  }, []);

  return <dialog ref={dialogRef} className="level-result-backdrop"
    aria-labelledby={labelledBy} aria-describedby={describedBy}
    onCancel={(event) => event.preventDefault()}>
    {children}
  </dialog>;
}
