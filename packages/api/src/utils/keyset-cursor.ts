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
