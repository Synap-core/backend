import { TRPCError } from "@trpc/server";
import { z } from "zod";

const definitionCursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

const runGroupCursorSchema = definitionCursorSchema.extend({
  flowType: z.enum(["automation", "playbook"]),
});

/**
 * One run in the merged cross-flow feed (`runs.list`). The id is a STRING, not a
 * uuid: capture / capability / agent-write runs are keyed by their
 * correlationId, which is not guaranteed to be one.
 */
const runCursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  flowType: z.enum([
    "automation",
    "playbook",
    "capture",
    "capability",
    "session",
    "chat",
    "agent_write",
  ]),
  id: z.string().min(1),
});

export type DefinitionCursor = z.infer<typeof definitionCursorSchema>;
export type RunGroupCursor = z.infer<typeof runGroupCursorSchema>;
export type RunCursor = z.infer<typeof runCursorSchema>;

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    return schema.parse(parsed);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid pagination cursor",
    });
  }
}

export function encodeDefinitionCursor(input: {
  at: Date;
  id: string;
}): string {
  return encode({ at: input.at.toISOString(), id: input.id });
}

export function decodeDefinitionCursor(cursor: string): DefinitionCursor {
  return decode(cursor, definitionCursorSchema);
}

export function encodeRunGroupCursor(input: {
  at: Date;
  flowType: "automation" | "playbook";
  id: string;
}): string {
  return encode({
    at: input.at.toISOString(),
    flowType: input.flowType,
    id: input.id,
  });
}

export function decodeRunGroupCursor(cursor: string): RunGroupCursor {
  return decode(cursor, runGroupCursorSchema);
}

export function encodeRunCursor(input: {
  at: Date;
  flowType: RunCursor["flowType"];
  id: string;
}): string {
  return encode({
    at: input.at.toISOString(),
    flowType: input.flowType,
    id: input.id,
  });
}

export function decodeRunCursor(cursor: string): RunCursor {
  return decode(cursor, runCursorSchema);
}

/**
 * An `{at, id}` cursor whose `at` is the row's instant at MICROSECOND
 * precision (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, formatted by SQL). For a keyset
 * over a `defaultNow()` column: a JS `Date` keeps milliseconds only, so a
 * Date cursor would skip or repeat the rows of one millisecond.
 */
const INSTANT_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

const instantCursorSchema = z.object({
  at: z
    .string()
    // A real calendar instant (JS rolls 2026-02-30 over; Postgres refuses it).
    .refine((at) => {
      const m = INSTANT_AT.exec(at);
      if (!m) return false;
      const d = new Date(`${at.slice(0, 19)}Z`);
      return (
        !Number.isNaN(d.getTime()) &&
        d.toISOString().slice(0, 19) === at.slice(0, 19)
      );
    }),
  id: z.string().uuid(),
});

export type InstantCursor = z.infer<typeof instantCursorSchema>;

/** SQL that formats a timestamptz column as an {@link InstantCursor} `at`. */
export const INSTANT_CURSOR_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

export function encodeInstantCursor(input: InstantCursor): string {
  return encode({ at: input.at, id: input.id });
}

export function decodeInstantCursor(cursor: string): InstantCursor {
  return decode(cursor, instantCursorSchema);
}
