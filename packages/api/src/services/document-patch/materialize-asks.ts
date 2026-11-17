/**
 * An agent writes a question as ONE `:::synap-ask` block (a ```json props block
 * with `ask`, then prose); this files the real question on the author's session
 * (`ask-slots.ts`) and returns the markdown with the REFERENCE form
 * (`sessionId` + `slot`), written by `serializeEmbed`.
 *
 * Only an agent's write materializes, on its own VERIFIED session. Idempotent
 * by (session, key): an existing question with the same ask is reused, a
 * different ask under that key is refused. Every rewrite is rehearsed before
 * a slot is filed. A question stays owed when the document write that carried
 * it is later refused or rejected; the same write sent again reuses it.
 * No per-session cap, as `synap_ask_person` has none. The entity-body writers
 * (`synap_capture`, `entity-body-service`, `promote-property-to-body`) do not
 * materialize.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  EmbedSerializeError,
  rewriteAskDefinitions,
  scanAskDefinitions,
  type AskDefinition,
} from "@synap-core/markdown-core/embeds";
import {
  ASK_LIMITS,
  AskSchema,
  ASK_ANSWER_BY_PAST_MESSAGE,
  isAskAnswerByPast,
  type Ask,
} from "@synap-core/types/ask";
import { slotKeyBase } from "@synap-core/types/units";
import { BLOCKED_REASONS, type ExpectedOutput } from "@synap/playbooks";
import {
  DECLARED_SLOT_KEY_RE,
  deriveSlotKeys,
  findSlotIndex,
} from "../focus-sessions/slot-keys.js";
import { isTerminalSessionStatus } from "../focus-sessions/session-statuses.js";
import type { DocumentPatchOp } from "./patch-ops.js";
import { buildAskSlot, fileAskSlots, readAskSession } from "./ask-slots.js";

/** More definitions than this in one write is refused: a document is not a form builder. */
const MAX_ASK_DEFINITIONS = 20;
const LABEL_MAX = 500;

/** Where the ask shapes are taught. */
const ASK_SKILL_HINT =
  ' Shapes and examples: synap_load_skill("system/synap/asks").';

const NO_AUTHOR_SESSION_FIX =
  "an ask belongs to your own session: start one with synap_start_session (the one this request runs in), then send this write again.";

// ─── Reading and validating the definitions (pure) ──────────────────────────

const DefinitionPropsSchema = z
  .object({
    key: z
      .string()
      .regex(
        DECLARED_SLOT_KEY_RE,
        "key must be a lowercase slug (a-z, 0-9, -, at most 64 characters)"
      )
      .optional(),
    label: z.string().trim().min(1).max(LABEL_MAX).optional(),
    why: z.string().max(500).optional(),
    unblocks: z
      .string()
      .trim()
      .min(1)
      .max(ASK_LIMITS.unblocksMaxChars)
      .optional(),
    blockedReason: z.enum(BLOCKED_REASONS).optional(),
    ask: z.unknown().optional(),
  })
  .strict();

interface PlannedAsk {
  /** Index of the text it was found in. */
  textIndex: number;
  definition: AskDefinition;
  /** The slot key it will be filed under (declared, else derived from the label). */
  key: string;
  ask: Ask;
  label: string;
  why?: string;
  unblocks?: string;
  blockedReason?: ExpectedOutput["blockedReason"];
}

type AskPlan =
  { ok: true; plans: PlannedAsk[] } | { ok: false; message: string };

function firstLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !/^(:{3,}|`{3,}|~{3,})/.test(l));
  return (line ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`]/g, "")
    .slice(0, ASK_LIMITS.questionMaxChars)
    .trim();
}

/**
 * Read every question definition in `texts` and validate it, or say why not.
 * `ok: true` with no plans means nothing here is a definition.
 */
export function planAskDefinitions(texts: readonly string[]): AskPlan {
  const plans: PlannedAsk[] = [];
  const problems: string[] = [];
  const where = (text: number, line: number) =>
    texts.length > 1 ? `Edit ${text + 1}, line ${line}` : `Line ${line}`;
  let found = 0;
  texts.forEach((markdown, textIndex) => {
    const scan = scanAskDefinitions(markdown);
    for (const p of scan.problems) {
      problems.push(`${where(textIndex, p.line)}: ${p.message}`);
    }
    for (const definition of scan.definitions) {
      found += 1;
      if (found > MAX_ASK_DEFINITIONS) continue;
      const at = where(textIndex, definition.line);
      const props = DefinitionPropsSchema.safeParse(definition.props);
      if (!props.success) {
        problems.push(
          `${at}: ${props.error.issues
            .map((i) => `${i.path.join(".") || "props"}: ${i.message}`)
            .join("; ")}.`
        );
        continue;
      }
      if (props.data.ask == null || typeof props.data.ask !== "object") {
        problems.push(
          `${at}: the props block needs an \`ask\` object (mode confirm | choose | form | act | provide): it is how the person answers.${ASK_SKILL_HINT}`
        );
        continue;
      }
      const ask = AskSchema.safeParse(props.data.ask);
      if (!ask.success) {
        problems.push(
          `${at}: invalid ask: ${ask.error.issues
            .map((i) => `${["ask", ...i.path].join(".")}: ${i.message}`)
            .join("; ")}.${ASK_SKILL_HINT}`
        );
        continue;
      }
      const label = props.data.label ?? firstLine(definition.fallback);
      if (!label) {
        problems.push(
          `${at}: the question needs a \`label\` (one line: the card's heading), or prose after the props block to take it from.`
        );
        continue;
      }
      if (isAskAnswerByPast(ask.data.answerBy)) {
        problems.push(`${at}: ${ASK_ANSWER_BY_PAST_MESSAGE}`);
        continue;
      }
      plans.push({
        textIndex,
        definition,
        key: props.data.key ?? slotKeyBase(label),
        ask: ask.data,
        label,
        ...(props.data.why !== undefined ? { why: props.data.why } : {}),
        ...(props.data.unblocks !== undefined
          ? { unblocks: props.data.unblocks }
          : {}),
        ...(props.data.blockedReason !== undefined
          ? { blockedReason: props.data.blockedReason }
          : {}),
      });
    }
  });
  if (found > MAX_ASK_DEFINITIONS) {
    problems.push(
      `${found} questions in one write: at most ${MAX_ASK_DEFINITIONS}.`
    );
  }
  const seen = new Map<string, number>();
  for (const p of plans) seen.set(p.key, (seen.get(p.key) ?? 0) + 1);
  for (const [key, n] of seen) {
    if (n > 1) {
      problems.push(
        `${n} questions share the key "${key}": give each its own \`key\` (a question is addressed by its key).`
      );
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      message: `A question in this document cannot be filed. ${problems.join(" ")}`,
    };
  }
  return { ok: true, plans };
}

/** True when one of `texts` holds a question definition (or a block that tried to be one). */
export function holdsAskDefinition(texts: readonly string[]): boolean {
  return texts.some((t) => {
    const scan = scanAskDefinitions(t);
    return scan.definitions.length > 0 || scan.problems.length > 0;
  });
}

function opMarkdown(op: DocumentPatchOp): string | null {
  switch (op.op) {
    case "upsert_section":
    case "append":
      return op.body;
    case "replace_text":
      return op.new;
    case "replace_all":
      return op.content;
    default:
      return null;
  }
}

function withOpMarkdown(
  op: DocumentPatchOp,
  markdown: string
): DocumentPatchOp {
  switch (op.op) {
    case "upsert_section":
    case "append":
      return { ...op, body: markdown };
    case "replace_text":
      return { ...op, new: markdown };
    case "replace_all":
      return { ...op, content: markdown };
    default:
      return op;
  }
}

/** True when one of a patch's ops carries a question definition. */
export function opsHoldAskDefinition(ops: readonly DocumentPatchOp[]): boolean {
  return holdsAskDefinition(
    ops.map(opMarkdown).filter((m): m is string => m !== null)
  );
}

// ─── Filing the questions ───────────────────────────────────────────────────

export interface AskAuthor {
  userId: string;
  /** Present => an agent is writing. Absent => nothing is materialized. */
  agentUserId?: string | null;
  /** The session this request VERIFIABLY runs in (ownership-checked), or null. */
  sessionId?: string | null;
  /** A session the write names itself (a body field, the section's target), if any. */
  namedSessionId?: string | null;
}

export interface MaterializedAsks {
  /** `texts` with every definition rewritten to the reference form (same order). */
  texts: string[];
  /** False when nothing in `texts` was a definition. */
  changed: boolean;
}

/** The refusal every guard throws; nothing is written anywhere when it does. */
function refusal(
  message: string,
  code: "BAD_REQUEST" | "PRECONDITION_FAILED" = "BAD_REQUEST",
  then?: string
): TRPCError {
  return new TRPCError({
    code,
    message: `${message} Nothing was written.${then ? ` ${then}` : ""}`,
  });
}

/** JSON with sorted keys: two asks are the same ask when this is equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameAsk(stored: unknown, planned: Ask): boolean {
  const parsed = AskSchema.safeParse(stored);
  return (
    canonicalJson(parsed.success ? parsed.data : stored) ===
    canonicalJson(planned)
  );
}

function isPersonsAsk(
  slot: ExpectedOutput | undefined
): slot is ExpectedOutput {
  return !!slot && slot.owner === "human" && !!slot.ask;
}

/**
 * Turn the question definitions in `texts` into real questions on the author's
 * session and return the texts with the reference form. Throws a `TRPCError`
 * (nothing written) for every refusal.
 */
export async function materializeAskDefinitions(
  texts: readonly string[],
  author: AskAuthor
): Promise<MaterializedAsks> {
  const unchanged: MaterializedAsks = { texts: [...texts], changed: false };
  // An ask belongs to an agent's session: a person's or the pod's write is left as written.
  if (!author.agentUserId) return unchanged;

  const plan = planAskDefinitions(texts);
  if (!plan.ok) throw refusal(plan.message);
  if (plan.plans.length === 0) return unchanged;

  if (!author.sessionId) {
    throw refusal(
      `This write holds ${plan.plans.length === 1 ? "a question" : "questions"} (\`:::synap-ask\` with an \`ask\`), and ${NO_AUTHOR_SESSION_FIX}`,
      "PRECONDITION_FAILED"
    );
  }
  const sessionId = author.sessionId;
  if (author.namedSessionId && author.namedSessionId !== sessionId) {
    throw refusal(
      `This write names session ${author.namedSessionId}, but a question is filed only on the session this request runs in (${sessionId}): write it there.`,
      "PRECONDITION_FAILED"
    );
  }
  const session = await readAskSession({ sessionId, userId: author.userId });
  if (!session) {
    throw refusal(
      `Session ${sessionId} is not one of yours, so a question cannot be filed on it; ${NO_AUTHOR_SESSION_FIX}`,
      "PRECONDITION_FAILED"
    );
  }
  if (isTerminalSessionStatus(session.status)) {
    throw refusal(
      `Session ${sessionId} has ended (${session.status}): a question there reaches nobody; ${NO_AUTHOR_SESSION_FIX}`,
      "PRECONDITION_FAILED"
    );
  }

  // Which questions already exist (idempotent by key), which are new, which collide.
  const fresh: PlannedAsk[] = [];
  for (const p of plan.plans) {
    const byKey = findSlotIndex(session.expectedOutputs, { key: p.key });
    if (byKey !== -1) {
      const existing = session.expectedOutputs[byKey];
      if (!isPersonsAsk(existing)) {
        throw refusal(
          `Session ${sessionId} already has an output with the key "${p.key}" that is not a question to a person. Give this question another \`key\`.`
        );
      }
      if (!sameAsk(existing.ask, p.ask)) {
        throw refusal(
          `A question with the key "${p.key}" already exists on session ${sessionId} with a different ask: use the same ask or change the key.`
        );
      }
      continue;
    }
    if (findSlotIndex(session.expectedOutputs, { label: p.label }) !== -1) {
      throw refusal(
        `Session ${sessionId} already has an output labelled "${p.label}" under another key. Give this question another \`label\` or the key of that output.`
      );
    }
    fresh.push(p);
  }

  // Rehearse the rewrite BEFORE a slot exists: a fallback that cannot be
  // written back must not leave an orphan question behind.
  const rewrite = (keyOf: (p: PlannedAsk) => string): string[] => {
    const out = [...texts];
    texts.forEach((markdown, textIndex) => {
      const mine = plan.plans.filter((p) => p.textIndex === textIndex);
      if (mine.length === 0) return;
      out[textIndex] = rewriteAskDefinitions(
        markdown,
        mine.map((p) => ({
          definition: p.definition,
          sessionId,
          slot: keyOf(p),
        }))
      );
    });
    return out;
  };
  try {
    rewrite((p) => p.key);
  } catch (err) {
    if (err instanceof EmbedSerializeError) {
      throw refusal(
        `The prose under a question cannot be kept as written (${err.message}). Fix it and send the write again.`
      );
    }
    throw err;
  }

  if (fresh.length > 0) {
    let slots: ExpectedOutput[];
    try {
      slots = await Promise.all(fresh.map((p) => buildAskSlot(p)));
    } catch (err) {
      throw refusal(
        `A question cannot be filed: ${err instanceof Error ? err.message : String(err)}.`
      );
    }
    const filed = await fileAskSlots({
      sessionId,
      userId: author.userId,
      agentUserId: author.agentUserId,
      slots,
    });
    if (filed.status === "proposed") {
      throw refusal(
        `Filing the question needs a person's approval (proposal ${filed.proposalId}${filed.reviewUrl ? `, ${filed.reviewUrl}` : ""}).`,
        "PRECONDITION_FAILED",
        "Send this same write again once it is approved."
      );
    }
    if (filed.status === "refused") {
      throw refusal(
        `The question could not be filed on session ${sessionId}: ${filed.reason}.`
      );
    }
  }

  // Never write a reference to a slot that is not there, or that a parallel
  // write changed: read it back, check it is THIS ask, use its real key.
  const after = await readAskSession({ sessionId, userId: author.userId });
  const keys = deriveSlotKeys(after?.expectedOutputs ?? []);
  const real = new Map<PlannedAsk, string>();
  for (const p of plan.plans) {
    const at = findSlotIndex(after?.expectedOutputs ?? [], {
      key: p.key,
      label: p.label,
    });
    const slot = at === -1 ? undefined : after?.expectedOutputs[at];
    if (!isPersonsAsk(slot) || !sameAsk(slot.ask, p.ask)) {
      throw refusal(
        `The question "${p.key}" is missing from session ${sessionId} or was changed by another write while it was being filed, so no reference was written. Send the write again.`,
        "PRECONDITION_FAILED"
      );
    }
    real.set(p, keys[at]!);
  }
  return { texts: rewrite((p) => real.get(p)!), changed: true };
}

/**
 * The patch door's entry: materialize the definitions in every op's markdown
 * ONCE (one slot write for the whole patch, keys unique across it) and return
 * the ops with the reference form. A patch with no definition returns the same
 * array.
 */
export async function materializeAskDefinitionsInOps(
  ops: DocumentPatchOp[],
  author: AskAuthor
): Promise<{ ops: DocumentPatchOp[]; changed: boolean }> {
  const carriers = ops
    .map((op, index) => ({ index, markdown: opMarkdown(op) }))
    .filter(
      (c): c is { index: number; markdown: string } => c.markdown !== null
    );
  const result = await materializeAskDefinitions(
    carriers.map((c) => c.markdown),
    author
  );
  if (!result.changed) return { ops, changed: false };
  const next = [...ops];
  carriers.forEach((c, i) => {
    next[c.index] = withOpMarkdown(ops[c.index]!, result.texts[i]!);
  });
  return { ops: next, changed: true };
}
