import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("rounded-[12px] border border-line bg-card p-4 transition-colors duration-150 hover:border-muted/50", className)} {...props} />;
}
