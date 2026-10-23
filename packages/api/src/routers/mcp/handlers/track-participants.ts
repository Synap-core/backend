/**
 * MCP tool handler — WHO IS ON A GOAL (work model W3, 0346):
 * `synap_set_track_participant`.
 *
 * ROUTING. Straight to `services/tracks/track-participants.ts` — the SAME door
 * the tRPC `tracks.changeParticipants` procedure and Hub REST
 * `/tracks/:id/participants…` call — so the owner/judge rule, the delegate's
 * own-answer rule, the hand-off gate and governance have one authority. The
 * flat `action` arg maps onto the door's change; a malformed call comes back
 * as `{ error }` text an agent can act on, never a throw.
 */

import { z } from "zod";
import { TRACK_COMMITMENT_MOVE_KEYS } from "@synap-core/types/units";
import {
  changeTrackParticipants,
  trackParticipantChangeSchema,
} from "../../../services/tracks/track-participants.js";
import type { TrackActor } from "../../../services/tracks/tracks-service.js";
import {
  ok,
  requireScope,
  type McpToolContext,
  type McpHandlerMap,
} from "./shared.js";

/** Every `action` the tool takes — the door's ops, with each answer named. */
export const TRACK_PARTICIPANT_ACTIONS = [
  "add",
  "remove",
  ...TRACK_COMMITMENT_MOVE_KEYS,
  "acknowledge",
] as const;

const Uuid = z.string().uuid();

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function actorOf(ctx: McpToolContext): TrackActor {
  return {
    userId: ctx.userId,
    agentUserId: ctx.agentUserId ?? null,
    isHubProtocol: true,
    sessionId: ctx.sessionId ?? null,
    source: "mcp",
    reasoning: str(ctx.args.reasoning),
  };
}

/** The door's change for the flat tool args. */
function changeOf(args: Record<string, unknown>): unknown {
  const action = str(args.action);
  if (action === "add") {
    return {
      op: "add",
      principalId: str(args.principalId),
      role: str(args.role) ?? "delegate",
      ...(str(args.commitment) ? { commitment: str(args.commitment) } : {}),
    };
  }
  if (action === "remove" || action === "acknowledge") {
    return { op: action, participantId: str(args.participantId) };
  }
  return {
    op: "move",
    participantId: str(args.participantId),
    move: action,
    ...(str(args.text) ? { text: str(args.text) } : {}),
  };
}

export const trackParticipantHandlers: McpHandlerMap = {
  synap_set_track_participant: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = str(ctx.args.trackId);
    if (!trackId || !Uuid.safeParse(trackId).success) {
      return ok({
        error:
          "trackId (uuid) is required — synap_list_tracks lists a project's goals and who is on each.",
      });
    }
    const action = str(ctx.args.action);
    if (
      !action ||
      !(TRACK_PARTICIPANT_ACTIONS as readonly string[]).includes(action)
    ) {
      return ok({
        error: `action must be one of ${TRACK_PARTICIPANT_ACTIONS.join(" | ")}.`,
      });
    }
    const change = trackParticipantChangeSchema.safeParse(changeOf(ctx.args));
    if (!change.success) {
      return ok({
        error:
          action === "add"
            ? "add needs principalId (a person's or an agent's user id), role (judge | delegate | integrator) and, for a delegate, commitment."
            : action === "counter" || action === "report_impossible"
              ? `${action} needs participantId (from synap_list_tracks) and text.`
              : `${action} needs participantId (from synap_list_tracks).`,
      });
    }
    try {
      return ok(
        await changeTrackParticipants({
          trackId,
          change: change.data,
          actor: actorOf(ctx),
        })
      );
    } catch (err) {
      return ok({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
