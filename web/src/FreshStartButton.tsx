import { useEffect, useState, type ReactElement } from "react";

const CONFIRM_WINDOW_MS = 4000;

/** Starts a new conversation on a second click; the first click only asks, since it stops all running work. */
export const FreshStartButton = ({
  onConfirm,
  disabled,
}: {
  onConfirm: () => void;
  disabled: boolean;
}): ReactElement => {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);

    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      className="piet-fresh-start"
      type="button"
      data-armed={armed}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={() => {
        if (armed) onConfirm();
        setArmed(!armed);
      }}
      aria-label={armed ? "Confirm fresh start" : "Start fresh"}
      title="Stop all work and start a new conversation. The canvas stays."
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2.5" />
      </svg>
      {armed ? "Start fresh?" : "New"}
    </button>
  );
};
