/**
 * run-skill-in-sandbox — run a Tier-2 code skill in an isolated-vm isolate
 * IN THE BACKEND, without the Intelligence Service.
 *
 * This is the in-process twin of `executeSkillViaIS`. Where the IS executor
 * (`skills-executor.ts`) installs six host bridges that round-trip BACK to the
 * backend over Hub Protocol HTTP, this executor installs the SAME six bridges as
 * DIRECT in-process backend calls — no network hop:
 *
 *   IS HTTP bridge                         →  in-backend direct call
 *   ────────────────────────────────────────────────────────────────────────
 *   console.log                            →  backend pino logger
 *   hubProtocol.search(query, opts)        →  hubProtocolRouter.search.search
 *   hubProtocol.getEntities(opts)          →  hubProtocolRouter.entities.getEntities
 *   hubProtocol.getDocument(id)            →  hubProtocolRouter.documents.getDocument
 *   secrets.get(ref)                       →  parseVaultReference + resolveVaultSecret (grant-gated)
 *   callProvider(...)                      →  triggerProviderAction (external-dispatch)
 *   propose.entity(input)                  →  hubProtocolRouter.entities.createEntity (checkPermissionOrPropose)
 *   host.fetch(url, opts)                  →  fetch guarded by validateExternalUrl (SSRF) + allowedHosts
 *
 * IDENTITY THREADING (the #1 correctness item): the run's `userId` is threaded
 * as the OPERATOR FLOOR into every read/write via the SAME
 * `createHubProtocolCallerContext` the REST doors build — so a skill reads/writes
 * AS the user (Typesense/entity reads scope to `ctx.userId`, the delegated
 * operator). The acting `agentUserId` is threaded EXACTLY where the REST doors
 * thread it — as the `agentUserId` INPUT to `entities.createEntity`,
 * `triggerProviderAction`, and the vault `redeemer` — so an agent-run WRITE still
 * routes through the governance membrane (`checkPermissionOrPropose`, rung-2.8;
 * an anonymous/unattributed write is still rejected by that gate) instead of
 * auto-executing. Reads carry no agentUserId (they ride the operator floor),
 * matching `getCaller`'s deliberate asymmetry.
 *
 * ONE BRIDGE SET (R1, 2026-10-26): everything the IS executor does, this does
 * too — the parameter check before any code runs, dry-run (`dryRunEffects`),
 * `propose.entity` `content`, the session on governed provider writes, and
 * `runtimeVersion` on the result — so the pod can become the only runtime
 * without a regression.
 *
 * Behind the `SANDBOX_LOCAL` flag (default OFF) — the chokepoint in
 * `execute-capability.ts` still calls `executeSkillViaIS` unless it is "1".
 *
 * WHERE the isolate runs is the skill runner's business (`runner/`): a
 * supervised child process in production, never this process (pod decision
 * R6). The bridges below stay HERE — this file is the broker — and the runner
 * reaches them by name (`runner/protocol.ts`).
 */

import { AsyncResource } from "node:async_hooks";
import {
  db,
  eq,
  findRedeemableGrant,
  parseVaultReference,
  resolveVaultSecret,
  VaultGrantError,
} from "@synap/database";
import { skills, secrets } from "@synap/database/schema";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import { createLogger } from "@synap-core/core";
import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import {
  triggerProviderAction,
  type FailureErrorClass,
} from "../../connectors/external-dispatch.js";
import { SKILL_RUNTIME_VERSION } from "./skill-stdlib.js";
import type {
  RecordedEffect,
  SkillExecutionResult,
} from "./execute-skill-via-is.js";
import {
  getSkillRunner,
  type SkillBridges,
  type SkillJob,
  type SkillRunner,
} from "./runner/index.js";
// Type-only import (erased at runtime — the value is loaded via dynamic import()
// below to avoid a static router↔service cycle). Gives the caller its real type.
import type { hubProtocolRouter } from "../../routers/hub-protocol/index.js";

/** The real Hub Protocol tRPC caller type — same door the REST handlers build. */
type HubCaller = ReturnType<typeof hubProtocolRouter.createCaller>;

const logger = createLogger({ module: "run-skill-in-sandbox" });

/** Scopes the in-process caller runs with — parity with the Hub Protocol doors. */
const HUB_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

/**
 * Grant-gated vault redemption, server-derived exactly like `POST /vault/redeem`:
 * parse the ref, load the secret OWNER (enables decrypt), then resolve with a
 * grant gate bound to the acting principal. Returns null when not granted (the
 * `secrets.get(ref)` contract: "returns null for anything it isn't granted").
 */
async function redeemVaultSecretDirect(
  ref: string,
  operatorUserId: string,
  agentUserId: string | null,
  workspaceId: string | null,
  dryRun: boolean
): Promise<string | null> {
  const parsed = parseVaultReference(ref);
  if (!parsed) return null;
  const secret = await db.query.secrets.findFirst({
    where: eq(secrets.id, parsed.secretId),
    columns: { userId: true },
  });
  if (!secret) return null;
  // Redeemer is the acting agent (or the operator when no agent key is in
  // play) — mirrors the vault REST door's `agentUserId ?? acting.userId`.
  const redeemer = {
    agentUserId: agentUserId ?? operatorUserId,
    workspaceId: workspaceId ?? null,
  };
  // Dry-run: the SAME grant check, without decrypting and without spending a
  // use (the find half of the redemption only). A granted ref answers a masked
  // sentinel, an ungranted one null, as it would live.
  if (dryRun) {
    const grant = await findRedeemableGrant(
      "secret",
      parsed.secretId,
      redeemer
    );
    return grant.ok ? "dry-run-secret" : null;
  }
  try {
    return await resolveVaultSecret(
      parsed.secretId,
      secret.userId,
      parsed.fieldName,
      { requireGrant: true, redeemer }
    );
  } catch (err) {
    if (err instanceof VaultGrantError) return null;
    throw err;
  }
}

/**
 * Run a code skill (by id) in an in-process isolate and return the SAME
 * `SkillExecutionResult` envelope `executeSkillViaIS` returns.
 */
export async function runSkillInSandbox(args: {
  skillId: string;
  userId: string;
  parameters?: Record<string, unknown>;
  /** The run's workspace lens — where propose.entity/callProvider proposals land. */
  workspaceId?: string | null;
  /** The acting agent (null/absent = operator run). Gates in-skill WRITES. */
  agentUserId?: string | null;
  /**
   * The verb decision this run carries (see `TriggerProviderActionInput.verbAct`):
   * set by the post-gate runner so this skill's provider calls to its OWN
   * required tools ride the verb's approval instead of being gated again.
   */
  verbAct?: { skillId: string; toolIds: readonly string[] };
  /**
   * The focus session the run belongs to, from the RUN's context (never from
   * the skill's input). Rides the governed provider-write branch, so a
   * proposal that write files carries `proposals.session_id`.
   */
  sessionId?: string | null;
  /**
   * Preview: reads run for real, every write and send (`propose.entity`,
   * `callProvider`, `host.fetch`) is recorded in `dryRunEffects` instead of
   * performed, secrets answer a masked value. Every guard still applies.
   */
  dryRun?: boolean;
}): Promise<SkillExecutionResult> {
  const startTime = Date.now();
  const operatorUserId = args.userId;
  const workspaceId = args.workspaceId ?? null;
  const agentUserId = args.agentUserId ?? null;
  const dryRun = args.dryRun === true;

  // P1: host-side carrier for a classified provider failure. `callProvider`
  // throws INTO the isolate (which strips Error properties down to the message)
  // and lives in the `runIsolate` helper, so the classification can't ride the
  // thrown error — we pass this sink into the helper, it writes the sink on a
  // provider failure, and we read it here on the failure return. Consulted only
  // when the run fails; a skill that catches the provider error and succeeds
  // leaves it unused.
  const providerFailure: {
    errorClass?: FailureErrorClass;
    providerRef?: string;
  } = {};

  try {
    // Load the full skill row (the IS fetches it over Hub Protocol; in-process we
    // read it directly). Replicate the IS executor's active+approved gate — an
    // unapproved/draft or inactive skill must not execute.
    const skill = await db.query.skills.findFirst({
      where: eq(skills.id, args.skillId),
    });
    if (!skill) {
      return {
        success: false,
        error: `Skill not found: ${args.skillId}`,
        executionTimeMs: Date.now() - startTime,
      };
    }
    if (skill.status !== "active" || skill.approved !== true) {
      return {
        success: false,
        error:
          skill.approved === false
            ? "Skill is not approved for execution."
            : `Skill is ${skill.status}`,
        executionTimeMs: Date.now() - startTime,
      };
    }
    if (!skill.code) {
      return {
        success: false,
        error: "Skill has no code to execute.",
        executionTimeMs: Date.now() - startTime,
      };
    }

    // The arguments against the skill's declared `parameters`, before any code
    // runs: the runtime is the handler of a code skill, so this is the check
    // `executeCapability`'s propose branch defers to for a `run`. The pod's one
    // reader of that declaration; an absent or unreadable one runs unchanged.
    const { checkVerbParameters, describeParameterRepair } =
      await import("../capabilities/validate-verb-parameters.js");
    const paramCheck = checkVerbParameters(skill, args.parameters);
    if (paramCheck.status === "invalid") {
      return {
        success: false,
        error: `Parameter validation failed: ${describeParameterRepair(
          skill.name,
          paramCheck.repair
        )}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    const timeoutMs = (skill.timeoutSeconds ?? 30) * 1000;
    const allowedHosts =
      (skill.metadata?.allowedHosts as string[] | undefined) ?? [];
    const recordedEffects: RecordedEffect[] = [];

    // ONE caller, built with the operator floor — the same door the REST handlers
    // build. Reads scope to ctx.userId; the write bridges thread agentUserId as a
    // procedure INPUT (never via ctx), matching getCaller's asymmetry.
    const ctx = await createHubProtocolCallerContext(
      operatorUserId,
      HUB_SCOPES,
      workspaceId
    );
    const { hubProtocolRouter } =
      await import("../../routers/hub-protocol/index.js");
    const caller = hubProtocolRouter.createCaller(ctx as never);

    const result = await runIsolate({
      code: skill.code,
      args: args.parameters ?? {},
      context: {
        userId: operatorUserId,
        // The author contract (`skill-runtime.d.ts`) types `threadId` a
        // string; the IS executes these runs as "manual" / "dry-run".
        threadId: dryRun ? "dry-run" : "manual",
        workspaceId,
        agentUserId,
      },
      timeoutMs,
      allowedHosts,
      operatorUserId,
      workspaceId,
      agentUserId,
      sessionId: args.sessionId ?? null,
      caller,
      failureSink: providerFailure,
      verbAct: args.verbAct,
      recordedEffects: dryRun ? recordedEffects : undefined,
    });

    return {
      success: true,
      result,
      executionTimeMs: Date.now() - startTime,
      runtimeVersion: SKILL_RUNTIME_VERSION,
      ...(dryRun ? { dryRunEffects: recordedEffects } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
      // P1: surface the provider failure's classification if the failure came
      // from an in-skill callProvider (empty sink → spreads nothing).
      ...providerFailure,
    };
  }
}

/**
 * `fn`, bound to the async context in scope NOW.
 *
 * isolated-vm runs an `ivm.Reference` host callback with NO async context, so
 * every AsyncLocalStorage store is empty inside it: the acting agent
 * (`runWithActingAgent`), the key grant, the write-session ledger — all the
 * pod-side context a bridge's hub call reads. Proven on the IS twin (ticket
 * f47609a6, pod knowledge 11dc561a, IS `bindRequestCustomerContext`), where it
 * turned every `callProvider` into a 401. `AsyncResource.bind` captures the
 * WHOLE context (every store at once), so a store added later is covered by
 * existing — no per-store list to keep in step.
 */
export function bindHostCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  return AsyncResource.bind(fn);
}

/** The broker-side context every bridge of one run closes over. */
interface SkillBridgeParams {
  allowedHosts: string[];
  operatorUserId: string;
  workspaceId: string | null;
  agentUserId: string | null;
  /** The run's focus session — forwarded on governed provider writes only. */
  sessionId?: string | null;
  caller: HubCaller;
  /** P1: written on a classified provider failure so the caller can attach the
   *  recovery classification to its failure envelope (see runSkillInSandbox). */
  failureSink: { errorClass?: FailureErrorClass; providerRef?: string };
  /** This run's verb decision — scoped to THIS run's provider calls. */
  verbAct?: { skillId: string; toolIds: readonly string[] };
  /**
   * Present = DRY-RUN: the write/send bridges record their effect here and
   * return a stub instead of performing it. Reads and every guard stay real.
   */
  recordedEffects?: RecordedEffect[];
}

/**
 * Run one skill's code on a skill runner (`runner/`), with this run's bridges.
 * The runner (a child process in production) only evaluates the code; every
 * bridge it reaches runs HERE, in the broker, under the run's identity.
 *
 * @internal Exported for the `run-skill-in-sandbox.*.test.ts` suites.
 */
export async function runIsolate(
  params: SkillBridgeParams & {
    code: string;
    args: Record<string, unknown>;
    context: SkillJob["context"];
    timeoutMs: number;
    /** Default: this pod's runner (`getSkillRunner`). */
    runner?: SkillRunner;
  }
): Promise<unknown> {
  const { code, args, context, timeoutMs, runner, ...bridgeParams } = params;
  return (runner ?? getSkillRunner()).run(
    { code, args, context, timeoutMs },
    buildSkillBridges(bridgeParams)
  );
}

/**
 * The host bridges of one run: plain values in, a plain value or a throw out.
 * EVERY bridge is bound to the async context in scope NOW (see
 * `bindHostCallback`), so it keeps the run's identity wherever the runner
 * calls it from — an isolate callback in-process, or an IPC message from a
 * runner process.
 *
 * @internal Exported for the `run-skill-in-sandbox.*.test.ts` suites.
 */
export function buildSkillBridges(params: SkillBridgeParams): SkillBridges {
  const {
    allowedHosts,
    operatorUserId,
    workspaceId,
    agentUserId,
    sessionId,
    caller,
    failureSink,
    verbAct,
    recordedEffects,
  } = params;
  const dryRun = recordedEffects !== undefined;
  let dryRunSeq = 0;

  // ── console → backend logger ─────────────────────────────────────────────
  const log = (...logArgs: unknown[]) => {
    logger.info({ args: logArgs }, "[Skill]");
  };

  // ── hubProtocol.search → hubProtocolRouter.search.search ─────────────────
  const search = async (query: unknown, opts: unknown) => {
    const result = await caller.search.search({
      // Identity LAST — a skill-controlled `opts` spread before it can
      // never override the operator floor, regardless of what
      // `search.search` reads in the future (today it ignores
      // `input.userId` and uses `ctx.userId`, but that's a downstream
      // invariant this bridge should not depend on).
      ...((opts as object | null) ?? {}),
      userId: operatorUserId,
      query: String(query),
    });
    return result;
  };

  // ── hubProtocol.getEntities → hubProtocolRouter.entities.getEntities ─────
  const getEntities = async (opts: unknown) => {
    const o = (opts ?? {}) as {
      type?: string;
      profileSlug?: string;
      limit?: number;
    };
    const result = await caller.entities.getEntities({
      userId: operatorUserId,
      profileSlug: o.profileSlug ?? o.type,
      limit: o.limit,
      // The IS `/users/:id/entities` door reads the operator FLOOR + pod-wide
      // (includePodWide:true) — reproduce it so a workspace lens never hides
      // pod-wide profiles (person/company/contact).
      includePodWide: true,
    });
    return result;
  };

  // ── hubProtocol.getDocument → hubProtocolRouter.documents.getDocument ────
  const getDocument = async (documentId: unknown) => {
    const result = (await caller.documents.getDocument({
      documentId: String(documentId),
      userId: operatorUserId,
    })) as { document?: unknown } | null;
    // The IS bridge returns `data.document`; the door returns the same shape.
    const doc =
      result && typeof result === "object" && "document" in result
        ? (result as { document?: unknown }).document
        : result;
    return doc ?? null;
  };

  // ── secrets.get → grant-gated vault resolver (direct) ────────────────────
  const redeemSecret = async (ref: unknown) => {
    const value = await redeemVaultSecretDirect(
      String(ref),
      operatorUserId,
      agentUserId,
      workspaceId,
      dryRun
    );
    return value ?? null;
  };

  // ── host.fetch → external egress (SSRF + allowedHosts guarded) ───────────
  const hostFetch = async (urlStr: unknown, optsStr?: unknown) => {
    const url = String(urlStr);

    const check = validateExternalUrl(url);
    if (!check.valid) {
      return {
        error: "url_rejected",
        message: check.reason,
      };
    }

    if (!allowedHosts.includes(check.url.hostname)) {
      return {
        error: "domain_not_approved",
        hostname: check.url.hostname,
        message: `Domain "${check.url.hostname}" is not approved. The agent should propose access.`,
      };
    }

    // Dry-run: the guards above ran and their refusals surfaced; the request
    // itself is recorded, never sent.
    if (recordedEffects) {
      const method =
        typeof optsStr === "string"
          ? ((JSON.parse(optsStr) as { method?: string }).method ?? "GET")
          : "GET";
      recordedEffects.push({ kind: "fetch", url, method });
      return {
        ok: true,
        status: 200,
        headers: {},
        body: "",
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        // `safeExternalFetch` re-validates SSRF ranges on every hop and, with
        // `maxRedirects` left at its default of 0, REJECTS any redirect
        // outright — `check.url`/`allowedHosts` above only vetted the
        // INITIAL URL, so a raw `fetch()` here would follow a same-host-
        // approved response straight through a `302 Location:
        // http://169.254.169.254/...` (or any internal service) with no
        // re-check. Rejecting redirects keeps the initial `allowedHosts`
        // gate sufficient — there is no second hop to smuggle through it.
        const response = await safeExternalFetch(url, {
          ...(typeof optsStr === "string" ? JSON.parse(optsStr) : {}),
          signal: controller.signal,
        });
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          ok: response.ok,
          status: response.status,
          headers,
          body: body.slice(0, 100_000), // cap response size
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      return {
        error: "fetch_failed",
        message: err instanceof Error ? err.message : "Fetch failed",
      };
    }
  };

  // ── callProvider → triggerProviderAction (governed, agent-gated) ─────────
  const callProvider = async (
    provider: unknown,
    method: unknown,
    path: unknown,
    body?: unknown,
    opts?: unknown
  ) => {
    if (
      typeof provider !== "string" ||
      typeof method !== "string" ||
      typeof path !== "string"
    ) {
      throw new Error("callProvider: provider, method, path must be strings");
    }
    const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE"];
    if (!ALLOWED_METHODS.includes(method.toUpperCase())) {
      throw new Error(
        `callProvider: method "${method}" not allowed. Use: ${ALLOWED_METHODS.join(", ")}`
      );
    }
    const baseUrlOverride =
      typeof opts === "object" &&
      opts !== null &&
      typeof (opts as Record<string, unknown>).baseUrlOverride === "string"
        ? ((opts as Record<string, unknown>).baseUrlOverride as string)
        : undefined;
    let headers: Record<string, string> | undefined;
    const rawHeaders =
      typeof opts === "object" && opts !== null
        ? (opts as Record<string, unknown>).headers
        : undefined;
    if (
      typeof rawHeaders === "object" &&
      rawHeaders !== null &&
      !Array.isArray(rawHeaders)
    ) {
      const entries = Object.entries(
        rawHeaders as Record<string, unknown>
      ).filter(([, v]) => typeof v === "string") as [string, string][];
      if (entries.length > 0) headers = Object.fromEntries(entries);
    }
    // Dry-run: the provider is never called; the intended call is recorded
    // and a stub answers so the skill's control flow carries on.
    if (recordedEffects) {
      recordedEffects.push({
        kind: "callProvider",
        provider,
        method: method.toUpperCase(),
        path,
        body: typeof body === "object" && body !== null ? body : undefined,
        baseUrlOverride,
      });
      return {
        status: 200,
        headers: {},
        body: { dryRun: true },
      };
    }
    try {
      // GOVERNANCE: attach the acting agent identity ONLY for mutating methods
      // — with agentUserId set, the gate inside triggerProviderAction treats
      // the call as an agent run → an ungranted capability routes to a
      // PROPOSAL. Reads (GET) carry no agent identity, so they run inline.
      // EXCEPT a call to one of the verb's own required tools while the verb
      // itself was already decided (`verbAct`): that is the same act.
      const upper = method.toUpperCase();
      const isWrite = upper === "POST" || upper === "PUT" || upper === "DELETE";
      const result = await triggerProviderAction({
        userId: operatorUserId,
        provider,
        method: upper,
        path,
        body:
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)
            : undefined,
        baseUrlOverride,
        ...(headers ? { headers } : {}),
        ...(isWrite && agentUserId
          ? {
              agentUserId,
              workspaceId: workspaceId ?? undefined,
              // Session provenance rides ONLY the governed (write) branch,
              // the one that can file a proposal. Absent stays absent.
              ...(sessionId ? { sessionId } : {}),
            }
          : {}),
        // ONE governed act: this run's verb was already decided, so its
        // calls to its OWN required tools are not gated again (scoped in
        // triggerProviderAction — any other tool is still gated).
        ...(verbAct ? { verbAct } : {}),
      });
      // Map triggerProviderAction's structured result onto the SAME shape the
      // IS `executeProviderCall` returns: { status, headers, body } OR
      // { proposed, proposalId }; a structured failure throws.
      // A provider call that succeeds (or is proposed) means any EARLIER
      // failure on this run was recovered — clear the sink so a later,
      // unrelated failure doesn't surface a stale (e.g. re-auth) chip.
      if (result.proposed) {
        failureSink.errorClass = undefined;
        failureSink.providerRef = undefined;
        return {
          proposed: true,
          proposalId: result.proposalId,
        };
      }
      if (result.success) {
        failureSink.errorClass = undefined;
        failureSink.providerRef = undefined;
        return {
          status: result.status,
          headers: result.headers ?? {},
          body: result.body,
        };
      }
      // P1: stash the dispatcher's classification on the host-side sink
      // before throwing (the throw crosses the isolate boundary and would
      // drop it); the caller reads it on its failure return.
      failureSink.errorClass = result.errorClass;
      failureSink.providerRef = result.providerRef;
      throw new Error(result.error ?? "Provider call failed");
    } catch (err) {
      throw new Error(
        `callProvider failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ── propose.entity → hubProtocolRouter.entities.createEntity (governed) ──
  const proposeEntity = async (input: unknown) => {
    if (typeof input !== "object" || input === null) {
      throw new Error(
        "propose.entity: argument must be an object { profileSlug, title, properties? }"
      );
    }
    const {
      profileSlug,
      type,
      title,
      properties,
      content,
      description,
      reasoning,
      workspaceId: inputWorkspaceId,
    } = input as Record<string, unknown>;
    const slug = profileSlug ?? type;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error("propose.entity: profileSlug must be a non-empty string");
    }
    if (typeof title !== "string" || title.length === 0) {
      throw new Error("propose.entity: title must be a non-empty string");
    }
    if (
      properties !== undefined &&
      (typeof properties !== "object" || properties === null)
    ) {
      throw new Error("propose.entity: properties must be an object");
    }
    if (content !== undefined && typeof content !== "string") {
      throw new Error("propose.entity: content must be a string");
    }
    // Dry-run: no proposal is filed; the intended entity is recorded and a
    // synthetic handle answers so the skill can reference it.
    if (recordedEffects) {
      const n = ++dryRunSeq;
      recordedEffects.push({
        kind: "propose.entity",
        profileSlug: slug,
        title,
        properties:
          typeof properties === "object" && properties !== null
            ? (properties as Record<string, unknown>)
            : undefined,
        content: typeof content === "string" ? content : undefined,
      });
      return {
        status: "dry-run",
        proposalId: `dry:${n}`,
        proposedEntityId: `dry:${n}`,
      };
    }
    try {
      // The governed createEntity door: with agentUserId set, an agent write
      // routes to a reviewable PROPOSAL via checkPermissionOrPropose — never a
      // direct write. Same door the IS `createEntity` HTTP bridge hits.
      const result = await caller.entities.createEntity({
        userId: operatorUserId,
        ...(agentUserId ? { agentUserId } : {}),
        profileSlug: slug,
        title,
        description: typeof description === "string" ? description : undefined,
        // The long-form Markdown body: the door makes it the entity's
        // versioned document.
        content: typeof content === "string" ? content : undefined,
        properties:
          typeof properties === "object" && properties !== null
            ? (properties as Record<string, unknown>)
            : undefined,
        reasoning: typeof reasoning === "string" ? reasoning : undefined,
        // Default to the run's workspace so authors never thread it by hand;
        // an explicit workspaceId in the call still wins.
        workspaceId:
          typeof inputWorkspaceId === "string"
            ? inputWorkspaceId
            : (workspaceId ?? undefined),
        source: "intelligence",
      });
      return {
        status: result.status,
        proposalId: result.proposalId,
        proposedEntityId: result.id,
        message: result.message,
      };
    } catch (err) {
      throw new Error(
        `propose.entity failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return {
    log: bindHostCallback(log),
    search: bindHostCallback(search),
    getEntities: bindHostCallback(getEntities),
    getDocument: bindHostCallback(getDocument),
    redeemSecret: bindHostCallback(redeemSecret),
    hostFetch: bindHostCallback(hostFetch),
    callProvider: bindHostCallback(callProvider),
    proposeEntity: bindHostCallback(proposeEntity),
  };
}

/** Re-exported for callers that want the stamped runtime version. */
export { SKILL_RUNTIME_VERSION };
