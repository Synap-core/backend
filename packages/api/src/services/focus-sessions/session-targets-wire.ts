/**
 * The WIRE shape of a session's `targets` (`session-targets.ts`), with no
 * other import: every door (MCP, Hub, tRPC) declares it statically without
 * pulling the writer's graph into its own.
 */
import { z } from "zod";

/** At most this many targets per call (a batch, not a bulk import). */
export const SESSION_TARGETS_MAX = 100;

/** Entity ids, at most {@link SESSION_TARGETS_MAX}. */
export const sessionTargetsSchema = z
  .array(z.string().uuid())
  .max(SESSION_TARGETS_MAX);
