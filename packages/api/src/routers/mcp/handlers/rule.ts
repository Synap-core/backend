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
 */

import { z } from "zod";
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
    if (!parsed.success) {
      return ok({
        error: `Invalid ${toolName} args: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      });
    }

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

    // Parsed HERE, against the same exported schema the tRPC input declares —
    // one grammar, two readers. Doing it up front is what buys the agent a
    // usable message: `skills.createRule`'s zod input would throw a tRPC
    // BAD_REQUEST (flattened by `toSafeToolError`), and the door's own
    // `readRuleSentence` fallback reports only "did not match the expected
    // shape" with no field. Neither tells an agent which key to fix.
    let sentence: z.infer<typeof ruleSentenceSchema> | undefined;
    if (parsed.data.sentence !== undefined && parsed.data.sentence !== null) {
      const sentenceParsed = ruleSentenceSchema.safeParse(parsed.data.sentence);
      if (!sentenceParsed.success) {
        return ok({
          status: "denied",
          reason:
            "This rule's WHEN/WHERE/THEN could not be read, so nothing was saved — a rule stored with an unreadable sentence would silently never run.",
          // Deliberately NOT dressed up as a `failure.clause`: the compiler
          // names the clause, this is a wire-shape error and pretending it is a
          // WHEN failure would point the author at the wrong row.
          invalidSentence: sentenceParsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }
      sentence = sentenceParsed.data;
    }

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
};
