"use client";

/**
 * Pod Admin providers — HeroUI + theme + tRPC + react-query.
 *
 * The tRPC client is identical in shape to admin-ui's: same `@synap-core/api-types`
 * AppRouter, same `superjson` transformer, same `credentials: "include"` so the
 * Kratos session cookie is sent to the pod tRPC endpoint. The only difference
 * is workspace context: pod-admin doesn't pin a workspace globally — pod-level
 * routes (`podAdminProcedure`) don't need an X-Workspace-Id header.
 */

import { useState, type ReactNode } from "react";
import { HeroUIProvider, ToastProvider } from "@heroui/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import SuperJSON from "superjson";
import { trpc, POD_URL } from "../lib/trpc";

export function Providers({ children }: { children: ReactNode }) {
  // QueryClient + tRPC client created once per mount — `useState` keeps
  // them stable across re-renders without using a ref.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${POD_URL}/trpc`,
          transformer: SuperJSON,
          fetch(url, options) {
            return fetch(url, { ...options, credentials: "include" });
          },
        }),
      ],
    })
  );

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <HeroUIProvider>
        <ToastProvider
          placement="bottom-right"
          toastProps={{
            timeout: 4000,
            shouldShowTimeoutProgress: true,
            variant: "flat",
            radius: "md",
          }}
        />
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </trpc.Provider>
      </HeroUIProvider>
    </NextThemesProvider>
  );
}
