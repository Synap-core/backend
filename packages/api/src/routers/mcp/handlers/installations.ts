/**
 * MCP tool handler — what is installed on the person's computers (installer
 * reconciliation f75fbb48 §3.6, A's U9 name): which computer has which
 * capability, its lifecycle and its derived health. The same service and
 * owner floor as Hub REST `GET /installations`
 * (`services/installations/installations.ts`). Read-only: asking for an
 * install is `POST /installations/request`.
 */
import { AccessContext } from "../../../access/index.js";
import { listInstallations } from "../../../services/installations/installations.js";
import { ok, requireScope, type McpHandlerMap } from "./shared.js";

const SLUG = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const installationHandlers: McpHandlerMap = {
  synap_list_installations: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.read", ctx.toolName);
    const computerId =
      typeof ctx.args.computerId === "string" && ctx.args.computerId.trim()
        ? ctx.args.computerId.trim()
        : undefined;
    const capabilityKey =
      typeof ctx.args.capabilityKey === "string"
        ? ctx.args.capabilityKey.trim()
        : undefined;
    if (capabilityKey !== undefined && !SLUG.test(capabilityKey)) {
      return ok({
        error:
          "capabilityKey is a capability's catalog slug, e.g. media-transcribe.",
      });
    }
    const installations = await listInstallations(
      AccessContext.agent({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId,
      }),
      {
        ...(computerId ? { computerId } : {}),
        ...(capabilityKey ? { capabilityKey } : {}),
      }
    );
    return ok({ installations });
  },
};
