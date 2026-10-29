/**
 * The wire half of a status move's HOLD and OCCURRED TIME (status-flow W4):
 * ONE zod shape every status door spreads into its input (tRPC, Hub tRPC and
 * REST, the bulk update), ONE JSON-schema pair the MCP tools spread into
 * theirs, and ONE pass-through. The rule itself lives in
 * `@synap-core/types/lifecycle` (`decideMoveHold`, `resolveOccurredAt`) and is
 * applied by the doors behind these inputs, never here: this only carries
 * what the mover said.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  HOLD_ON,
  OCCURRED_AT_MAX_PAST_DAYS,
  type Hold,
} from "@synap-core/types/lifecycle";

export const holdInputSchema = z
  .object({
    on: z.enum(HOLD_ON),
    ref: z.string().max(500).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    until: z
      .union([
        z.object({ date: z.string() }).strict(),
        z.object({ moves: z.string(), to: z.string().optional() }).strict(),
      ])
      .nullable()
      .optional(),
    reviewBy: z.string().nullable().optional(),
  })
  .strict();

/** Spread into a status door's zod input object. */
export const moveHoldInputShape = {
  /** What a move into a paused status waits on (an agent must say it). */
  hold: holdInputSchema.optional(),
  /** When the move really happened, if earlier (≤ 30 days back). */
  occurredAt: z.string().optional(),
};

/** `{ hold, occurredAt }` from a door's input, only the keys it carries. */
export function moveHoldArgs(input: {
  hold?: Hold | null;
  occurredAt?: string | null;
}): { hold?: Hold; occurredAt?: string } {
  return {
    ...(input.hold ? { hold: input.hold } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

/**
 * What an agent may say a pause waits on: every `on` but `unspecified`, the
 * default a person's pause records and an agent's is refused
 * (`decideMoveHold`).
 */
const AGENT_HOLD_ON = HOLD_ON.filter((on) => on !== "unspecified");

/** Spread into an MCP tool's `inputSchema.properties` (a status door). */
export const MOVE_HOLD_TOOL_PROPERTIES = {
  hold: {
    type: "object",
    description: `Required when the move pauses. Say what it waits on. on: ${AGENT_HOLD_ON.join(" | ")}. ref: who or what ('person:<id>', 'company:<id>', a label). reason: why. until: { date: ISO } resumes on that day; { moves: '<entity|track|focus_session>:<id>', to?: status or category } resumes when that thing moves. reviewBy: an ISO date to look again (14 days by default when nothing resumes it on a date). Leave it out when the move does not pause.`,
    properties: {
      on: { type: "string", enum: AGENT_HOLD_ON },
      ref: { type: ["string", "null"] },
      reason: { type: ["string", "null"] },
      until: { type: ["object", "null"] },
      reviewBy: { type: ["string", "null"] },
    },
    required: ["on"],
    additionalProperties: false,
  },
  occurredAt: {
    type: "string",
    description: `When the move really happened, if earlier than now (ISO date-time): at most ${OCCURRED_AT_MAX_PAST_DAYS} days back, never in the future. The move is recorded now and marked backdated.`,
  },
} as const;

/**
 * `{ hold, occurredAt }` from an MCP tool's raw args, shape-checked by the same
 * zod schema as the other doors (a malformed hold is refused, never dropped);
 * the rule itself is the door's.
 */
export function moveHoldToolArgs(args: Record<string, unknown>): {
  hold?: Hold;
  occurredAt?: string;
} {
  const parsed = z
    .object({
      hold: holdInputSchema.nullish(),
      occurredAt: z.string().nullish(),
    })
    .safeParse({ hold: args.hold, occurredAt: args.occurredAt });
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid hold or occurredAt: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    });
  }
  return moveHoldArgs(parsed.data);
}
