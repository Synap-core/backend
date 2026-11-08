/**
 * MCP tool handler — what is installed on the person's computers (installer
 * reconciliation f75fbb48 §3.6, A's U9 name): which computer has which
 * capability, its lifecycle and its derived health. The same service and
 * owner floor as Hub REST `GET /installations`
 * (`services/installations/installations.ts`). Read-only: asking for an
 * install is `POST /installations/request`.
 */
import { TRPCError } from "@trpc/server";
import { AccessContext } from "../../../access/index.js";
import {
  INSTALLATION_REQUEST_ACTIONS,
  listInstallations,
  loadInstallableCapability,
  type InstallationRequestAction,
} from "../../../services/installations/installations.js";
import {
  computerChoices,
  findPersonsComputer,
  listPersonsComputers,
  loadCatalogCapability,
  requestInstallation,
  requestPodInstall,
} from "../../../services/installations/request-installation.js";
import { ok, requireScope, type McpHandlerMap } from "./shared.js";

/** Where a refused capability CAN go: its computer blocks, read once. */
async function manifestFor(
  capabilityKey: string
): Promise<Record<string, unknown> | null> {
  const onPod = await loadInstallableCapability(capabilityKey);
  if (onPod) return onPod.manifest;
  const catalog = await loadCatalogCapability(capabilityKey).catch(() => null);
  return catalog?.installable?.manifest ?? null;
}

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
  synap_request_installation: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const capabilityKey =
      typeof ctx.args.capabilityKey === "string"
        ? ctx.args.capabilityKey.trim()
        : "";
    if (!SLUG.test(capabilityKey))
      return ok({
        error:
          "capabilityKey is a capability's catalog slug, e.g. media-ffmpeg: find one with synap_run_capability market.search.",
      });
    const target =
      typeof ctx.args.computer === "string" ? ctx.args.computer.trim() : "";
    const action = (ctx.args.action ?? "install") as InstallationRequestAction;
    if (!(INSTALLATION_REQUEST_ACTIONS as readonly unknown[]).includes(action))
      return ok({
        error: `action is one of ${INSTALLATION_REQUEST_ACTIONS.join(", ")}.`,
      });
    const version =
      typeof ctx.args.version === "string" && ctx.args.version.trim()
        ? ctx.args.version.trim()
        : null;
    const caller = {
      userId: ctx.userId,
      agentUserId: ctx.agentUserId ?? null,
    };

    try {
      if (!target)
        return ok({
          status: "refused",
          code: "COMPUTER_REQUIRED",
          error:
            'Name where it goes: one of the person\'s computers (by name or id), or "pod".',
          computers: computerChoices(
            await listPersonsComputers(ctx.userId),
            await manifestFor(capabilityKey)
          ),
        });

      if (target.toLowerCase() === "pod") {
        if (action !== "install")
          return ok({
            error:
              "On the pod, ask only to install: a capability on the pod is updated or removed from the Marketplace.",
          });
        const out = await requestPodInstall({ ...caller, capabilityKey });
        if (out.status !== "refused") return ok(out);
        const { httpStatus: _s, manifest, ...answer } = out;
        return ok({
          ...answer,
          ...(out.reason === "RUNS_ON_COMPUTER"
            ? {
                computers: computerChoices(
                  await listPersonsComputers(ctx.userId),
                  manifest ?? null
                ),
              }
            : {}),
        });
      }

      const found = await findPersonsComputer(ctx.userId, target);
      if (found.status === "ambiguous") {
        const choices = computerChoices(
          found.computers,
          await manifestFor(capabilityKey)
        );
        const ids = new Set(found.candidates.map((c) => c.id));
        return ok({
          status: "refused",
          code: "COMPUTER_AMBIGUOUS",
          error: `"${target}" fits ${found.candidates.length} of the person's computers (${found.candidates.map((c) => c.name).join(", ")}): ask the person which one, then pass its id.`,
          candidates: choices.filter((c) => ids.has(c.id)),
          computers: choices,
        });
      }
      if (found.status === "not_found")
        return ok({
          status: "refused",
          code: "COMPUTER_NOT_FOUND",
          error: `None of the person's computers is named "${target}". Pick one below, or "pod".`,
          computers: computerChoices(
            found.computers,
            await manifestFor(capabilityKey)
          ),
        });

      const out = await requestInstallation({
        ...caller,
        computer: found.computer,
        capabilityKey,
        action,
        version,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        fromCatalog: true,
      });
      if (out.status !== "refused") return ok(out);
      const { httpStatus: _s, manifest, ...answer } = out;
      return ok({
        ...answer,
        ...(out.code === "CANNOT_INSTALL"
          ? {
              computers: computerChoices(
                await listPersonsComputers(ctx.userId),
                manifest ?? null
              ),
            }
          : {}),
      });
    } catch (err) {
      // The catalog could not be read (unreachable, unsigned, retired): its
      // own words, which say what to do.
      if (err instanceof TRPCError) return ok({ error: err.message });
      throw err;
    }
  },
};
