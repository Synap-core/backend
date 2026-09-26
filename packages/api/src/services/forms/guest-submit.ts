/**
 * THE GUEST CREATE DOOR (Sites W4) — an anonymous internet caller submits a
 * public form and ONE governed `entity.create` is filed in the owner's pod.
 *
 * Founder contract, each line enforced here (tests: `__tests__/guest-*.test.ts`):
 *   - Intake only: exactly one `entity.create` through the gate. No update, no
 *     delete, no relation, no facet door is ever called from this module.
 *   - A NARROW door: it never calls `entities.create` for the guest write, never
 *     builds a hub caller context (`createHubProtocolCallerContext` trusts a
 *     caller-supplied userId), and reads nothing but field values from the body.
 *     Kind, facet, workspace, owner, actor and mode come from the stored row.
 *   - One actor per form, asserted HERE before the gate: the row must exist, be
 *     an agent, be this form's actor (`form:<id>`), belong to the form's owner,
 *     hold exactly `["entity.create"]` and be a member of the form's workspace.
 *     The gate itself grants a non-agent actor ("Permission granted" at the end
 *     of permission-check.ts) — so a dropped or retyped actor is REFUSED here,
 *     never handed to the gate.
 *   - Proposal unless the stored config says exactly `direct` AND the per-form
 *     rule says `auto` AND nothing degraded (captcha provider unreachable):
 *     `forcePropose` (rung 2.1) otherwise, above every rule.
 *   - A strong identity signal (email, phone, url…) that matches an existing
 *     entity NEVER reaches a person write: only a submission note is filed,
 *     with the email under a non-signal key. Both branches do the SAME awaited
 *     work (identity lookup, facet lookup, rule lookup, one gate call), and the
 *     route answers the same bytes whatever happened.
 *
 * `submitGuestForm` never throws. Its return value is for logs and tests ONLY —
 * the route discards it and always replies `202 {"received":true}`.
 */

import { createHash } from "node:crypto";
import {
  db,
  and,
  eq,
  gt,
  isNull,
  or,
  desc,
  drizzleSql,
  runWithActingAgent,
  resolveIdentity as resolveIdentityReal,
  extractIdentitySignals,
  IDENTITY_SIGNAL_PROPERTY_KEYS,
} from "@synap/database";
import {
  tools,
  users,
  workspaceMembers,
  governanceRules,
  profiles,
  proposals,
  ProposalStatus,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { hashToken } from "../../utils/share-token.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  FORM_ACTOR_CAPABILITIES,
  HONEYPOT_FIELD,
  SUBMISSION_NOTE_KIND,
  SubmissionEnvelopeSchema,
  buildPropertiesFromFields,
  formActorType,
  formRuleCreatedBy,
  parseStoredForm,
  verifyTicket,
  wantsDirect,
  type FormConfig,
  type StoredFormDefinition,
} from "./form-definition.js";
import {
  captchaConfigFromEnv,
  verifyCaptcha as verifyCaptchaReal,
  type CaptchaOutcome,
} from "./captcha.js";

const logger = createLogger({ module: "guest-form-submit" });

/** The public body cap (the transport also caps the stream at 16 KB). */
export const GUEST_FORM_MAX_BODY_BYTES = 16 * 1024;

/** THE reply. Every path, success or failure. */
export const GUEST_FORM_RECEIVED = Object.freeze({ received: true as const });

/** Internal outcome — logged and asserted by tests, never sent to the caller. */
export type GuestOutcome =
  | "too_large"
  | "bad_envelope"
  | "honeypot"
  | "unknown_form"
  | "ticket"
  | "captcha_failed"
  | "invalid_fields"
  | "actor_refused"
  | "denied"
  | "proposed"
  | "direct"
  | "direct_failed"
  | "error";

export interface LoadedForm {
  formId: string;
  workspaceId: string;
  ownerUserId: string;
  form: StoredFormDefinition;
}

export interface GuestPlan {
  branch: "subject" | "note";
  entityId: string;
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
  content?: string;
  facets?: Array<{ profileSlug: string; properties?: Record<string, unknown> }>;
}

/** Everything the door reads or writes, injectable so tests can observe it. */
export interface GuestDeps {
  now: () => number;
  loadFormByTokenHash: (tokenHash: string) => Promise<LoadedForm | null>;
  assertActor: (loaded: LoadedForm) => Promise<boolean>;
  verifyCaptcha: (token: string | undefined) => Promise<CaptchaOutcome>;
  resolveIdentity: (
    loaded: LoadedForm,
    properties: Record<string, unknown>
  ) => Promise<{ matchedEntityId: string | null }>;
  resolveFacet: (loaded: LoadedForm) => Promise<string | null>;
  resolveRuleVerdict: (
    loaded: LoadedForm
  ) => Promise<"auto" | "propose" | null>;
  gate: typeof checkPermissionOrPropose;
  stampExpiry: (
    loaded: LoadedForm,
    proposalId: string,
    nowMs: number
  ) => Promise<void>;
  materializeDirect: (input: {
    loaded: LoadedForm;
    plan: GuestPlan;
    receiptId: string | undefined;
  }) => Promise<void>;
}

// ── Pure planning ────────────────────────────────────────────────────────────

const SIGNAL_KEYS = new Set(
  Object.values(IDENTITY_SIGNAL_PROPERTY_KEYS).flat()
);

/** A stable, form-namespaced entity id: a replay collapses onto one proposal. */
export function idempotentEntityId(formId: string, key: string): string {
  const h = createHash("sha256").update(`form:${formId}:${key}`).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/** The idempotency key: the client's, or a hash of the canonical answers. */
export function idempotencyKeyFor(
  clientKey: string | undefined,
  properties: Record<string, unknown>
): string {
  if (clientKey && clientKey.trim()) return `k:${clientKey.trim()}`;
  const canonical = JSON.stringify(
    Object.keys(properties)
      .sort()
      .map((k) => [k, properties[k]])
  );
  return `h:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Decide WHAT is filed. On a strong identity match the subject write is
 * replaced by a submission note: no signal key survives into its properties
 * (the email moves to `submitterEmail`), the answers live in the body text.
 */
export function planGuestWrite(input: {
  formId: string;
  config: FormConfig;
  properties: Record<string, string | number | boolean>;
  matchedEntityId: string | null;
  facetSlug: string | null;
  idempotencyKey: string;
  now: Date;
}): GuestPlan {
  const { config, properties } = input;
  const entityId = idempotentEntityId(input.formId, input.idempotencyKey);
  if (input.matchedEntityId) {
    const email = config.fields.find((f) => f.type === "email");
    const emailValue = email ? properties[email.key] : undefined;
    const lines = config.fields
      .filter((f) => properties[f.key] !== undefined)
      .map((f) => `- ${f.label}: ${String(properties[f.key])}`);
    return {
      branch: "note",
      entityId,
      profileSlug: SUBMISSION_NOTE_KIND,
      title: `Form submission: ${config.name} (${input.now.toISOString()})`,
      properties: {
        formName: config.name,
        possibleMatchEntityId: input.matchedEntityId,
        ...(typeof emailValue === "string"
          ? { submitterEmail: emailValue }
          : {}),
      },
      content: lines.join("\n"),
    };
  }
  const titleValue = properties[config.titleField];
  return {
    branch: "subject",
    entityId,
    profileSlug: config.kind,
    title:
      typeof titleValue === "string" && titleValue
        ? titleValue
        : `Form submission: ${config.name}`,
    properties: { ...properties },
    ...(input.facetSlug
      ? {
          facets: [
            {
              profileSlug: input.facetSlug,
              ...(config.facet?.properties
                ? { properties: { ...config.facet.properties } }
                : {}),
            },
          ],
        }
      : {}),
  };
}

/** Defence in depth: a note plan must never carry an identity signal key. */
export function planCarriesSignal(plan: GuestPlan): boolean {
  return Object.keys(plan.properties).some((k) => SIGNAL_KEYS.has(k));
}

// ── The door ─────────────────────────────────────────────────────────────────

export async function submitGuestForm(
  input: { token: string; rawBody: string },
  deps: GuestDeps = defaultGuestDeps()
): Promise<GuestOutcome> {
  try {
    return await submitInner(input, deps);
  } catch (err) {
    // The token and the body are never logged.
    logger.error({ err }, "guest form submission failed");
    return "error";
  }
}

async function submitInner(
  input: { token: string; rawBody: string },
  deps: GuestDeps
): Promise<GuestOutcome> {
  if (Buffer.byteLength(input.rawBody, "utf8") > GUEST_FORM_MAX_BODY_BYTES) {
    return "too_large";
  }
  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return "bad_envelope";
  }
  const envelope = SubmissionEnvelopeSchema.safeParse(json);
  if (!envelope.success) return "bad_envelope";
  const body = envelope.data;

  const hp = body[HONEYPOT_FIELD];
  if (hp !== undefined && hp !== null && hp !== "") return "honeypot";

  if (!input.token || input.token.length > 256) return "unknown_form";
  const loaded = await deps.loadFormByTokenHash(hashToken(input.token));
  if (!loaded) return "unknown_form";
  const { form } = loaded;

  const nowMs = deps.now();
  if (
    !verifyTicket({
      secret: form.ticketSecret,
      formId: loaded.formId,
      ticket: body.ticket,
      minMs: form.config.limits.minSubmitMs,
      now: nowMs,
    })
  ) {
    return "ticket";
  }

  let degraded = false;
  if (form.config.captcha.enabled) {
    const outcome = await deps.verifyCaptcha(body.captchaToken);
    if (outcome === "fail") return "captcha_failed";
    if (outcome === "unavailable") degraded = true;
  }

  const properties = buildPropertiesFromFields(form.config.fields, body.fields);
  if (!properties) return "invalid_fields";

  // FAIL CLOSED on the actor BEFORE anything is filed.
  if (!(await deps.assertActor(loaded))) {
    logger.error(
      { formId: loaded.formId },
      "guest form refused: the form's actor is missing, not an agent, or not least-privilege"
    );
    return "actor_refused";
  }

  // Same awaited work on both identity branches (no timing oracle): identity,
  // facet and rule lookups always run, then exactly one gate call.
  const identity = await deps.resolveIdentity(loaded, properties);
  const facetSlug = await deps.resolveFacet(loaded);
  const ruleVerdict = await deps.resolveRuleVerdict(loaded);

  const plan = planGuestWrite({
    formId: loaded.formId,
    config: form.config,
    properties,
    matchedEntityId: identity.matchedEntityId,
    facetSlug,
    idempotencyKey: idempotencyKeyFor(body.idempotencyKey, properties),
    now: new Date(nowMs),
  });
  if (plan.branch === "note" && planCarriesSignal(plan)) {
    // Unreachable by construction; refuse rather than write a signal.
    return "error";
  }

  const direct = wantsDirect({
    storedMode: form.config.mode,
    ruleVerdict,
    degraded,
  });

  const perm = await runWithActingAgent(form.actorUserId, () =>
    deps.gate({
      userId: loaded.ownerUserId,
      agentUserId: form.actorUserId,
      workspaceId: loaded.workspaceId,
      subjectType: "entity",
      action: "create",
      forcePropose: !direct,
      reasoning: `Submitted through the public form "${form.config.name}".`,
      data: {
        id: plan.entityId,
        profileSlug: plan.profileSlug,
        title: plan.title,
        properties: plan.properties,
        ...(plan.content ? { content: plan.content } : {}),
        resolvedWorkspaceId: loaded.workspaceId,
        ...(plan.facets ? { facets: plan.facets } : {}),
      },
    })
  );

  if ("denied" in perm && perm.denied) {
    logger.warn(
      { formId: loaded.formId, reason: perm.reason },
      "guest form write refused by the gate"
    );
    return "denied";
  }
  if ("proposalId" in perm) {
    await deps.stampExpiry(loaded, perm.proposalId, nowMs);
    return "proposed";
  }
  // Granted: only reachable when `direct` was requested (forcePropose would
  // otherwise have proposed). Re-assert, never trust the gate alone.
  if (!direct) {
    logger.error(
      { formId: loaded.formId },
      "guest form: gate granted a forced proposal — refusing to materialize"
    );
    return "error";
  }
  try {
    await deps.materializeDirect({
      loaded,
      plan,
      receiptId:
        "autoApprovedProposalId" in perm
          ? perm.autoApprovedProposalId
          : undefined,
    });
    return "direct";
  } catch (err) {
    logger.warn(
      { err, formId: loaded.formId },
      "guest form direct create failed"
    );
    return "direct_failed";
  }
}

// ── Real dependencies ────────────────────────────────────────────────────────

/** Token → form row, by HASH only. Inactive or unparseable rows are misses. */
export async function loadFormByTokenHash(
  tokenHash: string
): Promise<LoadedForm | null> {
  const rows = await db
    .select({
      id: tools.id,
      workspaceId: tools.workspaceId,
      createdBy: tools.createdBy,
      status: tools.status,
      metadata: tools.metadata,
    })
    .from(tools)
    .where(drizzleSql`${tools.metadata}->'form'->>'tokenHash' = ${tokenHash}`)
    .limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.status !== "active" || !row.workspaceId) return null;
  const form = parseStoredForm(row.metadata);
  if (!form || form.tokenHash !== tokenHash) return null;
  return {
    formId: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.createdBy,
    form,
  };
}

/** The door's own actor floor — see the module header. */
export async function assertFormActor(loaded: LoadedForm): Promise<boolean> {
  const [actor] = await db
    .select({
      id: users.id,
      userType: users.userType,
      agentType: users.agentType,
      createdByUserId: users.createdByUserId,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(eq(users.id, loaded.form.actorUserId))
    .limit(1);
  if (!actor) return false;
  if (actor.userType !== "agent") return false;
  if (actor.agentType !== formActorType(loaded.formId)) return false;
  if (actor.createdByUserId !== loaded.ownerUserId) return false;
  const caps = (actor.agentMetadata as { capabilities?: unknown } | null)
    ?.capabilities;
  if (
    !Array.isArray(caps) ||
    caps.length !== FORM_ACTOR_CAPABILITIES.length ||
    !FORM_ACTOR_CAPABILITIES.every((c, i) => caps[i] === c)
  ) {
    return false;
  }
  const [member] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, loaded.workspaceId),
        eq(workspaceMembers.userId, actor.id)
      )
    )
    .limit(1);
  return !!member;
}

async function resolveIdentityForForm(
  _loaded: LoadedForm,
  properties: Record<string, unknown>
): Promise<{ matchedEntityId: string | null }> {
  // Strong signals only (no weak name path: `userScope` is omitted), and the
  // lookup ALWAYS runs — an empty signal list still takes the same call.
  const signals = extractIdentitySignals(properties);
  const res = await resolveIdentityReal(db, {
    userId: _loaded.ownerUserId,
    signals,
  });
  return {
    matchedEntityId:
      res.match === "strong" && res.entity ? res.entity.id : null,
  };
}

/** The form's facet, if that ROLE exists on this pod for this kind; else none. */
async function resolveFacetForForm(loaded: LoadedForm): Promise<string | null> {
  const slug = loaded.form.config.facet?.profileSlug ?? "";
  const rows = await db
    .select({
      slug: profiles.slug,
      applicableKinds: profiles.applicableKinds,
      workspaceId: profiles.workspaceId,
    })
    .from(profiles)
    .where(
      and(
        eq(profiles.slug, slug),
        eq(profiles.profileKind, "role"),
        eq(profiles.isActive, true),
        or(
          isNull(profiles.workspaceId),
          eq(profiles.workspaceId, loaded.workspaceId)
        )
      )
    )
    .limit(5);
  const kind = loaded.form.config.kind;
  const ok = rows.find(
    (r) => !r.applicableKinds?.length || r.applicableKinds.includes(kind)
  );
  return slug && ok ? slug : null;
}

/** The per-form mode rule (the forms door is its only writer). */
export async function resolveFormRuleVerdict(
  loaded: LoadedForm
): Promise<"auto" | "propose" | null> {
  const [rule] = await db
    .select({ verdict: governanceRules.verdict })
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.agentUserId, loaded.form.actorUserId),
        eq(governanceRules.scopeKind, "workspace"),
        eq(governanceRules.workspaceId, loaded.workspaceId),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.targetPattern, "entity.create"),
        eq(governanceRules.createdBy, formRuleCreatedBy(loaded.formId)),
        isNull(governanceRules.revokedAt),
        or(
          isNull(governanceRules.expiresAt),
          gt(governanceRules.expiresAt, new Date())
        )
      )
    )
    .orderBy(desc(governanceRules.createdAt))
    .limit(1);
  return (rule?.verdict as "auto" | "propose" | undefined) ?? null;
}

/**
 * Give a guest proposal its expiry. Only this form actor's still-PENDING row,
 * and only if nothing stamped one yet (a deduped replay keeps its first clock).
 */
async function stampGuestExpiry(
  loaded: LoadedForm,
  proposalId: string,
  nowMs: number
): Promise<void> {
  const expiresAt = new Date(
    nowMs + loaded.form.config.retentionDays * 24 * 60 * 60 * 1000
  );
  await db
    .update(proposals)
    .set({ expiresAt })
    .where(
      and(
        eq(proposals.id, proposalId),
        eq(proposals.agentUserId, loaded.form.actorUserId),
        eq(proposals.status, ProposalStatus.PENDING),
        isNull(proposals.expiresAt)
      )
    );
}

export function defaultGuestDeps(): GuestDeps {
  const captcha = captchaConfigFromEnv();
  return {
    now: () => Date.now(),
    loadFormByTokenHash,
    assertActor: assertFormActor,
    verifyCaptcha: (token) => verifyCaptchaReal(token, captcha),
    resolveIdentity: resolveIdentityForForm,
    resolveFacet: resolveFacetForForm,
    resolveRuleVerdict: resolveFormRuleVerdict,
    gate: checkPermissionOrPropose,
    stampExpiry: stampGuestExpiry,
    materializeDirect: async (i) => {
      const { materializeGuestDirect } =
        await import("./direct-materialize.js");
      await materializeGuestDirect(i);
    },
  };
}
