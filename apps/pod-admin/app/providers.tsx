"use client";

/**
 * Pod Admin providers — HeroUI + theme + tRPC + react-query.
 *
 * The tRPC client is identical in shape to admin-ui's: same `@synap-core/api-types`
 * AppRouter, same `superjson` transformer, same `credentials: "include"` so the
 * Kratos session cookie is sent to the pod tRPC endpoint. The only difference
 * is workspace context: pod-admin doesn't pin a workspace globally — pod-level
 * routes (`podAdminProcedure`) don't need an X-Workspace-Id header, and the
 * rare call that acts in one space names it per call (see the split link).
 */

import { useEffect, useState, type ReactNode } from "react";
import { HeroUIProvider, ToastProvider } from "@heroui/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, splitLink } from "@trpc/client";
import SuperJSON from "superjson";
import { trpc, POD_URL } from "../lib/trpc";
import {
  indexedDbQueryCacheStore,
  keepQueryCache,
  QUERY_CACHE_BUSTER,
} from "../lib/query-persist";
import { ConsoleLocaleProvider } from "../lib/i18n/locale-provider";
import { PresenceProvider } from "./_lib/presence/presence-provider";

export function Providers({
  children,
  identityId,
}: {
  children: ReactNode;
  /**
   * The signed-in identity, from the proxy's `x-pod-admin-id` (null on the
   * pages the proxy does not gate: sign-in, recovery, setup). Keys the query
   * cache kept in this browser; with none, nothing is kept.
   */
  identityId: string | null;
}) {
  // QueryClient + tRPC client created once per mount — `useState` keeps
  // them stable across re-renders without using a ref.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // These mirror `QUERY_CACHE_DEFAULTS` in `@synap-core/sdk`
          // (synap-app). Pod admin cannot import synap-app packages, so it
          // keeps a copy: change both together. gcTime outlives staleTime so a
          // page opened again within 30 min draws at once and refetches.
          queries: {
            staleTime: 60_000,
            gcTime: 30 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  const [trpcClient] = useState(() => {
    const transport = {
      url: `${POD_URL}/trpc`,
      transformer: SuperJSON,
      fetch(url: URL | RequestInfo, options?: RequestInit) {
        return fetch(url, { ...options, credentials: "include" });
      },
    };
    return trpc.createClient({
      links: [
        // Pod-wide by default (no header). A call that must act IN one space —
        // a `workspaceProcedure` such as `profiles.proposeRetire` — names it
        // per call (`{ context: { workspaceId } }`) and goes unbatched, so the
        // header can never leak onto a pod-wide call in the same batch.
        splitLink({
          condition: (op) => typeof op.context.workspaceId === "string",
          true: httpLink({
            ...transport,
            headers: ({ op }) => ({
              "X-Workspace-Id": op.context.workspaceId as string,
            }),
          }),
          // The pod refuses a batch over `TRPC_MAX_BATCH_SIZE` (200) whole
          // (packages/api middleware/trpc-refusal.ts); the console stays
          // well under it.
          false: httpBatchLink({ ...transport, maxItems: 50 }),
        }),
      ],
    });
  });

  // What this browser kept for this identity comes back, then stays current
  // (`lib/query-persist.ts`). Pages do not wait for it.
  useEffect(() => {
    const store = identityId ? indexedDbQueryCacheStore() : null;
    if (!identityId || !store) return;
    return keepQueryCache(queryClient, store, {
      identityId,
      buster: QUERY_CACHE_BUSTER,
    });
  }, [queryClient, identityId]);

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {/* Every field's label sits above it, never inside: what you type
          has the whole field, and a long label cannot overlap it. */}
      <HeroUIProvider labelPlacement="outside-top" reducedMotion="user">
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            {/* The ONE proof-of-presence dialog (W3): every approve door asks
                through it when the pod wants the person in person. Around the
                toasts too: a toast's Resume approves. */}
            <PresenceProvider>
              {/* Inside the tRPC + query providers: a toast's content may read
                the pod (the large-approval toast polls its own progress —
                app/_lib/approval-progress). */}
              <ToastProvider
                placement="bottom-right"
                toastProps={{
                  timeout: 4000,
                  shouldShowTimeoutProgress: true,
                  variant: "flat",
                  radius: "md",
                }}
              />
              {/* The person's language, once (rule i18n §4). */}
              <ConsoleLocaleProvider>{children}</ConsoleLocaleProvider>
            </PresenceProvider>
          </QueryClientProvider>
        </trpc.Provider>
      </HeroUIProvider>
    </NextThemesProvider>
  );
}
