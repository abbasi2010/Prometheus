import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Tab({
  active,
  pinned,
  onSelect,
  onClose,
  children,
}: {
  active?: boolean;
  pinned?: boolean;
  onSelect: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-active={active ? "true" : "false"}
      title={typeof children === "string" ? children : undefined}
      onMouseDown={(event) => {
        if (event.button === 1 && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
      className={cn("group flex h-8 min-w-[92px] max-w-[200px] shrink-0 items-center gap-1 rounded-t-[8px] border border-b-0 px-2 text-[13px] transition-colors duration-150", active ? "border-line bg-card text-ink" : "border-transparent text-muted hover:text-ink")}
    >
      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={onSelect}>{children}</button>
      {!pinned && onClose && (
        <button type="button" className="rounded-[4px] p-0.5 hover:bg-black/10 dark:hover:bg-white/10" title="Close" onClick={onClose}>
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
