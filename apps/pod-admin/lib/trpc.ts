/**
 * tRPC React client — mirrors apps/admin-ui/src/lib/trpc.ts exactly.
 *
 * Pod Admin consumes the SAME tRPC AppRouter as admin-ui. Auth is the
 * pod's Kratos session cookie (sent via `credentials: "include"` in the
 * provider's fetch wrapper). Pod-admin operates pod-wide, so it never
 * sets the `X-Workspace-Id` header — every procedure it calls is either
 * `protectedProcedure` (any authenticated pod user) or `podAdminProcedure`
 * (must be admin/owner of the pod-admin workspace).
 */

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@synap-core/api-types";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Derive the pod API URL from the current browser origin.
 * pod-admin runs at `pod-admin.<root>` while the pod API lives at
 * `pod.<root>` — swap the subdomain so all fetch calls target the
 * right host. Falls back to origin as-is for local dev (non-pod-admin
 * hostnames), where NEXT_PUBLIC_POD_URL should be set explicitly.
 */
function derivePodUrl(): string {
  if (process.env.NEXT_PUBLIC_POD_URL) return process.env.NEXT_PUBLIC_POD_URL;
  if (typeof window === "undefined") return "";
  try {
    const u = new URL(window.location.origin);
    if (u.hostname.startsWith("pod-admin.")) {
      const root = u.hostname.slice("pod-admin.".length);
      return `${u.protocol}//pod.${root}`;
    }
  } catch {
    // ignore
  }
  return window.location.origin;
}

export const POD_URL = derivePodUrl();
