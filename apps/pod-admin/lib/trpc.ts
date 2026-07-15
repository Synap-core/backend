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
import { publicPodUrl } from "./public-pod-url";

export const trpc = createTRPCReact<AppRouter>();

export const POD_URL = publicPodUrl();
