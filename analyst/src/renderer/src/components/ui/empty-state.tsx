import { Button } from "./button";

export function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[8px] border border-dashed border-line px-4 py-6">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="max-w-[52ch] text-[13px] leading-5 text-muted">{body}</p>
      {action && onAction && <Button variant="outline" size="sm" onClick={onAction}>{action}</Button>}
    </div>
  );
}
