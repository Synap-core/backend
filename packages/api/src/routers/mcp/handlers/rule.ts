/**
 * MCP tool handlers — rule domain.
 *
 * WHY THIS FILE EXISTS. The intent-first rule door (`createRuleGoverned`) was
 * reachable by humans (browser → `trpc.skills.createRule`), by the CLI and by
 * Hub REST (`POST /rules`) — but NOT by an MCP agent. An agent asked to make a
 * standing rule had only the RAW primitives (`synap_create_automation`,
 * `synap_create_skill`, `synap_create_verb`), which persist whatever they are
 * handed: a behavioural intent became prose that never runs, or a flow nobody
 * verified against the runtime. That inversion is backwards — the
 * machine-driven caller got the unsafe primitives while the human got the
 * compiled door with its named refusals.
 *
 * ROUTING. Through `skillsRouter.createCaller(...).createRule(...)`, the SAME
 * procedure the browser calls — mirroring `synap_create_skill` /
 * `synap_reject_proposal` in `./build.ts`. Calling `createRuleGoverned`
 * directly would work today and would be a second authority tomorrow: the tRPC
 * door owns the input contract (scope shape, expiry format, sentence parsing)
 * and the three-way verdict contract, and a second call site is exactly how
 * doors drift apart in this repo.
 *
 * REFUSALS ARE THE POINT. `skills.createRule` deliberately RETURNS a
 * `{status:"denied", reason, failure:{clause, reason}}` union arm rather than
 * throwing — pinned by `skills.createRule.contract.test.ts`. This handler
 * forwards that arm VERBATIM. An agent told "your WHEN names an event no
 * emitter produces" can fix that clause and resend; one told "invalid" cannot.
 *
 * THE EDIT DOOR (`synap_update_rule`). Same reasoning, one procedure over:
 * `skillsRouter.updateRule`, which calls `updateRuleGoverned`. Without it an
 * agent could create a rule but never propose a correction to one — a rule it
 * wrote, a person approved, and the facts then outgrew could only be fixed by a
 * person. The edit is FULL SHAPE (see that door's header): `intent` and `scope`
 * are stored as sent, which is why `scope` is REQUIRED here rather than
 * defaulted — a default would silently move a workspace rule pod-wide.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { skillsRouter as regularSkillsRouter } from "../../skills.js";
import { ruleSentenceSchema } from "../../../services/rules/sentence-schema.js";
import {
  ok,
  requireScope,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";

/**
 * The tool's own wire shape. Intent-first: `intent` is the user's own words and
 * is the ONLY required field; everything else refines it. `scope` is a bare
 * enum here (not the nested object the tRPC input takes) because an MCP caller
 * already passes `workspaceId` as a flat arg on every other tool — the nesting
 * is assembled below.
 */
const createRuleArgsSchema = z.object({
  intent: z.string().min(1),
  scope: z.enum(["pod", "workspace", "user"]).optional(),
  // `.uuid()` for the same reason `expiresAt` is checked below: a caller that
  // passes a workspace NAME should be told which field is wrong, not handed a
  // flattened tRPC BAD_REQUEST from `skills.createRule` (which requires uuids).
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  // The SAME shape `skills.createRule` declares. Checked here so a bad instant
  // comes back naming the field instead of as a flattened tRPC BAD_REQUEST.
  expiresAt: z.string().datetime({ offset: true }).optional(),
  // Parsed separately below so a malformed sentence reports WHICH FIELD is
  // wrong instead of collapsing into "the sentence did not match the shape".
  sentence: z.unknown().optional(),
});

/**
 * Parse a tool's `sentence` arg against the same exported schema the tRPC
 * input declares — one grammar, two readers. Doing it up front is what buys
 * the agent a usable message: the tRPC zod input would throw a BAD_REQUEST
 * (flattened by `toSafeToolError`), and the door's own `readRuleSentence`
 * fallback reports only "did not match the expected shape" with no field.
 * Neither tells an agent which key to fix. `null` passes through: on the edit
 * door it means "remove the behaviour".
 */
function readSentenceArg(raw: unknown):
  | {
      ok: true;
      sentence: z.infer<typeof ruleSentenceSchema> | null | undefined;
    }
  | { ok: false; refusal: Record<string, unknown> } {
  if (raw === undefined || raw === null) return { ok: true, sentence: raw };
  const sentenceParsed = ruleSentenceSchema.safeParse(raw);
  if (sentenceParsed.success)
    return { ok: true, sentence: sentenceParsed.data };
  return {
    ok: false,
    refusal: {
      status: "denied",
      reason:
        "This rule's WHEN/WHERE/THEN could not be read, so nothing was saved — a rule stored with an unreadable sentence would silently never run.",
      // Deliberately NOT dressed up as a `failure.clause`: the compiler names
      // the clause, this is a wire-shape error and pretending it is a WHEN
      // failure would point the author at the wrong row.
      invalidSentence: sentenceParsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
  };
}

function invalidArgs(toolName: string, error: z.ZodError): CallToolResult {
  return ok({
    error: `Invalid ${toolName} args: ${error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")}`,
  });
}

/**
 * `synap_update_rule`'s wire shape. Flat like the create tool's, for the same
 * reason (`workspaceId` is a flat arg on every MCP tool). Unlike create,
 * `scope` is required — see the header — and `expiresAt` / `sentence` accept
 * `null`: absent keeps the stored value, `null` clears it.
 */
const updateRuleArgsSchema = z.object({
  ruleId: z.string().uuid(),
  intent: z.string().min(1),
  scope: z.enum(["pod", "workspace", "user"]),
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullish(),
  sentence: z.unknown().optional(),
  draft: z.boolean().optional(),
});

export const ruleHandlers: McpHandlerMap = {
  synap_create_rule: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      sessionId,
      lensWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);

    const parsed = createRuleArgsSchema.safeParse(args);
    if (!parsed.success) return invalidArgs(toolName, parsed.error);

    // The ambient MCP lens (`?workspaceId=`, or the agent's focus) is already
    // resolved and access-checked by the adapter. An EXPLICIT arg still wins —
    // that is how a caller targets a workspace other than its focus, and it is
    // the same precedence `synap_create_project` uses (`requestedWorkspaceId`,
    // handlers/workspace.ts). Safe because it is not the authorization: the
    // gate floors on membership (`permission-check.ts` — a non-member agent
    // gets a `workspace.join` proposal, never a write), and a bound service key
    // is confined before it reaches here. The comment previously claimed the
    // lens was preferred, which the code has never done.
    const workspaceId = parsed.data.workspaceId ?? lensWorkspaceId;
    const scopeKind = parsed.data.scope ?? (workspaceId ? "workspace" : "pod");
    if (scopeKind === "workspace" && !workspaceId) {
      return ok({
        error:
          "scope 'workspace' needs a workspaceId — pass one, call synap_set_workspace_focus, or omit `scope` to make this a pod-wide rule.",
      });
    }

    const sentenceRead = readSentenceArg(parsed.data.sentence);
    if (!sentenceRead.ok) return ok(sentenceRead.refusal);
    const sentence = sentenceRead.sentence ?? undefined;

    const ruleCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      workspaceId ?? null,
      undefined,
      sessionId,
      agentUserId ?? null
    );
    const rulesCaller = regularSkillsRouter.createCaller(ruleCtx as never);

    // GOVERNED (`createRuleGoverned` → `checkPermissionOrPropose {rule, create}`).
    // With `agentUserId` set the gate routes an agent create to a proposal —
    // `status: "proposed"` is SUCCESS, and `ok()` attaches the review link and
    // the reinforcement hint for every governed write in one place.
    const result = await rulesCaller.createRule({
      intent: parsed.data.intent,
      scope: {
        kind: scopeKind,
        // `workspaceId` ONLY when the scope is actually a workspace scope.
        // Spreading it unconditionally silently narrowed a pod-wide rule: the
        // skill row honours the kind (`create.ts` writes `workspaceId: kind ===
        // "workspace" ? workspaceId : null`) and so reads pod-wide, but the
        // COMPILED automation takes `workspaceId ?? null` — so it was created
        // confined, and `automation-trigger-matcher` only ever matches that one
        // workspace. The receipt said pod-wide, the rule row said pod-wide, and
        // the behaviour fired in exactly one workspace. An agent with a focus
        // workspace calling `scope: "pod"` hit this every time.
        ...(scopeKind === "workspace" && workspaceId ? { workspaceId } : {}),
        ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
      },
      ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
      automationIds: [],
      ...(sentence ? { sentence } : {}),
    });
    return ok(result);
  },

  synap_update_rule: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      sessionId,
      lensWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);

    const parsed = updateRuleArgsSchema.safeParse(args);
    if (!parsed.success) return invalidArgs(toolName, parsed.error);

    // Same precedence as `synap_create_rule`: an explicit arg wins over the
    // ambient lens. It is also the caller context's workspace, which
    // `skills.updateRule` uses as the VISIBILITY lens — not an authorization:
    // the read is floored on `visibleSkillsWhere`, so naming a workspace never
    // grants a rule the caller cannot see.
    const workspaceId = parsed.data.workspaceId ?? lensWorkspaceId;
    if (parsed.data.scope === "workspace" && !workspaceId) {
      return ok({
        error:
          "scope 'workspace' needs a workspaceId — pass one or call synap_set_workspace_focus. Send the scope the rule should have AFTER the edit.",
      });
    }

    const sentenceRead = readSentenceArg(parsed.data.sentence);
    if (!sentenceRead.ok) return ok(sentenceRead.refusal);

    const ruleCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      workspaceId ?? null,
      undefined,
      sessionId,
      agentUserId ?? null
    );
    const rulesCaller = regularSkillsRouter.createCaller(ruleCtx as never);

    try {
      // GOVERNED (`updateRuleGoverned` → `checkPermissionOrPropose {rule,
      // update}`): with `agentUserId` set the edit files a `rule/update`
      // proposal the `rule/update` executor replays on approval. "proposed" is
      // SUCCESS — `ok()` attaches the review link.
      const result = await rulesCaller.updateRule({
        id: parsed.data.ruleId,
        intent: parsed.data.intent,
        scope: {
          kind: parsed.data.scope,
          // Only for a workspace scope — see the same note in
          // `synap_create_rule`: a pod rule must not carry a workspace.
          ...(parsed.data.scope === "workspace" && workspaceId
            ? { workspaceId }
            : {}),
          ...(parsed.data.projectId
            ? { projectId: parsed.data.projectId }
            : {}),
        },
        // THREE states each: absent is NOT sent (keep the stored value), `null`
        // IS sent (clear it). A truthiness check here would collapse them.
        ...(parsed.data.expiresAt !== undefined
          ? { expiresAt: parsed.data.expiresAt }
          : {}),
        ...(sentenceRead.sentence !== undefined
          ? { sentence: sentenceRead.sentence }
          : {}),
        ...(parsed.data.draft !== undefined
          ? { draft: parsed.data.draft }
          : {}),
        automationIds: [],
      });
      return ok(result);
    } catch (err) {
      if (err instanceof TRPCError && err.code === "NOT_FOUND") {
        return ok({
          status: "not_found",
          error: `No rule ${parsed.data.ruleId} that you can see. A rule id is the \`ruleId\` on synap_create_rule's receipt; if that create was proposed, synap_get_proposal on its proposalId returns \`data.materialized.ruleId\` once a person approved it. A workspace rule is only visible under its workspace — pass its workspaceId.`,
        });
      }
      throw err;
    }
  },
};
