/**
 * The session side of a document question: read the author's session and file
 * its slots through `updateFocusSession`, the door `synap_ask_person` uses.
 *
 * ONE lazy import site. `update-session.js` and the MCP `ask-person` handler
 * reach (through the pod graph) `hub-protocol/documents.ts`, which imports the
 * document-patch door, which imports `materialize-asks.ts`: a static import
 * here would close that cycle.
 */

import type { ExpectedOutput } from "@synap/playbooks";
import type { Ask } from "@synap-core/types/ask";

export interface AskSession {
  status: string;
  expectedOutputs: ExpectedOutput[];
}

export type FileAskSlotsResult =
  | { status: "updated" }
  | { status: "proposed"; proposalId: string; reviewUrl?: string }
  | { status: "refused"; reason: string };

/** What a planned question becomes on the session. */
export interface AskSlotSpec {
  key: string;
  label: string;
  ask: Ask;
  why?: string;
  unblocks?: string;
  blockedReason?: ExpectedOutput["blockedReason"];
}

/** The author's own session, or null when it is absent or someone else's. */
export async function readAskSession(args: {
  sessionId: string;
  userId: string;
}): Promise<AskSession | null> {
  const { db, focusSessions, and, eq } = await import("@synap/database");
  const [row] = await db
    .select({
      status: focusSessions.status,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  if (!row) return null;
  return {
    status: row.status,
    expectedOutputs: Array.isArray(row.expectedOutputs)
      ? (row.expectedOutputs as ExpectedOutput[])
      : [],
  };
}

/** The slot a question is filed as: the shape `synap_ask_person` files, plus the author's key. */
export async function buildAskSlot(spec: AskSlotSpec): Promise<ExpectedOutput> {
  const { blockedReasonForAsk } =
    await import("../../routers/mcp/handlers/ask-person.js");
  const { expectedOutputWireSchema } =
    await import("../focus-sessions/update-session.js");
  const parsed = expectedOutputWireSchema.safeParse({
    kind: "ask",
    label: spec.label,
    key: spec.key,
    owner: "human",
    blockedReason: spec.blockedReason ?? blockedReasonForAsk(spec.ask),
    ...(spec.why !== undefined ? { why: spec.why } : {}),
    ...(spec.unblocks !== undefined ? { unblocks: spec.unblocks } : {}),
    ask: spec.ask,
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "question"}: ${i.message}`)
        .join("; ")
    );
  }
  return parsed.data as ExpectedOutput;
}

export async function fileAskSlots(args: {
  sessionId: string;
  userId: string;
  agentUserId: string;
  slots: ExpectedOutput[];
}): Promise<FileAskSlotsResult> {
  const { updateFocusSession } =
    await import("../focus-sessions/update-session.js");
  const result = await updateFocusSession({
    sessionId: args.sessionId,
    userId: args.userId,
    agentUserId: args.agentUserId,
    expectedOutputs: args.slots,
  });
  switch (result.status) {
    case "updated":
      return { status: "updated" };
    case "proposed":
      return {
        status: "proposed",
        proposalId: result.proposalId,
        ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
      };
    case "denied":
      return { status: "refused", reason: result.reason };
    case "not_found":
      return { status: "refused", reason: "the session was not found" };
    default:
      return {
        status: "refused",
        reason: "the session moved while the question was being filed",
      };
  }
}
