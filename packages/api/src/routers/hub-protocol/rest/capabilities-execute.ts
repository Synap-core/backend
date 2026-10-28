/**
 * Hub Protocol REST — POST /capabilities/execute
 *
 * The AGNOSTIC capability-execution door — the seam that completes the capability
 * substrate. Registration was already pure config (POST /tools,
 * /agent-skills/executable, POST /capabilities/apply); this is the missing door
 * that LAUNCHES a registered capability on demand from an external caller,
 * governed by the SAME `gateCapabilityExecution` every other capability path
 * uses. No per-integration endpoint ever again: any {tool + skill} applied as
 * config becomes runnable here.
 *
 * A capability VERB is backed by a SKILL — its `verbId` is the requiring skill's
 * NAME (see schema/tools.ts ToolVerbCatalogEntry.id, and the automation worker's
 * `case "capability"`). So this door resolves verb→skill (or takes a `skillId`
 * directly), runs the gate, and on `run` delegates to the IS sandbox executor via
 * the shared `executeSkillViaIS` (ONE wire contract, also used by the
 * `capability.run` approve-executor). Mirrors the worker exactly: one decision
 * core, multiple doors.
 *
 * Identity scope: a genuine OPERATOR run (Kratos cookie / operator key, no
 * agentUserId) owns the applied skill → owner-bypass runs it directly. An AGENT
 * run (agent key sets `agentUserId`) threads that identity into the gate: a
 * read-only verb still auto-runs, but an agent WRITE verb without an active grant
 * routes to `propose` — so an agent can't launder itself into an ungoverned
 * operator write ("AI mutations → checkPermissionOrPropose" holds here too).
 */

import { z } from "@hono/zod-openapi";

import { jsonGoverned } from "../proposal-response.js";
import { executeCapability } from "../../../services/capabilities/execute-capability.js";
import { CapabilityExecuteInput } from "../../../contracts/capability-execute.js";
import {
  resolveIntentRun,
  type IntentRequestRecord,
} from "../../../services/capabilities/intent-actions.js";
import {
  admitIntent,
  intentRunRateLimit,
  IntentRunRequestSchema,
  takesIntentForm,
} from "./capabilities-intent.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";

/**
 * The request body IS the shared contract (`contracts/capability-execute.ts`),
 * published under this route's OpenAPI name — not a second hand-written copy of
 * it. `@hono/zod-openapi` 1.3.0 takes zod 4 as a peer dependency, the same
 * instance the contract is written in, so `.openapi()` applies directly to it.
 *
 * This door previously declared seven of the nine client-suppliable parameters:
 * `idempotencyKey` and `channelId` were accepted by the service and unsayable
 * here, so an external caller could not make a send at-most-once and could not
 * declare its acting channel for the rung-2.55 origin-trust classification.
 * Building the schema from the contract is what makes that class of drop
 * impossible rather than merely fixed once.
 */
const ExecuteCapabilityRequestSchema = CapabilityExecuteInput.refine(
  (b) => !!b.verbId || !!b.skillId,
  { message: "Either verbId or skillId is required" }
).openapi("ExecuteCapabilityRequest");

const ExecuteCapabilityResultSchema = z
  .object({
    status: z.enum(["run", "dry-run"]),
    skillId: z.string(),
    result: z.unknown().optional(),
    dryRun: z.boolean().optional(),
    /** Observability handle for a direct run — pass to diagnose / getRun. */
    correlationId: z.string().optional(),
    /** Idempotency receipt: `applied` = executed now, `duplicate-ignored` = an
     * idempotent replay of a prior run (no second external effect) — so the
     * caller can stop retrying. Absent on a dry-run. */
    ackState: z.enum(["applied", "proposed", "duplicate-ignored"]).optional(),
  })
  .openapi("ExecuteCapabilityResult");

const ExecuteCapabilityProposedSchema = z
  .object({
    status: z.literal("proposed"),
    proposed: z.literal(true),
    proposalId: z.string(),
    /** Where the human approves it. The handler has always RETURNED this, but
     * it was absent from this schema — and a declared schema IS the contract,
     * so `reviewUrl` was invisible to every generated client and doc reader
     * even though the bytes went out. Non-optional: `execute-capability.ts:91`
     * types it `reviewUrl: string` on the proposed outcome. */
    reviewUrl: z.string(),
    /** Idempotency receipt — `duplicate-ignored` when this proposal is the
     * replay of a prior submission rather than a newly queued one. */
    ackState: z.enum(["applied", "proposed", "duplicate-ignored"]),
  })
  .openapi("ExecuteCapabilityProposed");

export function registerCapabilitiesExecuteRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/execute",
    tags: ["Capabilities"],
    summary: "Execute a registered capability (agnostic capability launcher)",
    description:
      "Resolves a capability verb (verbId = backing skill name) or a skillId to " +
      "its skill, runs it through gateCapabilityExecution, and on `run` delegates " +
      "to the IS sandbox executor. Returns 200 with the result (or a dry-run " +
      "preview), 202 with a reviewable proposal when governance requires approval, " +
      "403 when denied. Requires hub-protocol.write scope. A key the grant fence " +
      "bounds (a pod app) sends { workspaceId, intent, actionId, input, " +
      "idempotencyKey? } instead: an action listed by GET /capabilities/actions, " +
      "its input checked against that action's input schema, under " +
      "`capability.<intent>.run`; an outward intent always files a proposal. " +
      "When the action sends to someone, `input.to` is a person's or company's " +
      "entity id the key may read (else 403 SUBJECT_NOT_READABLE); the pod " +
      "finds their address for the action's account at run time (none on " +
      "file: 400 RECIPIENT_UNREACHABLE with `why`), and the proposal names them. " +
      "Any other key (an agent drafting for the person) may send the same " +
      "intent body (it is told apart by `actionId`): it is resolved the same " +
      "way, and an outward intent files a proposal for it too.",
    request: { body: ExecuteCapabilityRequestSchema },
    responses: {
      200: {
        description: "Execution result",
        schema: ExecuteCapabilityResultSchema,
      },
      202: {
        description:
          "Execution requires human approval — a reviewable proposal was created instead of running.",
        schema: ExecuteCapabilityProposedSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden / denied by gate", schema: ErrorSchema },
      404: { description: "Capability/skill not found", schema: ErrorSchema },
      424: {
        description:
          "Failed dependency — a client-actionable connection failure (auth expired/absent, or a missing target). Body carries errorClass + providerRef so the caller can offer a reconnect path.",
        schema: ErrorSchema,
      },
      429: {
        description:
          "A pod app asked for an outward intent too often (30 per hour per key and intent): `retryAfter` seconds.",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/execute", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    // A pod app (a key the grant fence bounds) asks for an INTENT action and
    // nothing else: the action is resolved, its input checked and mapped
    // onto the verb's parameters here (`capabilities-intent.ts`), then it
    // runs through the same core below. Any other body is refused for it.
    // Any other key asks for one by sending its `actionId` (an agent
    // drafting for the person); a raw body never carries one.
    const asIntent =
      takesIntentForm() ||
      (typeof raw === "object" && raw !== null && "actionId" in raw);
    let body: z.infer<typeof ExecuteCapabilityRequestSchema>;
    let intentRequest: IntentRequestRecord | null = null;
    let lens: { userId: string; workspaceId: string | null };
    if (asIntent) {
      const ask = IntentRunRequestSchema.safeParse(raw);
      if (!ask.success) {
        return c.json(
          {
            error: takesIntentForm()
              ? "This key may only ask for an intent action: { workspaceId, intent, actionId, input, idempotencyKey? }."
              : "An intent action is asked for as { workspaceId, intent, actionId, input, idempotencyKey? }.",
            code: "INVALID_REQUEST",
            issues: ask.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          400
        );
      }
      const admitted = await admitIntent(
        c,
        ask.data.workspaceId,
        ask.data.intent
      );
      if (!admitted.ok) return c.json(admitted.body, admitted.status);
      let resolved: Awaited<ReturnType<typeof resolveIntentRun>>;
      try {
        resolved = await resolveIntentRun(
          {
            userId: admitted.userId,
            workspaceId: admitted.workspaceId,
            agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
          },
          ask.data
        );
      } catch (err) {
        logger.error({ err }, "POST /capabilities/execute (intent) failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        );
      }
      switch (resolved.kind) {
        case "unknown_intent":
          return c.json(
            { error: "Unknown intent.", code: "UNKNOWN_INTENT" },
            400
          );
        case "not_found":
          return c.json(
            {
              error:
                "No such action for this intent here: list them again (GET /capabilities/actions).",
              code: "ACTION_NOT_FOUND",
            },
            404
          );
        case "intent_mismatch":
          return c.json(
            {
              error: `This action does not serve "${ask.data.intent}".`,
              code: "INTENT_MISMATCH",
            },
            403
          );
        case "invalid_input":
          return c.json(
            {
              error: "The input does not match what this action accepts.",
              code: "INVALID_INPUT",
              issues: resolved.issues,
            },
            400
          );
        case "subject_not_readable":
          return c.json(
            {
              error:
                "`to` names no person or company this key may read: pass the id of one it can read.",
              code: "SUBJECT_NOT_READABLE",
            },
            403
          );
        case "recipient_unreachable":
          return c.json(
            {
              error: resolved.why,
              code: "RECIPIENT_UNREACHABLE",
              why: resolved.why,
            },
            400
          );
      }
      if (resolved.effect !== "read") {
        const limited = intentRunRateLimit(
          (c.get("apiKeyId") as string | undefined) ?? admitted.userId,
          admitted.intent
        );
        if (limited) {
          c.header("Retry-After", String(limited.body.retryAfter));
          return c.json(limited.body, limited.status);
        }
      }
      body = {
        skillId: resolved.skillId,
        parameters: resolved.parameters,
        workspaceId: admitted.workspaceId,
        ...(resolved.connectionSelector
          ? { connectionSelector: resolved.connectionSelector }
          : {}),
        ...(ask.data.idempotencyKey
          ? { idempotencyKey: ask.data.idempotencyKey }
          : {}),
      };
      intentRequest = resolved.intentRequest;
      lens = admitted;
    } else {
      try {
        body = ExecuteCapabilityRequestSchema.parse(raw);
      } catch (err) {
        return c.json(
          {
            error: err instanceof Error ? err.message : "Invalid request body",
          },
          400
        );
      }
      const acting = await resolveActingContext(c, {
        workspaceId: body.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      lens = acting;
    }

    const {
      verbId,
      skillId,
      parameters,
      connectionSelector,
      sourceMessageId,
      sessionId,
      idempotencyKey,
      channelId,
    } = body;
    const { userId } = lens;

    try {
      // ONE shared core (also used by the MCP `run_capability` tool).
      const outcome = await executeCapability({
        verbId,
        skillId,
        parameters,
        workspaceId: lens.workspaceId,
        userId,
        // Thread the acting agent (agent-key runs set this) so an agent WRITE
        // verb is governed by grant/propose instead of laundering into an
        // ungoverned operator run. A genuine operator (Kratos cookie) has none.
        agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
        connectionSelector,
        // #4 provenance: the triggering message id → resolved to the acting
        // channel inside executeCapability so an untrusted-origin run proposes.
        sourceMessageId: sourceMessageId ?? null,
        sessionId: sessionId ?? null,
        // An explicit acting channel wins over the one derived from
        // `sourceMessageId`; a caller that knows its channel need not have a
        // triggering message at all (a cron-driven agent turn has none).
        channelId: channelId ?? null,
        // Caller idempotency: makes an external-send verb at-most-once across
        // retries instead of falling back to the derived content-hash window.
        idempotencyKey,
        // A pod app's intent action: what it asked, for the approval screen.
        intentRequest,
      });

      switch (outcome.kind) {
        case "not_found":
          return c.json({ error: outcome.message }, 404);
        case "deny":
          // The refusal carries WHAT to enable and WHERE (`enable.hint` +
          // `enable.url`) — a 403 that only says "refused" is the dead end this
          // door existed as until now. 4xx bodies survive the egress sanitizer
          // (only 5xx is redacted), so the link actually reaches the caller.
          // An agent's refusal may also carry the enable request it filed. Its
          // "did NOT run" sentence rides in `error` too: the IS client keeps
          // only `error` from a 403, and a 403 (not 202) is what tells every
          // caller the action itself was not queued.
          return c.json(
            {
              error:
                `Capability refused by gate: ${outcome.reason}` +
                (outcome.enableProposal?.status === "proposed"
                  ? ` ${outcome.enableProposal.message} Review: ${outcome.enableProposal.reviewUrl}`
                  : ""),
              ...(outcome.enable ? { enable: outcome.enable } : {}),
              ...(outcome.enableProposal
                ? { enableProposal: outcome.enableProposal }
                : {}),
            },
            403
          );
        case "error": {
          // The verb RAN and its handler FAILED (code sandbox / provider error).
          // A CONNECTION-class failure (expired/absent auth, a gone target) is
          // CLIENT-ACTIONABLE, not a server fault: surface it as 4xx so
          //   (a) it reads as "you can fix this" (reconnect), not "the server
          //       crashed", and
          //   (b) `errorClass` + `providerRef` SURVIVE the 5xx egress sanitizer
          //       (middleware/error-egress.ts redacts every 5xx body; 4xx is left
          //       intact) — the CLI / MCP agent reads them to offer a reconnect
          //       path. This is the same self-heal signal the browser P1 chip uses.
          // A genuine provider/transient/server fault stays 500 (correctly
          // sanitized — its raw message may carry a driver stack).
          const ec = outcome.errorClass;
          const isReconnect =
            ec === "auth" || ec === "no_connection" || ec === "target_missing";
          if (isReconnect) {
            return c.json(
              {
                error: outcome.message,
                code:
                  ec === "target_missing"
                    ? "TARGET_MISSING"
                    : "CONNECTION_REAUTH",
                errorClass: ec,
                providerRef: outcome.providerRef,
              },
              424
            );
          }
          // REPAIRABLE ARGUMENTS — a 400, never a 500. The call was refused
          // because the CALLER's parameters did not match the verb's declared
          // schema; that is a client error, and routing it through the 5xx
          // branch both mislabels it and loses the detail (the 5xx egress
          // sanitizer strips the body). `repair` carries {missing, wrongType,
          // unknown} so the caller can fix the call in one round trip instead
          // of guessing — the 42%-of-tool-failures class. The field was
          // computed by the service and forwarded by no door until now; caught
          // by `cross-door-field-parity`, same shape as the `truncated` field
          // that shipped unpopulated.
          if (outcome.repair) {
            // A pod file the caller cannot read is a 403, an unknown one a
            // 404 — the split the file URL door makes (`readableFileEntity`).
            const fileProblems = outcome.repair.files ?? [];
            const forbidden = fileProblems.some(
              (f) => f.problem === "forbidden"
            );
            const notFound = fileProblems.some(
              (f) => f.problem === "not_found"
            );
            return c.json(
              {
                error: outcome.message,
                code: forbidden
                  ? "FILE_NOT_READABLE"
                  : notFound
                    ? "FILE_NOT_FOUND"
                    : "INVALID_PARAMETERS",
                repair: outcome.repair,
              },
              forbidden ? 403 : notFound ? 404 : 400
            );
          }
          return c.json(
            { error: `Capability execution failed: ${outcome.message}` },
            500
          );
        }
        case "dry-run":
          return c.json(
            {
              status: "dry-run" as const,
              skillId: outcome.skillId,
              dryRun: true,
            },
            200
          );
        case "proposed":
          // The 202-on-proposed rule lives in `jsonGoverned`, not here
          // (proposal-response.parity.tripwire).
          return jsonGoverned(c, {
            // `status` says what happened in one field, as every write door
            // does (`applied` / `proposed`); `proposed` stays for callers
            // that read it.
            status: "proposed" as const,
            proposed: true as const,
            proposalId: outcome.proposalId,
            reviewUrl: outcome.reviewUrl,
            // Idempotency receipt — tells the caller whether this proposal was
            // queued now or is the replay of a prior submission.
            ackState: outcome.ackState,
          });
        case "run":
          return c.json(
            {
              status: "run" as const,
              skillId: outcome.skillId,
              result: outcome.result,
              // The direct-run observability handle (best-effort — see
              // executeCapability): lets the caller diagnose/getRun the run.
              correlationId: outcome.correlationId,
              // Idempotency receipt: `duplicate-ignored` means this was a replay
              // of a prior run (the stored result, no second external effect) —
              // without it the caller cannot tell a replay from a fresh run and
              // keeps retrying.
              ackState: outcome.ackState,
            },
            200
          );
      }
    } catch (err) {
      logger.error(
        { err, verbId, skillId },
        "POST /capabilities/execute failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
