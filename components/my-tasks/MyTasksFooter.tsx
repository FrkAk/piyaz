"use client";

interface MyTasksFooterProps {
  shown: number;
  total: number;
}

export function MyTasksFooter({ shown, total }: MyTasksFooterProps) {
  return (
    <footer className="mt-1 border-t border-border/50 pt-3.5 pb-1.5 text-[11.5px] text-text-muted">
      Showing{" "}
      <span className="font-mono font-semibold tabular-nums text-text-primary">
        {shown}
      </span>{" "}
      of{" "}
      <span className="font-mono font-semibold tabular-nums text-text-primary">
        {total}
      </span>{" "}
      assigned
    </footer>
  );
}
