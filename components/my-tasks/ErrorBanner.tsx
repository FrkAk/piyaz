import type { MyTasksListFailureCode } from "@/lib/graph/queries";

const ERROR_COPY: Record<MyTasksListFailureCode, string> = {
  unauthorized: "You are not signed in. Refresh to sign back in.",
  rate_limited: "You are hitting the rate limit. Try again in a minute.",
  unknown: "Could not load your assigned tasks. Try reloading the page.",
};

interface ErrorBannerProps {
  code: MyTasksListFailureCode;
}

export function ErrorBanner({ code }: ErrorBannerProps) {
  return (
    <p
      role="alert"
      className="mb-3 rounded-md border border-border bg-surface-raised px-3 py-2 text-[12px] text-text-secondary"
    >
      {ERROR_COPY[code]}
    </p>
  );
}
