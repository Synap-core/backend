/**
 * Hub Protocol REST — an agent's PRESETS (B6): named ways it runs for a
 * purpose, stored as `agent_configs` rows (0390, `services/agent-presets.ts`).
 *
 *   GET    /agent-users/:agentUserId/presets        the agent's owner or a pod
 *          admin (the owner's agent keys too: the worker reads its presets)
 *   PUT    /agent-users/:agentUserId/presets/:key   create or replace one
 *   DELETE /agent-users/:agentUserId/presets/:key   remove one
 *
 * Writing is a PERSON's act, like the agent's governance and assignment
 * doors: a preset's instructions steer an agent, so an agent credential (an
 * agent key, an app's own agent key, the IS internal key) is refused before
 * anything is read. A person's key is bounded by its grant (`agent.update`).
 * Each preset carries `open`, the command the pod renders from the harness's
 * launch template with the preset's model (never a stored command).
 */

import type { Context } from "hono";
import { grantWriteDenial } from "../../../utils/grant-write-check.js";
import { isAgentCaller } from "../../../services/library/agent-door.js";
import { isPodAdmin } from "../../../utils/workspace-role.js";
import {
  AgentPresetBodySchema,
  AgentPresetError,
  deleteAgentPreset,
  listAgentPresets,
  putAgentPreset,
} from "../../../services/agent-presets.js";
import {
  hasScope,
  logger,
  type HubHono,
  type HubVariables,
  httpStatusForTrpcError,
  requireUuidParam,
} from "./_shared.js";

const PERSON_ONLY = {
  error:
    "An agent's presets are the person's choice. Set them in the Synap app or with a personal access token, not with an agent credential.",
  code: "PERSON_ONLY",
  reasonCode: "PERSON_ONLY",
};

type Ctx = Context<{ Variables: HubVariables }>;

function refused(c: Ctx, err: unknown, what: string): Response {
  if (err instanceof AgentPresetError) {
    return c.json(
      { error: err.message, code: err.code, reasonCode: err.code },
      err.status
    );
  }
  logger.error({ err }, `${what} failed`);
  return c.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    httpStatusForTrpcError(err)
  );
}

/** The person-only and grant gates every preset write passes first. */
async function writeDenial(c: Ctx): Promise<Response | null> {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  if (
    isAgentCaller({
      agentUserId: c.get("agentUserId") as string | undefined,
      keyType: c.get("keyType") as string | undefined,
    })
  ) {
    return c.json(PERSON_ONLY, 403);
  }
  const denial = await grantWriteDenial({
    subjectType: "agent",
    action: "update",
  });
  if (denial) {
    return c.json(
      { error: denial, code: "GRANT_DENIED", reasonCode: "GRANT_DENIED" },
      403
    );
  }
  return null;
}

export function registerAgentPresetsRoutes(app: HubHono): void {
  app.get("/agent-users/:agentUserId/presets", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const agentUserId = requireUuidParam(c, "agentUserId");
    if (agentUserId instanceof Response) return agentUserId;
    try {
      const callerId = c.get("userId") as string;
      const presets = await listAgentPresets({
        agentUserId,
        callerId,
        callerIsPodAdmin: await isPodAdmin(callerId),
      });
      return c.json({ agentUserId, presets });
    } catch (err) {
      return refused(c, err, "GET /agent-users/:agentUserId/presets");
    }
  });

  app.put("/agent-users/:agentUserId/presets/:presetKey", async (c) => {
    const gate = await writeDenial(c);
    if (gate) return gate;
    const agentUserId = requireUuidParam(c, "agentUserId");
    if (agentUserId instanceof Response) return agentUserId;
    const parsed = AgentPresetBodySchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const callerId = c.get("userId") as string;
      const preset = await putAgentPreset({
        agentUserId,
        presetKey: c.req.param("presetKey"),
        body: parsed.data,
        callerId,
        callerIsPodAdmin: await isPodAdmin(callerId),
      });
      return c.json({ agentUserId, preset });
    } catch (err) {
      return refused(c, err, "PUT /agent-users/:agentUserId/presets/:key");
    }
  });

  app.delete("/agent-users/:agentUserId/presets/:presetKey", async (c) => {
    const gate = await writeDenial(c);
    if (gate) return gate;
    const agentUserId = requireUuidParam(c, "agentUserId");
    if (agentUserId instanceof Response) return agentUserId;
    try {
      const callerId = c.get("userId") as string;
      const deleted = await deleteAgentPreset({
        agentUserId,
        presetKey: c.req.param("presetKey"),
        callerId,
        callerIsPodAdmin: await isPodAdmin(callerId),
      });
      if (!deleted) {
        return c.json(
          { error: "No preset by that key", code: "NOT_FOUND" },
          404
        );
      }
      return c.json({ agentUserId, deleted: true });
    } catch (err) {
      return refused(c, err, "DELETE /agent-users/:agentUserId/presets/:key");
    }
  });
}
