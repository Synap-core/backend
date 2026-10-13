/**
 * Wire shapes of the pod's `marketplace.*` door, read off the generated
 * `AppRouter` — never re-declared here, so a change on the pod is a type error
 * in the console rather than a field that silently reads `undefined`.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";

type Marketplace = inferRouterOutputs<AppRouter>["marketplace"];

export type CatalogList = Marketplace["list"];
export type CatalogEntry = CatalogList["entries"][number];
export type CatalogSource = CatalogList["sources"][number];
export type CatalogDetail = Marketplace["get"];
export type MarketPreflight = Marketplace["preflight"];
/** The template-only workspace plan (`preflightWorkspaceFromDefinition`). */
export type PreflightReport = NonNullable<MarketPreflight["report"]>;
export type InstallOutcome = Marketplace["install"];
