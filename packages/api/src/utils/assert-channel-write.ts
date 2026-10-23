/**
 * The grant rung for a CHANNEL write door (S7, plan 13 §3.4) — the one check
 * every hub channel/session/memory write runs before it writes.
 *
 * Those doors are floored only by `channelVisibilityWhere`, a READ predicate:
 * a key whose grant may merely read a channel could rewrite its summary, plant
 * the memory its next session boots from, or spend the owner's AI budget. This
 * bounds the write by the calling key's grant on the CHANNEL's own workspace
 * (null = a pod-wide channel = pod scope, so a key pinned to a space fails
 * closed) — never the workspace the caller named.
 *
 * `subjectType` names what is written: `message` for a turn posted into the
 * channel (an AI turn included — decision D4), `channel` for the channel's own
 * state (its summary, sessions, compacted memory, a new channel, a bind).
 * A no-op without a grant (a signed-in session); refuses, never proposes.
 */

import { assertKeyMayWrite } from "./assert-key-may-write.js";

export async function assertChannelWrite(
  channel: { id: string; workspaceId: string | null },
  subjectType: "channel" | "message",
  action: string
): Promise<void> {
  await assertKeyMayWrite({
    subjectType,
    action,
    workspaceId: channel.workspaceId ?? null,
    data: { id: channel.id },
  });
}
