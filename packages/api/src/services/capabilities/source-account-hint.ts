/**
 * A SOURCE connection's account hint: a connection-registry row that names
 * something the pod reads (`storybook:<repo|url>`) and holds no secret. Only
 * `addSourceConnection` (capability-connections.ts) writes such a hint; the
 * credential doors refuse it, so a row carrying a secret never reads as a
 * source. Its own module so the Nango reconciler can read it without an import
 * cycle.
 */
import { STORYBOOK_PROVIDER } from "@synap-core/types/storybook";

export const SOURCE_ACCOUNT_HINT_PREFIXES: readonly string[] = [
  `${STORYBOOK_PROVIDER}:`,
];

export function isSourceAccountHint(hint: string | null | undefined): boolean {
  return (
    typeof hint === "string" &&
    SOURCE_ACCOUNT_HINT_PREFIXES.some((p) => hint.startsWith(p))
  );
}
