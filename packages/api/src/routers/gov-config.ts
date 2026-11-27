/**
 * Gov-Config Router — the human "change a governance setting" door.
 *
 * `set` / `revoke` write a `governance_rules` / `governance_ceilings` /
 * `config_settings` row DIRECTLY (no proposal — the human IS the approver),
 * routed through the ONE store-write `applyGovConfigChange` (the same function
 * the AI/cron `settings.update` proposal applies). Pod-admin only: changing
 * governance config is a pod-level decision.
 *
 * This is the API surface a future browser/relay "settings" screen calls; it
 * ships with no UI by design (the AI door and the cron recommenders already
 * file `settings.update` proposals for the human to approve).
 *
 * THE OUTSIDE-HOST LIST of `http.get_json` (pod admin's Security › Network):
 * `allowedHosts` reads it for any signed-in pod user (who may read what, and
 * since when, is no secret: every agent's refusal names the list), with what
 * uses each host and `canManage`; `allowHost` adds one by RUNNING the verb
 * `http.allow_host` as the person (its own checks: a pod admin, a public host
 * name), a sensitive action with the proof of presence; `revoke` removes one
 * (`store: "config_settings"`, the row id).
 */

import { presenceInput } from "../utils/presence-input.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { automations, and, ne, drizzleSql } from "@synap/database";
import {
  router,
  assertPodAdmin,
  credentialProcedure,
  protectedProcedure,
} from "../trpc.js";
import { AccessContext, scopedDb } from "../access/index.js";
import {
  applyGovConfigChange,
  type GovConfigSpec,
} from "../services/proposals/gov-config.js";
import {
  listAllowedHostRows,
  runAllowHostAsPerson,
} from "../services/capabilities/http-get-json.js";
import { httpGetJsonFlowHosts } from "../services/proposals/part-reach.js";
import { isPodAdmin } from "../utils/workspace-role.js";

const STORE_ENUM = z.enum([
  "governance_rules",
  "governance_ceilings",
  "config_settings",
]);

const setInput = z.object({
  store: STORE_ENUM,
  principalKind: z.enum(["agent", "any"]).optional(),
  agentUserId: z.string().nullish(),
  scopeKind: z.enum(["pod", "workspace"]).optional(),
  workspaceId: z.string().nullish(),
  targetKind: z.enum(["action", "profile", "capability"]).optional(),
  targetPattern: z.string().optional(),
  targetProfile: z.string().nullish(),
  verdict: z.enum(["auto", "propose"]).optional(),
  axis: z
    .enum([
      "daily_write_count",
      "pending_proposal_cap",
      // 0430: the day's compute spend maximums (opt-in per pod).
      "compute_spend_daily_cents",
    ])
    .optional(),
  limitValue: z.number().optional(),
  configScopeKind: z.string().optional(),
  scopeRef: z.string().nullish(),
  capabilityId: z.string().nullish(),
  text: z.string().optional(),
  posture: z.enum(["auto", "propose"]).optional(),
});

export const govConfigRouter = router({
  /**
   * The hosts `http.get_json` may read, each with who added it, when, why,
   * the approval behind it, and the automations whose steps read it (a URL
   * written out; `unreadAutomations` counts those that build it while they
   * run, so "no automation" is never said for "could not tell"). Automations
   * through the canonical read door (`scopedDb`): only those the reader sees.
   * `canManage`: the reader is a pod admin (add and remove).
   */
  allowedHosts: protectedProcedure.query(async ({ ctx }) => {
    const [rows, canManage, flows] = await Promise.all([
      listAllowedHostRows(),
      isPodAdmin(ctx.userId),
      scopedDb(AccessContext.from(ctx)).findMany<{
        id: string;
        name: string;
        flowDefinition: unknown;
      }>(automations, {
        columns: { id: true, name: true, flowDefinition: true },
        where: and(
          ne(automations.status, "archived"),
          drizzleSql`${automations.flowDefinition}::text like '%"http.get_json"%'`
        ),
      }),
    ]);
    // Per host, the automations that read it: `{ id, name }`.
    const usedBy = new Map<string, Array<{ id: string; name: string }>>();
    let unreadAutomations = 0;
    for (const flow of flows) {
      const read = httpGetJsonFlowHosts(flow.flowDefinition);
      if (read.unreadSteps > 0) unreadAutomations++;
      for (const host of read.hosts) {
        usedBy.set(host, [
          ...(usedBy.get(host) ?? []),
          { id: flow.id, name: flow.name },
        ]);
      }
    }
    return {
      canManage,
      hosts: rows.map((row) => ({
        ...row,
        usedBy: (usedBy.get(row.host) ?? []).sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
      })),
      unreadAutomations,
    };
  }),

  /**
   * Add a host to the list: RUNS `http.allow_host` as the person through the
   * run door (`executeCapability`), so the verb's own checks hold (a pod
   * admin, a public host name, normalised). A sensitive action
   * (`SENSITIVE_ACTIONS`): it widens where the pod's AIs may read.
   */
  allowHost: credentialProcedure
    .input(presenceInput)
    .input(
      z.object({
        host: z.string().trim().min(1).max(253),
        reason: z.string().trim().max(1000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPodAdmin(ctx.userId);
      const out = await runAllowHostAsPerson({
        host: input.host,
        ...(input.reason ? { reason: input.reason } : {}),
        userId: ctx.userId,
      });
      switch (out.kind) {
        case "run":
          return out.result as {
            status: "allowed";
            host: string;
            alreadyAllowed: boolean;
          };
        case "error":
          // The verb's own refusal: a host that is not a public name, or the
          // caller is no pod admin.
          throw new TRPCError({
            code: out.errorClass === "validation" ? "BAD_REQUEST" : "FORBIDDEN",
            message: out.message,
          });
        case "deny":
          throw new TRPCError({ code: "FORBIDDEN", message: out.reason });
        case "proposed":
          // Never for a pod admin's own run; said rather than reported as added.
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The host was filed as a request instead of being added: approve it in Review.",
          });
        default:
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "The pod could not run http.allow_host: nothing was added.",
          });
      }
    }),

  set: credentialProcedure
    .input(presenceInput)
    .input(setInput)
    .mutation(async ({ ctx, input }) => {
      await assertPodAdmin(ctx.userId);
      const { store, ...spec } = input;
      return applyGovConfigChange({
        store,
        op: "set",
        spec: spec as GovConfigSpec,
        createdBy: ctx.userId,
      });
    }),

  revoke: credentialProcedure
    .input(
      z.object({
        store: STORE_ENUM,
        targetId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPodAdmin(ctx.userId);
      return applyGovConfigChange({
        store: input.store,
        op: "revoke",
        spec: { targetId: input.targetId },
        createdBy: ctx.userId,
      });
    }),
});
