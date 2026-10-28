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
 */
import { createHash } from "node:crypto";
import { db, skills, and, inArray } from "@synap/database";
import { humanizeToken, resolveToolLabel } from "@synap-core/types/vocabulary";
import type { SkillInputMap } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { ConnectionSelector } from "../../connectors/external-dispatch.js";
import { listCapabilities } from "./capability-registry.js";
import { foldVerbsByIntent } from "./capability-intent-index.js";
import { projectWithSource } from "./action-projection.js";
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
  validateInput,
  type InputIssue,
  type IntentAccount,
} from "./intent-input.js";

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
 * bookkeeping, never a fact to recall. Anything but a run lists none.
 */
async function listSourceAccounts(
  ctx: IntentActionsContext,
  map: SkillInputMap,
  toolId: string | null
): Promise<IntentAccount[]> {
  const source = map.accounts!;
  const outcome = await executeCapability({
    verbId: source.verb,
    parameters: {},
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    agentUserId: ctx.agentUserId,
    ...(toolId ? { toolId } : {}),
    observability: "mirror",
  });
  if (outcome.kind !== "run") {
    logger.warn(
      { verb: source.verb, outcome: outcome.kind },
      "intent actions: the account source did not run; its tool offers no account"
    );
    return [];
  }
  return accountsFromRecords(source, recordsOf(outcome.result));
}

/** A tool's pod connections, when it reaches several (one action each). */
async function listConnections(
  ctx: IntentActionsContext,
  toolId: string
): Promise<Array<{ id: string; label: string; provider: string | null }>> {
  try {
    const creds = await listCredentials(toolId, ctx.userId);
    return creds
      .filter((c) => c.persisted && c.health === "connected")
      .map((c) => ({
        id: c.id,
        label: c.accountHint ?? c.label,
        provider: c.provider,
      }));
  } catch (err) {
    logger.warn({ err, toolId }, "intent actions: connections unreadable");
    return [];
  }
}

/**
 * Every action this intent offers the caller in this space, or null when the
 * intent is unknown. An intent with no input shape offers none.
 */
export async function listIntentActions(
  ctx: IntentActionsContext,
  intent: string
): Promise<{ row: IntentInputRow; actions: ResolvedIntentAction[] } | null> {
  const row = await loadIntentInput(intent);
  if (!row) return null;
  if (!row.inputSchema) return { row, actions: [] };

  const capabilities = await listCapabilities({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });
  const matched = new Set(
    (foldVerbsByIntent(capabilities).get(intent) ?? []).map((m) => m.verbId)
  );
  const projected = projectWithSource(capabilities).filter(
    ({ action }) => !!action.verbId && matched.has(action.verbId)
  );
  if (projected.length === 0) return { row, actions: [] };

  // Each verb's answering skill, by the run door's rule: the first row per
  // name in its order. It must DECLARE this intent and carry a map.
  const names = [...new Set(projected.map(({ action }) => action.verbId!))];
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

  const actions: ResolvedIntentAction[] = [];
  for (const { action, source } of projected) {
    const skill = skillByName.get(action.verbId!);
    if (!skill || skill.intent !== intent) continue;
    const map = readInputMap(skill.inputMap);
    if (!map) continue;

    const check = checkVerbParameters(skill, {});
    const required = check.status === "invalid" ? check.repair.missing : [];
    const isToolRow = source.kind !== "skill";
    const toolName = isToolRow
      ? humanizeToken(source.name)
      : ((source as { containerName?: string | null }).containerName ??
        humanizeToken(source.name));
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
      const accounts = await listSourceAccounts(
        ctx,
        map,
        isToolRow ? source.id : null
      );
      for (const account of accounts)
        actions.push(
          resolved(`a:${account.id}`, account, null, {
            provider: account.provider,
            account: account.label,
          })
        );
      continue;
    }
    const provider = action.connection?.provider ?? null;
    const connections =
      isToolRow && action.connection?.required
        ? await listConnections(ctx, source.id)
        : [];
    if (connections.length > 1) {
      for (const c of connections)
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
    actions.push(
      resolved("", null, null, provider ? { provider, account: null } : null)
    );
  }
  return { row, actions };
}

/** What `POST /capabilities/execute` runs for an app's intent action. */
export type IntentRunResolution =
  | { kind: "unknown_intent" }
  | { kind: "not_found" }
  | { kind: "intent_mismatch" }
  | { kind: "invalid_input"; issues: InputIssue[] }
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
  /** The app's input, as validated — the exact words it asked to send. */
  input: Record<string, unknown>;
}

/**
 * Resolve an app's ask: the action (re-listed, so a gone account is a 404),
 * the input checked against what that action accepts (a field it does not
 * map is refused, never dropped), then mapped onto the verb's parameters.
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
  return {
    kind: "ok",
    effect: listed.row.effect,
    skillId: found.skillId,
    verbId: found.verbId,
    parameters: mapIntentInput(found.map, checked.value, found.account),
    connectionSelector: found.connectionSelector,
    intentRequest: {
      intent: ask.intent,
      actionId: ask.actionId,
      tool: found.view.tool,
      label: found.view.label,
      account: found.account,
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
