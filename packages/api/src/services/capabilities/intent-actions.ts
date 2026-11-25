/**
 * INTENT ACTIONS — what a pod app may ask the person's tools to do for ONE
 * intent, and how its ask becomes a run (intent actions, decision 3A, founder
 * 2026-10-28).
 *
 * An app holding `capability.<intent>.run` in a space lists the actions for
 * that intent (`GET /capabilities/actions?intent`) and asks one of them to run
 * (`POST /capabilities/execute { intent, actionId, input }`). It never sees a
 * verb id, a skill id or a verb's raw parameters: each action carries an
 * opaque id, the pod's own words for it (the verb's label, the tool's name,
 * the account) and the ONE input it accepts — the intent's input schema
 * narrowed to what that verb's map reads (`intent-input.ts`).
 *
 * Built from the SAME rows as every other door, never a second lookup:
 *  - the registry (`listCapabilities`) and the runnable projection
 *    (`projectWithSource`), filtered through the shared reverse index
 *    (`foldVerbsByIntent`), exactly as the actions door's `?intent=` filter;
 *  - each verb's answering skill, by the run door's own rule
 *    (`answeringSkillsWhere` + `answeringSkillOrder`), which must DECLARE the
 *    intent (`skills.intent`, the authority) and carry an input map;
 *  - accounts: the map's account source, run through `executeCapability` (a
 *    declared read, pinned to the same tool), or the tool's pod connections
 *    (`listCredentials`) when there are several; otherwise none.
 *
 * Re-listing is how a run re-resolves its action: an account that is gone, or
 * a verb that lost its map or its approval, is no longer listed (404).
 *
 * RECIPIENT (CRM consolidation, Lane 2). A map that reads `$to.<address>`
 * sends to the person or company the input's `to` names; the pod finds the
 * address for each action's account (`intent-recipient.ts`). Listed for a
 * subject, each action says whether it can reach them (`reach`) and the list
 * is ranked: reachable first, then the channel last used with them, then the
 * order the pod lists tools in.
 *
 * UNAVAILABLE (plan 498b6be3 S1, founder D5 "show all reasons", D-D one entry
 * per tool and account, 13 Nov 2026). Every verb that declares the intent but
 * is not offered is listed in `unavailable` with WHY (a stable key, never
 * renamed: {@link IntentUnavailableWhy}), the pod's own sentence, and the fix
 * (`CapabilityNextAction`, with `update` for a held update). An empty
 * `actions` therefore never stands for "the pod could not tell": a read that
 * failed (a tool's accounts or connections) is an entry with
 * `retryable: true`, never an empty list.
 */
import { createHash } from "node:crypto";
import { db, skills, and, inArray } from "@synap/database";
import { humanizeToken, resolveToolLabel } from "@synap-core/types/vocabulary";
import type { SkillInputMap } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { ConnectionSelector } from "../../connectors/external-dispatch.js";
import { listCapabilities } from "./capability-registry.js";
import { foldVerbsByIntent } from "./capability-intent-index.js";
import {
  projectWithSource,
  withheldWithSource,
  type WithheldVerb,
} from "./action-projection.js";
import {
  capabilityNextAction,
  capabilityUpdateAction,
  resolveCapabilityBlock,
  type CapabilityNextAction,
} from "./capability-enable-link.js";
import { answeringSkillOrder, answeringSkillsWhere } from "./verb-skill.js";
import { checkVerbParameters } from "./validate-verb-parameters.js";
import { listCredentials } from "./capability-connections.js";
import { executeCapability } from "./execute-capability.js";
import { loadIntentInput, type IntentInputRow } from "./intent-registry.js";
import {
  accountsFromRecords,
  actionInputSchema,
  mapIntentInput,
  readInputMap,
  recipientAddressesRead,
  RECIPIENT_INPUT_FIELD,
  validateInput,
  type InputIssue,
  type IntentAccount,
  type RecipientAddresses,
} from "./intent-input.js";
import {
  lastUsedWith,
  loadRecipient,
  resolveRecipient,
  type IntentRecipient,
  type RecipientTarget,
} from "./intent-recipient.js";

const logger = createLogger({ module: "intent-actions" });

/** One action as a pod app sees it: the pod's words, never its internals. */
export interface IntentActionView {
  /** Opaque: stable for one verb and account, meaningless outside this pod. */
  id: string;
  /** The verb's own label. */
  label: string;
  /** The tool's name. */
  tool: string;
  /** The provider and the account this action reaches, when it names one. */
  connection: { provider: string | null; account: string | null } | null;
  /** What a run does: `propose` = the person approves it in their pod. */
  governance: "auto" | "propose";
  intent: string;
  /** The JSON Schema of the ONE input this action accepts. */
  input: Record<string, unknown>;
  /**
   * Listed for a subject only: can this action reach them? `why` is one
   * plain sentence when it cannot ("No email on file for Marie Dupont.").
   */
  reach?: { ok: boolean; why?: string };
}

/**
 * Why a verb that declares the intent is not offered. A public contract, like
 * an AIP-193 `reason`: a key is never renamed or reused; a new cause gets a
 * new key. An app branches on it and never shows it; it shows `label`.
 *  - `no_input_schema`: this pod has no input shape for the intent, so no app
 *    can ask for it yet (no tool named);
 *  - `not_enabled`: the tool, or this action of it, is not turned on;
 *  - `not_connected`: the tool needs an account connection it does not have;
 *  - `not_launchable`: the pod cannot run it for an app (catalog only,
 *    inactive, or no runnable backing skill); nothing in the pod fixes it;
 *  - `update_waiting`: the tool's installed version does not offer this and
 *    its update, which does, waits for the person;
 *  - `intent_not_declared`: the tool's installed version does not offer this
 *    (no update known);
 *  - `no_input_map`: the tool offers this but says nothing of how an app's
 *    input fills it (no update known);
 *  - `no_account`: the tool lists no account to act from;
 *  - `connection_expired`: one of the tool's accounts must be reconnected;
 *  - `accounts_unreadable`: the pod could not read the tool's accounts or
 *    connections (`retryable` says whether asking again may help).
 */
export type IntentUnavailableWhy =
  | "no_input_schema"
  | "not_enabled"
  | "not_connected"
  | "not_launchable"
  | "update_waiting"
  | "intent_not_declared"
  | "no_input_map"
  | "no_account"
  | "connection_expired"
  | "accounts_unreadable";

/** One withheld tool (or account of it), as a pod app reads it. */
export interface IntentUnavailable {
  why: IntentUnavailableWhy;
  /** The pod's own sentence, safe to show the person. */
  label: string;
  /** The tool's name; null when no tool is concerned (`no_input_schema`). */
  tool: string | null;
  /** The provider and the account concerned, when the cause names one. */
  connection: { provider: string | null; account: string | null } | null;
  /** True only when the same request may succeed later (a failed read). */
  retryable: boolean;
  /** What unblocks it and where; null when nothing in the pod does. */
  fix: CapabilityNextAction | null;
}

/** An action and what running it needs (server side only). */
export interface ResolvedIntentAction {
  view: IntentActionView;
  skillId: string;
  verbId: string;
  map: SkillInputMap;
  account: IntentAccount | null;
  connectionSelector: ConnectionSelector | null;
}

/** The account and provider an action reaches, as the recipient resolver reads it. */
const targetOf = (a: ResolvedIntentAction): RecipientTarget => ({
  account: a.account,
  provider: a.view.connection?.provider ?? null,
});

export interface IntentActionsContext {
  userId: string;
  workspaceId: string;
  agentUserId: string | null;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url").slice(0, 16);

/**
 * The opaque action id: one part per verb (its skill), one per account. Two
 * parts so a run can tell "this verb serves another intent" (INTENT_MISMATCH)
 * from "no such action" (404) without the id naming the verb.
 */
export function intentActionId(skillId: string, accountKey: string): string {
  return `${digest(`skill:${skillId}`)}.${digest(`account:${accountKey}`)}`;
}

/** The records an account source's run returned: its list, wherever it sits. */
function recordsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object")
    return (Object.values(result).find(Array.isArray) as unknown[]) ?? [];
  return [];
}

/**
 * The accounts an account source lists, run as any other read of the tool
 * (`executeCapability`, pinned to the tool row; a declared read runs without
 * review). `observability: "mirror"`: listing accounts is the pod's own
 * bookkeeping, never a fact to recall. Anything but a run is a failed read,
 * never "no account": `ok: false` carries what the run door said (its fix,
 * and whether asking again may help).
 */
async function listSourceAccounts(
  ctx: IntentActionsContext,
  map: SkillInputMap,
  toolId: string | null
): Promise<
  | { ok: true; accounts: IntentAccount[] }
  | {
      ok: false;
      why: "not_enabled" | "not_connected" | "accounts_unreadable";
      retryable: boolean;
      fix: CapabilityNextAction | null;
    }
> {
  const source = map.accounts!;
  let outcome: Awaited<ReturnType<typeof executeCapability>>;
  try {
    outcome = await executeCapability({
      verbId: source.verb,
      parameters: {},
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      agentUserId: ctx.agentUserId,
      ...(toolId ? { toolId } : {}),
      observability: "mirror",
    });
  } catch (err) {
    logger.warn(
      { err, verb: source.verb },
      "intent actions: the account source threw"
    );
    return {
      ok: false,
      why: "accounts_unreadable",
      retryable: true,
      fix: null,
    };
  }
  if (outcome.kind === "run")
    return {
      ok: true,
      accounts: accountsFromRecords(source, recordsOf(outcome.result)),
    };
  logger.warn(
    { verb: source.verb, outcome: outcome.kind },
    "intent actions: the account source did not run"
  );
  // The run door's own fix, when it named one: a refusal (`deny`) is an
  // approval problem (`enable`), a failed run with `enable` is a dead
  // connection (`connect`). A failed run with none may pass next time.
  const fix =
    (outcome.kind === "deny" || outcome.kind === "error") && outcome.enable
      ? outcome.enable
      : null;
  if (fix?.kind === "enable")
    return { ok: false, why: "not_enabled", retryable: false, fix };
  if (fix?.kind === "connect")
    return { ok: false, why: "not_connected", retryable: false, fix };
  return {
    ok: false,
    why: "accounts_unreadable",
    retryable: outcome.kind === "error",
    fix,
  };
}

/**
 * A tool's pod connections: the live ones (one action each when several) and
 * the ones that must be reconnected. A failed read is `ok: false`, never an
 * empty list.
 */
async function listConnections(
  ctx: IntentActionsContext,
  toolId: string
): Promise<
  | {
      ok: true;
      connected: Array<{ id: string; label: string; provider: string | null }>;
      expired: Array<{ label: string; provider: string | null }>;
    }
  | { ok: false }
> {
  let creds: Awaited<ReturnType<typeof listCredentials>>;
  try {
    creds = await listCredentials(toolId, ctx.userId);
  } catch (err) {
    logger.warn({ err, toolId }, "intent actions: connections unreadable");
    return { ok: false };
  }
  const persisted = creds.filter((c) => c.persisted);
  return {
    ok: true,
    connected: persisted
      .filter((c) => c.health === "connected")
      .map((c) => ({
        id: c.id,
        label: c.accountHint ?? c.label,
        provider: c.provider,
      })),
    expired: persisted
      .filter((c) => c.health !== "connected")
      .map((c) => ({ label: c.accountHint ?? c.label, provider: c.provider })),
  };
}

/** The tool's name as an action shows it: the tool row's, or the skill's container's. */
function toolNameOf(source: { kind: string; name: string }): string {
  return source.kind !== "skill"
    ? humanizeToken(source.name)
    : ((source as { containerName?: string | null }).containerName ??
        humanizeToken(source.name));
}

/** The registry row's container (its card), when it has one. */
const containerIdOf = (source: unknown): string | null =>
  (source as { containerId?: string | null }).containerId ?? null;

/** The pod's sentence for each cause. Names the tool; never a verb id. */
function unavailableLabel(
  why: IntentUnavailableWhy,
  tool: string | null,
  account: string | null,
  intent: string
): string {
  const t = tool ?? "This tool";
  switch (why) {
    case "no_input_schema":
      return `Apps cannot ask for "${humanizeToken(intent)}" on this pod yet.`;
    case "not_enabled":
      return `${t} is installed, but this action of it is turned off.`;
    case "not_connected":
      return `${t} is not connected to an account.`;
    case "not_launchable":
      return `${t} cannot run this for an app.`;
    case "update_waiting":
      return `${t} has an update waiting for you that adds this.`;
    case "intent_not_declared":
      return `The version of ${t} on this pod does not offer this.`;
    case "no_input_map":
      return `The version of ${t} on this pod cannot take this from an app yet.`;
    case "no_account":
      return `${t} has no account to act from.`;
    case "connection_expired":
      return account
        ? `The account ${account} in ${t} must be reconnected.`
        : `An account in ${t} must be reconnected.`;
    case "accounts_unreadable":
      return `The pod could not read the accounts of ${t}.`;
  }
}

/**
 * One withheld verb's causes, as the door names them: catalog-only, inactive
 * and unlaunchable read alike (`not_launchable`: nothing in the pod fixes
 * them). Each cause carries its own fix, from the SAME resolver the
 * registry's `blocked` uses (`resolveCapabilityBlock`): `not_connected` from
 * the row's connection (folded as the registry folds it), `not_enabled` from
 * the verb's own enable door when the registry stamped one, else the row's.
 */
function withheldCauses(
  w: WithheldVerb
): Array<{ why: IntentUnavailableWhy; fix: CapabilityNextAction | null }> {
  const causes: Array<{
    why: IntentUnavailableWhy;
    fix: CapabilityNextAction | null;
  }> = [];
  const name = w.source.name;
  const containerId = containerIdOf(w.source);
  for (const reason of w.reasons) {
    if (reason === "not_connected") {
      const c = w.source.connection!;
      causes.push({
        why: "not_connected",
        fix:
          resolveCapabilityBlock({
            name,
            containerId,
            connection: {
              required: true,
              kind: "provider",
              provider: c.provider,
              state: "missing",
            },
            enabled: true,
          }) ?? null,
      });
    } else if (reason === "not_enabled") {
      causes.push({
        why: "not_enabled",
        fix:
          w.enable ??
          resolveCapabilityBlock({ name, containerId, enabled: false }) ??
          null,
      });
    } else if (!causes.some((c) => c.why === "not_launchable")) {
      causes.push({ why: "not_launchable", fix: null });
    }
  }
  return causes;
}

/** What the door lists for one intent: what runs, and what does not and why. */
export interface IntentActionsListing {
  row: IntentInputRow;
  actions: ResolvedIntentAction[];
  unavailable: IntentUnavailable[];
}

/**
 * Every action this intent offers the caller in this space, and every verb
 * declaring it that is not offered (`unavailable`, with why), or null when
 * the intent is unknown. An intent with no input shape offers none (one
 * `no_input_schema` entry). With a `subject` (a recipient the caller may
 * read), each action carries its `reach` and the list is ranked for that
 * person.
 */
export async function listIntentActions(
  ctx: IntentActionsContext,
  intent: string,
  opts: { subject?: IntentRecipient } = {}
): Promise<IntentActionsListing | null> {
  const listed = await listUnranked(ctx, intent);
  if (!listed || !opts.subject) return listed;
  return { ...listed, actions: rankFor(opts.subject, listed.actions) };
}

/**
 * The containers whose catalog template moved past the version they hold
 * (`containersWithChangedTemplates`, the reconcile's own read of the stamps
 * against the official cache): an installed version that lacks what the
 * template now declares is then an update waiting, not a dead end. Imported
 * on demand: the reconcile module reaches the whole applier and its routers,
 * and this door needs it only when an answering skill falls short.
 */
async function containersWithUpdate(): Promise<Set<string>> {
  const { containersWithChangedTemplates } =
    await import("./reconcile-capabilities-to-templates.js");
  return new Set((await containersWithChangedTemplates()).map((c) => c.id));
}

/**
 * Each action's reach for this recipient, and the list ranked: reachable
 * first, then the one last used with them (newest first), then as listed
 * (`Array.prototype.sort` is stable). An action whose map names no
 * recipient reaches them trivially and has no "last used".
 */
function rankFor(
  subject: IntentRecipient,
  actions: ResolvedIntentAction[]
): ResolvedIntentAction[] {
  const scored = actions.map((a) => {
    const addresses = recipientAddressesRead(a.map);
    const target = targetOf(a);
    const resolved = resolveRecipient(subject, addresses, target);
    const reach = resolved.ok ? { ok: true } : { ok: false, why: resolved.why };
    return {
      action: { ...a, view: { ...a.view, reach } },
      ok: resolved.ok,
      last: addresses.length ? lastUsedWith(subject, addresses, target) : null,
    };
  });
  scored.sort((x, y) => {
    if (x.ok !== y.ok) return x.ok ? -1 : 1;
    if (x.last === y.last) return 0;
    if (x.last === null) return 1;
    if (y.last === null) return -1;
    return y.last - x.last;
  });
  return scored.map((s) => s.action);
}

async function listUnranked(
  ctx: IntentActionsContext,
  intent: string
): Promise<IntentActionsListing | null> {
  const row = await loadIntentInput(intent);
  if (!row) return null;
  const unavailable: IntentUnavailable[] = [];
  // One entry per tool and account and cause (D-D): two verbs of one tool
  // withheld for one cause say it once.
  const seen = new Set<string>();
  const withhold = (
    why: IntentUnavailableWhy,
    tool: string | null,
    connection: IntentUnavailable["connection"],
    fix: CapabilityNextAction | null,
    retryable = false
  ) => {
    const key = JSON.stringify([why, tool, connection?.account ?? null]);
    if (seen.has(key)) return;
    seen.add(key);
    unavailable.push({
      why,
      label: unavailableLabel(why, tool, connection?.account ?? null, intent),
      tool,
      connection,
      retryable,
      fix,
    });
  };
  if (!row.inputSchema) {
    withhold("no_input_schema", null, null, null);
    return { row, actions: [], unavailable };
  }

  const capabilities = await listCapabilities({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });
  const matches = foldVerbsByIntent(capabilities).get(intent) ?? [];
  const matched = new Set(matches.map((m) => m.verbId));
  const projected = projectWithSource(capabilities).filter(
    ({ action }) => !!action.verbId && matched.has(action.verbId)
  );

  // The verbs declaring the intent that no row projects, each read off the
  // row the shared fold chose for it (a tool row before its skill or a
  // container copy), with every reason the projection withheld it for.
  const offered = new Set(projected.map(({ action }) => action.verbId!));
  const chosenRow = new Map(matches.map((m) => [m.verbId, m.capabilityId]));
  const withheldByVerb = new Map<string, WithheldVerb>();
  for (const w of withheldWithSource(capabilities)) {
    if (!matched.has(w.verbId) || offered.has(w.verbId)) continue;
    const prior = withheldByVerb.get(w.verbId);
    if (!prior || w.source.id === chosenRow.get(w.verbId))
      withheldByVerb.set(w.verbId, w);
  }
  for (const w of withheldByVerb.values()) {
    const provider = w.source.connection?.required
      ? w.source.connection.provider
      : null;
    for (const cause of withheldCauses(w))
      withhold(
        cause.why,
        toolNameOf(w.source),
        provider ? { provider, account: null } : null,
        cause.fix
      );
  }
  if (projected.length === 0) return { row, actions: [], unavailable };

  // Each verb's answering skill, by the run door's rule: the first row per
  // name in its order. It must DECLARE this intent and carry a map.
  const names = [...offered];
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      kind: skills.kind,
      intent: skills.intent,
      inputMap: skills.inputMap,
      parameters: skills.parameters,
    })
    .from(skills)
    .where(
      and(
        answeringSkillsWhere(ctx.userId, ctx.workspaceId),
        inArray(skills.name, names)
      )
    )
    .orderBy(...answeringSkillOrder());
  const skillByName = new Map<string, (typeof rows)[number]>();
  for (const r of rows)
    if (!skillByName.has(r.name)) skillByName.set(r.name, r);

  // An installed skill that falls short of the intent: an update waiting
  // when its container's template moved on (read once, only when needed).
  let updates: Promise<Set<string> | null> | null = null;
  const shortOf = async (
    source: (typeof projected)[number]["source"],
    why: "intent_not_declared" | "no_input_map" | "not_launchable"
  ) => {
    const containerId = containerIdOf(source);
    // No container, no template: nothing can be waiting for it.
    if (!containerId) {
      withhold(why, toolNameOf(source), null, null);
      return;
    }
    const pending = (updates ??= containersWithUpdate().catch(
      (err: unknown) => {
        logger.warn(
          { err },
          "intent actions: could not read which capabilities have an update"
        );
        return null;
      }
    ));
    const withUpdate = await pending;
    if (withUpdate?.has(containerId)) {
      withhold(
        "update_waiting",
        toolNameOf(source),
        null,
        capabilityUpdateAction(containerId)
      );
      return;
    }
    // No update known: what is installed falls short. When the update read
    // itself failed, that is still true, and asking again may find one.
    withhold(why, toolNameOf(source), null, null, withUpdate === null);
  };

  const actions: ResolvedIntentAction[] = [];
  for (const { action, source } of projected) {
    const skill = skillByName.get(action.verbId!);
    if (!skill) {
      await shortOf(source, "not_launchable");
      continue;
    }
    if (skill.intent !== intent) {
      await shortOf(source, "intent_not_declared");
      continue;
    }
    const map = readInputMap(skill.inputMap);
    if (!map) {
      await shortOf(source, "no_input_map");
      continue;
    }

    const check = checkVerbParameters(skill, {});
    const required = check.status === "invalid" ? check.repair.missing : [];
    const isToolRow = source.kind !== "skill";
    const toolName = toolNameOf(source);
    const base = {
      label:
        action.label && action.label !== action.verbId
          ? action.label
          : resolveToolLabel(action.verbId!, "imperative"),
      tool: toolName,
      governance:
        row.effect !== "read" ? ("propose" as const) : action.governance,
      intent,
      input: actionInputSchema(row.inputSchema, map, required),
    };
    const resolved = (
      accountKey: string,
      account: IntentAccount | null,
      connectionSelector: ConnectionSelector | null,
      connection: IntentActionView["connection"]
    ): ResolvedIntentAction => ({
      view: { id: intentActionId(skill.id, accountKey), ...base, connection },
      skillId: skill.id,
      verbId: skill.name,
      map,
      account,
      connectionSelector,
    });

    if (map.accounts) {
      const listed = await listSourceAccounts(
        ctx,
        map,
        isToolRow ? source.id : null
      );
      if (!listed.ok) {
        withhold(listed.why, toolName, null, listed.fix, listed.retryable);
        continue;
      }
      if (listed.accounts.length === 0)
        withhold("no_account", toolName, null, null);
      for (const account of listed.accounts)
        actions.push(
          resolved(`a:${account.id}`, account, null, {
            provider: account.provider,
            account: account.label,
          })
        );
      continue;
    }
    const provider = action.connection?.provider ?? null;
    if (isToolRow && action.connection?.required) {
      const connections = await listConnections(ctx, source.id);
      if (!connections.ok) {
        // Which account it would act from is unknown: no action is offered
        // on a guess, and the failed read is said, never an empty list.
        withhold(
          "accounts_unreadable",
          toolName,
          provider ? { provider, account: null } : null,
          null,
          true
        );
        continue;
      }
      for (const c of connections.expired) {
        const p = c.provider ?? provider;
        withhold(
          "connection_expired",
          toolName,
          { provider: p, account: c.label },
          capabilityNextAction(
            "needs_connection",
            source.name,
            {
              required: true,
              kind: "provider",
              ...(p ? { provider: p } : {}),
              state: "expired",
            },
            containerIdOf(source)
          )
        );
      }
      if (connections.connected.length > 1) {
        for (const c of connections.connected)
          actions.push(
            resolved(
              `c:${c.id}`,
              { id: c.id, label: c.label, provider: c.provider ?? provider },
              { connectionId: c.id },
              { provider: c.provider ?? provider, account: c.label }
            )
          );
        continue;
      }
    }
    actions.push(
      resolved("", null, null, provider ? { provider, account: null } : null)
    );
  }
  return { row, actions, unavailable };
}

/** What `POST /capabilities/execute` runs for an app's intent action. */
export type IntentRunResolution =
  | { kind: "unknown_intent" }
  | { kind: "not_found" }
  | { kind: "intent_mismatch" }
  | { kind: "invalid_input"; issues: InputIssue[] }
  /** `to` names nothing the caller may read. */
  | { kind: "subject_not_readable" }
  /** The pod has no address for `to` on this action's account. */
  | { kind: "recipient_unreachable"; why: string }
  | {
      kind: "ok";
      effect: string;
      skillId: string;
      verbId: string;
      parameters: Record<string, unknown>;
      connectionSelector: ConnectionSelector | null;
      /** For the approval screen: carried on the proposal (`intentRequest`). */
      intentRequest: IntentRequestRecord;
    };

/** What a proposal records about the app's ask, for the person's review. */
export interface IntentRequestRecord {
  intent: string;
  actionId: string;
  tool: string;
  label: string;
  account: IntentAccount | null;
  /** Who it goes to, by name (the input's `to`), when the action names one. */
  recipient: { id: string; name: string } | null;
  /** The app's input, as validated — the exact words it asked to send. */
  input: Record<string, unknown>;
}

/**
 * Resolve an app's ask: the action (re-listed, so a gone account is a 404),
 * the input checked against what that action accepts (a field it does not
 * map is refused, never dropped), then mapped onto the verb's parameters. A
 * recipient's addresses are resolved here, at run time, from the pod's own
 * rows: never from anything the app sent but the entity id.
 */
export async function resolveIntentRun(
  ctx: IntentActionsContext,
  ask: { intent: string; actionId: string; input: unknown }
): Promise<IntentRunResolution> {
  const listed = await listIntentActions(ctx, ask.intent);
  if (!listed) return { kind: "unknown_intent" };
  const found = listed.actions.find((a) => a.view.id === ask.actionId);
  if (!found) {
    return (await servesAnotherIntent(ctx, ask))
      ? { kind: "intent_mismatch" }
      : { kind: "not_found" };
  }
  const checked = validateInput(found.view.input, ask.input);
  if (!checked.ok) return { kind: "invalid_input", issues: checked.issues };

  const addresses = recipientAddressesRead(found.map);
  let recipient: IntentRecipient | null = null;
  let resolvedAddresses: RecipientAddresses | null = null;
  if (addresses.length > 0) {
    // The action's input schema requires `to` whenever its map reads `$to`
    // (the intent requires it); a missing one never reaches here.
    const to = checked.value[RECIPIENT_INPUT_FIELD];
    recipient = typeof to === "string" ? await loadRecipient(ctx, to) : null;
    if (!recipient) return { kind: "subject_not_readable" };
    const resolved = resolveRecipient(recipient, addresses, targetOf(found));
    if (!resolved.ok)
      return { kind: "recipient_unreachable", why: resolved.why };
    resolvedAddresses = resolved.addresses;
  }
  return {
    kind: "ok",
    effect: listed.row.effect,
    skillId: found.skillId,
    verbId: found.verbId,
    parameters: mapIntentInput(
      found.map,
      checked.value,
      found.account,
      resolvedAddresses
    ),
    connectionSelector: found.connectionSelector,
    intentRequest: {
      intent: ask.intent,
      actionId: ask.actionId,
      tool: found.view.tool,
      label: found.view.label,
      account: found.account,
      recipient: recipient ? { id: recipient.id, name: recipient.name } : null,
      input: checked.value,
    },
  };
}

/**
 * Does the id name a verb the caller can see that serves ANOTHER intent? The
 * verb part of the id is matched against every answering skill with a map —
 * the id never decodes to a verb.
 */
async function servesAnotherIntent(
  ctx: IntentActionsContext,
  ask: { intent: string; actionId: string }
): Promise<boolean> {
  const verbPart = ask.actionId.split(".")[0];
  if (!verbPart) return false;
  const rows = await db
    .select({ id: skills.id, intent: skills.intent, inputMap: skills.inputMap })
    .from(skills)
    .where(answeringSkillsWhere(ctx.userId, ctx.workspaceId));
  return rows.some(
    (r) =>
      r.inputMap != null &&
      r.intent !== ask.intent &&
      digest(`skill:${r.id}`) === verbPart
  );
}
