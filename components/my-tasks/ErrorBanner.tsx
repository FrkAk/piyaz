import type { MyTasksListFailureCode } from "@/lib/graph/queries";

const ERROR_COPY: Record<MyTasksListFailureCode, string> = {
  unauthorized: "You are not signed in. Refresh to sign back in.",
  rate_limited: "You are hitting the rate limit. Try again in a minute.",
  unknown: "Could not load your assigned tasks. Try reloading the page.",
};

interface ErrorBannerProps {
  /** Failure code from the SSR prefetch or a client refetch. */
  code: MyTasksListFailureCode;
}

/**
 * Inline failure banner above the header. Surfaces RSC-prefetch failures
 * and TanStack Query refetch errors with the same copy table so the user
 * sees a consistent message regardless of which path failed.
 *
 * @param props - Failure code.
 * @returns Banner element.
 */
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
