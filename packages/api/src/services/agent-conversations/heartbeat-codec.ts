/**
 * The heartbeat codec — what a terminal reporter may tell the pod, and the
 * ONLY way a heartbeat reaches `agent_conversations` (0354).
 *
 * NEVER stored, by construction:
 *   - prompt text, pid, tty, resume paths, tokens, account labels: the body
 *     schema is STRICT, so any field it does not name is refused (400) before
 *     anything is written — a reporter that starts sending `prompt` fails
 *     loudly instead of leaking quietly;
 *   - full folder paths: `folder` is reduced to its last segment;
 *   - a path smuggled through an identity field: `computer` is reduced to a
 *     short host-name label, `harness` and `conversationId` refuse `/` and `\`.
 *
 * What it does NOT catch, stated: a reporter that puts a secret INSIDE an
 * allowed field (a token as `conversationId`), or a folder whose own name is a
 * person's (`/Users/ada` → `ada`). The contract asks reporters for the
 * harness's conversation id and the working folder's basename; the codec
 * enforces shape, not intent.
 */

import { z } from "zod";
import { AGENT_CONVERSATION_STATES } from "@synap/database/schema";

/** The longest computer label kept (a DNS label's limit). */
const COMPUTER_MAX = 63;
/** The longest folder basename kept. */
const FOLDER_MAX = 128;

/**
 * The computer's key: the first label of its host name, lower-cased, with
 * anything outside `[a-z0-9-]` folded to `-`. `Ada-MacBook-Pro.local` and
 * `ada-macbook-pro` are one computer. Also the name key `synap_list_agents`
 * matches roster computers with, so both sides agree by construction.
 * Returns null when nothing is left.
 */
export function normalizeComputerName(
  raw: string | null | undefined
): string | null {
  const first = (raw ?? "").trim().split(".")[0] ?? "";
  const key = first
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, COMPUTER_MAX)
    .replace(/-+$/g, "");
  return key || null;
}

/**
 * The last segment of a folder path (either separator), never the path.
 * `"/Users/ada/code/synap/"` → `"synap"`; a bare `"synap"` stays itself;
 * `"/"`, `"~"`, `""` → null.
 */
export function folderBasename(raw: string | null | undefined): string | null {
  const segments = (raw ?? "").split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1]?.trim() ?? "";
  if (!last || last === "~" || last === "." || last === "..") return null;
  return last.slice(0, FOLDER_MAX);
}

const NO_PATH = /^[^\\/\s]+$/;

/**
 * The wire body of `POST /api/hub/conversations/heartbeat`. STRICT: an unknown
 * key is a 400 (see the file header). `sessionId` binds the conversation to a
 * session through `session_runners`; omit it for an unbound terminal.
 */
export const HeartbeatBodySchema = z.object({
  /** The computer's host name; reduced to its first label (`normalizeComputerName`). */
  computer: z.string().trim().min(1).max(253),
  /** The harness (`claude-code`): the same grammar as `X-Synap-Conversation`. */
  harness: z
    .string()
    .trim()
    .regex(
      /^[a-z][a-z0-9-]{0,31}$/,
      "harness: lower-case letters, digits, '-'"
    ),
  /** The harness's own conversation id (Claude Code: the session UUID). */
  conversationId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(NO_PATH, "conversationId: an id, never a path"),
  state: z.enum(AGENT_CONVERSATION_STATES),
  /** The working folder; only its basename is kept. */
  folder: z.string().max(4096).nullish(),
  /** Live sub-agents of this conversation (Claude Code Task agents). */
  subagents: z.number().int().min(0).max(1000).optional(),
  /** The session this conversation works in, when bound. */
  sessionId: z.string().uuid().nullish(),
  /** The conversation closed (Claude Code `SessionEnd`). */
  ended: z.boolean().optional(),
});

export type HeartbeatBody = z.infer<typeof HeartbeatBodySchema>;

/** Exactly what a heartbeat may write — every column the reporter controls. */
export interface DecodedHeartbeat {
  computer: string;
  harness: string;
  conversationId: string;
  state: (typeof AGENT_CONVERSATION_STATES)[number];
  folder: string | null;
  subagentCount: number;
  sessionId: string | null;
  ended: boolean;
}

export type DecodeResult =
  { ok: true; heartbeat: DecodedHeartbeat } | { ok: false; error: string };

/** Parse a raw body into the only shape the store accepts. */
export function decodeHeartbeat(raw: unknown): DecodeResult {
  const parsed = HeartbeatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; "),
    };
  }
  const b = parsed.data;
  const computer = normalizeComputerName(b.computer);
  if (!computer) {
    return {
      ok: false,
      error: "computer: no host name left after normalising",
    };
  }
  return {
    ok: true,
    heartbeat: {
      computer,
      harness: b.harness,
      conversationId: b.conversationId,
      state: b.state,
      folder: b.folder ?? null,
      subagentCount: b.subagents ?? 0,
      sessionId: b.sessionId ?? null,
      ended: b.ended === true,
    },
  };
}
