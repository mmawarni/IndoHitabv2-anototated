import type { KeyboardEvent, ReactNode } from "react";

// Enter moves focus to the next field marked [data-nav] in page order;
// Shift+Enter keeps its newline in textareas. Tab already follows the same order
// because the copy buttons are taken out of it.
export function focusNextField(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  const fields = Array.from(document.querySelectorAll<HTMLElement>("[data-nav]:not([disabled])"));
  fields[fields.indexOf(event.currentTarget) + 1]?.focus();
}

export function CopyButton({
  onCopy,
  disabled,
  children = "⧉ Copy",
}: {
  onCopy: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onCopy}
      disabled={disabled}
      title="Salin teks EN ke kolom terjemahan"
      className="shrink-0 rounded-md bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25"
    >
      {children}
    </button>
  );
}
