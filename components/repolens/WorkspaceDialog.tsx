import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Native modal semantics keep keyboard focus inside and return it on close. */
export function WorkspaceDialog({ children, onDismiss, ...props }: { children: ReactNode; onDismiss: () => void; className?: string; "aria-label"?: string; "aria-labelledby"?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const origin = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (origin instanceof HTMLElement && origin.isConnected) origin.focus(); };
  }, []);
  return <dialog {...props} ref={ref} onCancel={(event) => { event.preventDefault(); onDismiss(); }}>{children}</dialog>;
}
