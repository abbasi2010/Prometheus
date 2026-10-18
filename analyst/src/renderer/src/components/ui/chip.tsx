import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Chip({ active, className, onClick, children }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  const classNames = cn(
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] transition-colors duration-150",
    active ? "border-accent bg-accent/10 text-accent" : "border-line text-muted",
    onClick && "hover:text-ink",
    className,
  );
  if (!onClick) return <span className={classNames}>{children}</span>;
  return (
    <button type="button" onClick={onClick} className={classNames}>
      {children}
    </button>
  );
}
