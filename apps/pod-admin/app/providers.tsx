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
import { trpc } from "../lib/trpc";

/**
 * Derive the pod backend URL at runtime so a docker build that didn't
 * pass `NEXT_PUBLIC_POD_URL` still works in production. The convention
 * is `pod-admin.<root>` for the operator console and `pod.<root>` for
 * the pod API + Kratos. When we're served at the former, swap the
 * hostname to the latter; same scheme, same TLS.
 *
 * Used to be: `process.env.NEXT_PUBLIC_POD_URL ?? window.location.origin`,
 * which baked `undefined` into the bundle if the build env was missing
 * and then sent every tRPC request to `pod-admin.X/trpc/...` — Next.js
 * 404s, not the pod backend. Surfaced as 404 HTML on every fetch with
 * `x-nextjs-prerender: 1` in the response.
 */
function derivePodUrlFromCurrentOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    if (u.hostname.startsWith("pod-admin.")) {
      const root = u.hostname.slice("pod-admin.".length);
      return `${u.protocol}//pod.${root}`;
    }
    // dev / non-pod-admin host: use as-is. Operators running `next dev`
    // on :4040 with the pod on :4000 still need NEXT_PUBLIC_POD_URL.
    return origin;
  } catch {
    return origin;
  }
}

const POD_URL =
  process.env.NEXT_PUBLIC_POD_URL ??
  (typeof window !== "undefined"
    ? derivePodUrlFromCurrentOrigin(window.location.origin)
    : "");

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
