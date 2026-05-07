"use client";

import { useState } from "react";
import {
  HydrationBoundary,
  QueryClientProvider,
  type DehydratedState,
} from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { getBrowserQueryClient } from "@/lib/query/client";

interface QueryProviderProps {
  children: React.ReactNode;
  /** Optional dehydrated cache state from a server prefetch. */
  dehydratedState?: DehydratedState;
}

/**
 * Mounts the TanStack QueryClientProvider with the browser singleton and
 * the dev tools (development only). Pages that prefetch data on the server
 * pass their dehydrated state via {@link HydrationBoundary} below.
 *
 * @param props - Children and optional dehydrated state.
 * @returns Provider tree wrapping children.
 */
export function QueryProvider({ children, dehydratedState }: QueryProviderProps) {
  const [client] = useState(() => getBrowserQueryClient());
  return (
    <QueryClientProvider client={client}>
      <HydrationBoundary state={dehydratedState}>{children}</HydrationBoundary>
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
