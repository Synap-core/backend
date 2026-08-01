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
 * Behind the `SANDBOX_LOCAL` flag (default OFF) — the chokepoint in
 * `execute-capability.ts` still calls `executeSkillViaIS` unless it is "1".
 */

import ivm from "isolated-vm";
import {
  db,
  eq,
  parseVaultReference,
  resolveVaultSecret,
  VaultGrantError,
} from "@synap/database";
import { skills, secrets } from "@synap/database/schema";
import { validateExternalUrl } from "@synap/shared-utils";
import { createLogger } from "@synap-core/core";
import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import { triggerProviderAction } from "../../connectors/external-dispatch.js";
import {
  SKILL_STDLIB_BOOTSTRAP,
  SKILL_RUNTIME_VERSION,
} from "./skill-stdlib.js";
import type { SkillExecutionResult } from "./execute-skill-via-is.js";
// Type-only import (erased at runtime — the value is loaded via dynamic import()
// below to avoid a static router↔service cycle). Gives the caller its real type.
import type { hubProtocolRouter } from "../../routers/hub-protocol/index.js";

/** The real Hub Protocol tRPC caller type — same door the REST handlers build. */
type HubCaller = ReturnType<typeof hubProtocolRouter.createCaller>;

const logger = createLogger({ module: "run-skill-in-sandbox" });

/** Maximum memory an isolate may allocate, in MB (parity with the IS executor). */
const ISOLATE_MEMORY_LIMIT_MB = 64;

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
  workspaceId: string | null
): Promise<string | null> {
  const parsed = parseVaultReference(ref);
  if (!parsed) return null;
  const secret = await db.query.secrets.findFirst({
    where: eq(secrets.id, parsed.secretId),
    columns: { userId: true },
  });
  if (!secret) return null;
  try {
    return await resolveVaultSecret(parsed.secretId, secret.userId, parsed.fieldName, {
      requireGrant: true,
      // Redeemer is the acting agent (or the operator when no agent key is in
      // play) — mirrors the vault REST door's `agentUserId ?? acting.userId`.
      redeemer: {
        agentUserId: agentUserId ?? operatorUserId,
        workspaceId: workspaceId ?? null,
      },
    });
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
}): Promise<SkillExecutionResult> {
  const startTime = Date.now();
  const operatorUserId = args.userId;
  const workspaceId = args.workspaceId ?? null;
  const agentUserId = args.agentUserId ?? null;

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

    const timeoutMs = (skill.timeoutSeconds ?? 30) * 1000;
    const allowedHosts =
      (skill.metadata?.allowedHosts as string[] | undefined) ?? [];

    // ONE caller, built with the operator floor — the same door the REST handlers
    // build. Reads scope to ctx.userId; the write bridges thread agentUserId as a
    // procedure INPUT (never via ctx), matching getCaller's asymmetry.
    const ctx = await createHubProtocolCallerContext(
      operatorUserId,
      HUB_SCOPES,
      workspaceId
    );
    const { hubProtocolRouter } = await import(
      "../../routers/hub-protocol/index.js"
    );
    const caller = hubProtocolRouter.createCaller(ctx as never);

    const result = await runIsolate({
      code: skill.code,
      args: args.parameters ?? {},
      context: { userId: operatorUserId, workspaceId, agentUserId },
      timeoutMs,
      allowedHosts,
      operatorUserId,
      workspaceId,
      agentUserId,
      caller,
    });

    return {
      success: true,
      result,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}

async function runIsolate(params: {
  code: string;
  args: Record<string, unknown>;
  context: {
    userId: string;
    workspaceId: string | null;
    agentUserId: string | null;
  };
  timeoutMs: number;
  allowedHosts: string[];
  operatorUserId: string;
  workspaceId: string | null;
  agentUserId: string | null;
  caller: HubCaller;
}): Promise<unknown> {
  const {
    code,
    args,
    context,
    timeoutMs,
    allowedHosts,
    operatorUserId,
    workspaceId,
    agentUserId,
    caller,
  } = params;

  const isolate = new ivm.Isolate({ memoryLimit: ISOLATE_MEMORY_LIMIT_MB });

  try {
    const vmContext = await isolate.createContext();
    const jail = vmContext.global;

    await jail.set("__args", new ivm.ExternalCopy(args).copyInto());
    await jail.set("__context", new ivm.ExternalCopy(context).copyInto());

    // ── console → backend logger ─────────────────────────────────────────────
    const logRef = new ivm.Reference((...logArgs: unknown[]) => {
      logger.info({ args: logArgs }, "[Skill]");
    });
    await jail.set("__log", logRef);

    // ── hubProtocol.search → hubProtocolRouter.search.search ─────────────────
    const searchRef = new ivm.Reference(
      async (query: unknown, opts: unknown) => {
        const result = await caller.search.search({
          userId: operatorUserId,
          query: String(query),
          ...((opts as object | null) ?? {}),
        });
        return new ivm.ExternalCopy(result).copyInto();
      }
    );

    // ── hubProtocol.getEntities → hubProtocolRouter.entities.getEntities ─────
    const getEntitiesRef = new ivm.Reference(async (opts: unknown) => {
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
      return new ivm.ExternalCopy(result).copyInto();
    });

    // ── hubProtocol.getDocument → hubProtocolRouter.documents.getDocument ────
    const getDocumentRef = new ivm.Reference(async (documentId: unknown) => {
      const result = (await caller.documents.getDocument({
        documentId: String(documentId),
        userId: operatorUserId,
      })) as { document?: unknown } | null;
      // The IS bridge returns `data.document`; the door returns the same shape.
      const doc =
        result && typeof result === "object" && "document" in result
          ? (result as { document?: unknown }).document
          : result;
      return new ivm.ExternalCopy(doc ?? null).copyInto();
    });

    await jail.set("__search", searchRef);
    await jail.set("__getEntities", getEntitiesRef);
    await jail.set("__getDocument", getDocumentRef);

    // ── secrets.get → grant-gated vault resolver (direct) ────────────────────
    const redeemSecretRef = new ivm.Reference(async (ref: unknown) => {
      const value = await redeemVaultSecretDirect(
        String(ref),
        operatorUserId,
        agentUserId,
        workspaceId
      );
      return new ivm.ExternalCopy(value ?? null).copyInto();
    });
    await jail.set("__redeemSecret", redeemSecretRef);

    // ── host.fetch → external egress (SSRF + allowedHosts guarded) ───────────
    const hostFetchRef = new ivm.Reference(
      async (urlStr: unknown, optsStr?: unknown) => {
        const url = String(urlStr);

        const check = validateExternalUrl(url);
        if (!check.valid) {
          return new ivm.ExternalCopy({
            error: "url_rejected",
            message: check.reason,
          }).copyInto();
        }

        if (!allowedHosts.includes(check.url.hostname)) {
          return new ivm.ExternalCopy({
            error: "domain_not_approved",
            hostname: check.url.hostname,
            message: `Domain "${check.url.hostname}" is not approved. The agent should propose access.`,
          }).copyInto();
        }

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          try {
            const response = await fetch(url, {
              ...(typeof optsStr === "string" ? JSON.parse(optsStr) : {}),
              signal: controller.signal,
            });
            const body = await response.text();
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              headers[key] = value;
            });
            return new ivm.ExternalCopy({
              ok: response.ok,
              status: response.status,
              headers,
              body: body.slice(0, 100_000), // cap response size
            }).copyInto();
          } finally {
            clearTimeout(timeout);
          }
        } catch (err) {
          return new ivm.ExternalCopy({
            error: "fetch_failed",
            message: err instanceof Error ? err.message : "Fetch failed",
          }).copyInto();
        }
      }
    );
    await jail.set("__hostFetch", hostFetchRef);

    // ── callProvider → triggerProviderAction (governed, agent-gated) ─────────
    const callProviderRef = new ivm.Reference(
      async (
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
          throw new Error(
            "callProvider: provider, method, path must be strings"
          );
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
        try {
          // GOVERNANCE: attach the acting agent identity ONLY for mutating methods
          // — with agentUserId set, the gate inside triggerProviderAction treats
          // the call as an agent run → an ungranted capability routes to a
          // PROPOSAL. Reads (GET) carry no agent identity, so they run inline.
          const upper = method.toUpperCase();
          const isWrite =
            upper === "POST" || upper === "PUT" || upper === "DELETE";
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
              ? { agentUserId, workspaceId: workspaceId ?? undefined }
              : {}),
          });
          // Map triggerProviderAction's structured result onto the SAME shape the
          // IS `executeProviderCall` returns: { status, headers, body } OR
          // { proposed, proposalId }; a structured failure throws.
          if (result.proposed) {
            return new ivm.ExternalCopy({
              proposed: true,
              proposalId: result.proposalId,
            }).copyInto();
          }
          if (result.success) {
            return new ivm.ExternalCopy({
              status: result.status,
              headers: result.headers ?? {},
              body: result.body,
            }).copyInto();
          }
          throw new Error(result.error ?? "Provider call failed");
        } catch (err) {
          throw new Error(
            `callProvider failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    );
    await jail.set("__callProvider", callProviderRef);

    // ── propose.entity → hubProtocolRouter.entities.createEntity (governed) ──
    const proposeEntityRef = new ivm.Reference(async (input: unknown) => {
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
        description,
        reasoning,
        workspaceId: inputWorkspaceId,
      } = input as Record<string, unknown>;
      const slug = profileSlug ?? type;
      if (typeof slug !== "string" || slug.length === 0) {
        throw new Error(
          "propose.entity: profileSlug must be a non-empty string"
        );
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
      try {
        // The governed createEntity door: with agentUserId set, an agent write
        // routes to a reviewable PROPOSAL via checkPermissionOrPropose — never a
        // direct write. Same door the IS `createEntity` HTTP bridge hits.
        const result = await caller.entities.createEntity({
          userId: operatorUserId,
          ...(agentUserId ? { agentUserId } : {}),
          profileSlug: slug,
          title,
          description:
            typeof description === "string" ? description : undefined,
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
              : workspaceId ?? undefined,
          source: "intelligence",
        });
        return new ivm.ExternalCopy({
          status: result.status,
          proposalId: result.proposalId,
          proposedEntityId: result.id,
          message: result.message,
        }).copyInto();
      } catch (err) {
        throw new Error(
          `propose.entity failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
    await jail.set("__proposeEntity", proposeEntityRef);

    // Bootstrap the co-located skill-runtime stdlib inside the isolate — installs
    // every host bridge + web polyfill and is the byte-equal twin of the IS SSOT.
    await vmContext.eval(SKILL_STDLIB_BOOTSTRAP);

    // Async wrapper so skills can use top-level await.
    const wrappedCode = `
      (async function(args, context) {
        ${code}
      })(__args, __context)
    `;

    const script = await isolate.compileScript(wrappedCode);

    const result = await script.run(vmContext, {
      timeout: timeoutMs,
      promise: true,
      copy: true,
    });

    if (result instanceof ivm.Reference) {
      return result.copy();
    }

    return result;
  } finally {
    if (!isolate.isDisposed) {
      isolate.dispose();
    }
  }
}

/** Re-exported for callers that want the stamped runtime version. */
export { SKILL_RUNTIME_VERSION };
