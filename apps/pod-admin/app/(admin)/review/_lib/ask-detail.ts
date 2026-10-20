/**
 * An agent's question, shaped for Review's detail column — the view-model
 * the answer controls draw, and the exact calls they send.
 *
 * PURE. Every RULE comes from `@synap-core/types/ask`, the one the pod's
 * answer door and the desktop and phone apps apply: whether an answer fits
 * (`validateAnswerAgainstAsk`, which also sends an act to "I did this"),
 * what an act shows (`actView`), the options as
 * chips (`askOptionChips`) and the fingerprint the pod checks the answer
 * against (`askFingerprint`). What is left here is the
 * console's own arrangement: which controls a form field becomes, the
 * field-level hints a web form shows before a round trip, and the call shapes.
 *
 * The slot is read off the needs-you signal Review already holds (an
 * `owed-slot` carries its label, ask, why and the agent's claim), so the
 * detail never re-reads what the row was built from — and a refetch of that
 * one read is what tells the detail the question changed or moved on.
 */

import {
  actView,
  askFingerprint,
  askOptionChips,
  askOptionForChip,
  isRefusedAskField,
  validateAnswerAgainstAsk,
  type Ask,
  type AskAnswerValue,
  type AskLookedAtKind,
  type AskProvideKind,
  type AskProvideRef,
  type DynamicFormField,
} from "@synap-core/types/ask";
import { CRITERION_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";

// ─── The slot ────────────────────────────────────────────────────────────────

/** What an owed slot's needs-you signal says about the question (structural). */
export interface AskSlotSignal {
  kind: string;
  title: string;
  target?: { kind: string; id: string } | null;
  sessionTitle?: string | null;
  slotKind?: string | null;
  why?: string | null;
  claimedDone?: boolean | null;
  ask?: Ask | null;
}

/** One owed slot, as the detail reads it. */
export interface AskSlot {
  sessionId: string;
  /** The DECLARED label — the key every slot door matches on. */
  label: string;
  sessionTitle: string | null;
  /** Null = no typed ask: a free-text answer, "I did this" or "Not mine". */
  ask: Ask | null;
  why: string | null;
  /** The agent says it produced this after all (unverified). */
  claimedDone: boolean;
}

/**
 * The slot an `owed-slot` signal stands for, when Review can answer it here.
 * Not a criterion slot: that one is GRADED on the session's scorecard, and
 * "I did this" on it would mark the slot done while the verdict never moves.
 */
export function askSlotOf(s: AskSlotSignal): AskSlot | null {
  if (s.kind !== "owed-slot" || s.target?.kind !== "session") return null;
  if (s.slotKind === CRITERION_SLOT_KIND) return null;
  return {
    sessionId: s.target.id,
    label: s.title,
    sessionTitle: s.sessionTitle?.trim() || null,
    ask: s.ask ?? null,
    why: s.why?.trim() || null,
    claimedDone: s.claimedDone === true,
  };
}

/**
 * Has the question moved since the reader opened it? `changed` = the agent
 * re-asked (a different fingerprint — what the pod would refuse as
 * `ask_changed:`); `gone` = the slot is no longer owed by the reader.
 */
export type AskStaleness = "same" | "changed" | "gone";

export function askStaleness(
  seen: AskSlot,
  live: AskSlot | null | undefined
): AskStaleness {
  if (!live) return "gone";
  return askFingerprint(live.ask) === askFingerprint(seen.ask)
    ? "same"
    : "changed";
}

// ─── Who is asking ───────────────────────────────────────────────────────────

/**
 * The agents on the session, by the names the pod resolved
 * (`focusSessions.get` → `participants`). A slot does not record WHICH agent
 * asked, so several are named together rather than one guessed. Null = none
 * known.
 */
export function askerOf(
  participants: ReadonlyArray<{ name: string }> | null | undefined
): string | null {
  const names = (participants ?? []).map((p) => p.name.trim()).filter(Boolean);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

// ─── The view ────────────────────────────────────────────────────────────────

/** One thing the agent read before asking, named by the pod for the reader. */
export interface LookedAtItem {
  kind: AskLookedAtKind;
  id: string;
  label: string;
}

export interface ChooseOptionView {
  /** `askOptionKey` — what the pod matches the answer on. */
  key: string;
  label: string;
  description: string | null;
  recommended: boolean;
}

/** The control a form field becomes. */
export type FormControl = "text" | "textarea" | "number" | "select" | "switch";

export interface FormFieldView {
  key: string;
  label: string;
  help: string | null;
  required: boolean;
  control: FormControl;
  /** The input's `type` for a `text` control. */
  inputType: "text" | "email" | "url" | "tel" | "date";
  /** A `select`'s choices (`constraints.enum`). */
  options: string[];
  min: number | null;
  max: number | null;
  pattern: string | null;
}

export type AskControlView =
  | { mode: "confirm"; prompt: string | null }
  | {
      mode: "choose";
      options: ChooseOptionView[];
      /** The agent's recommended option, pre-selected; else nothing. */
      initialKey: string | null;
      allowOther: boolean;
    }
  | {
      mode: "form";
      title: string | null;
      note: string | null;
      fields: FormFieldView[];
    }
  | { mode: "act"; url: string | null; steps: string[] }
  | {
      mode: "provide";
      kind: AskProvideKind;
      /** What it wants handed over, in words ("A secret: Stripe key"). */
      wants: string;
    }
  /** No typed ask: today's free text, "I did this" and "Not mine". */
  | { mode: "legacy" };

export interface AskView {
  heading: string;
  why: string | null;
  claimedDone: boolean;
  lookedAt: LookedAtItem[];
  control: AskControlView;
}

const NUMBER_TYPES = new Set(["number", "currency", "rating", "integer"]);
const TEXTAREA_TYPES = new Set([
  "long_text",
  "textarea",
  "rich_text",
  "markdown",
]);
const INPUT_TYPES: Record<string, FormFieldView["inputType"]> = {
  email: "email",
  url: "url",
  phone: "tel",
  date: "date",
};

function fieldView(f: DynamicFormField): FormFieldView {
  const options = f.constraints?.enum ?? [];
  const control: FormControl =
    f.type === "boolean"
      ? "switch"
      : options.length > 0
        ? "select"
        : NUMBER_TYPES.has(f.type)
          ? "number"
          : TEXTAREA_TYPES.has(f.type)
            ? "textarea"
            : "text";
  return {
    key: f.key,
    label: f.label.trim() || f.key,
    help: f.help?.trim() || null,
    required: f.required === true,
    control,
    inputType: INPUT_TYPES[f.type] ?? "text",
    options,
    min: f.constraints?.min ?? null,
    max: f.constraints?.max ?? null,
    pattern: f.constraints?.pattern ?? null,
  };
}

function provideWants(ask: Extract<Ask, { mode: "provide" }>): string {
  const p = ask.provide;
  switch (p.kind) {
    case "secret":
      return `A secret: ${p.name}`;
    case "connection":
      return `A connection to ${resolveServiceName(p.service)}`;
    case "file":
      return p.accept?.length ? `A file (${p.accept.join(", ")})` : "A file";
  }
}

function controlOf(ask: Ask | null): AskControlView {
  if (!ask) return { mode: "legacy" };
  switch (ask.mode) {
    case "confirm":
      return { mode: "confirm", prompt: ask.prompt?.trim() || null };
    case "choose": {
      const options = askOptionChips(ask).map((c) => ({
        key: c.value,
        label: c.label,
        description: c.description ?? null,
        recommended: c.recommended === true,
      }));
      return {
        mode: "choose",
        options,
        initialKey: options.find((o) => o.recommended)?.key ?? null,
        allowOther: ask.allowOther === true,
      };
    }
    case "form":
      return {
        mode: "form",
        title: ask.form.title?.trim() || null,
        note: ask.form.note?.trim() || null,
        // The parse already dropped credential fields; a form is never where a
        // secret is typed, so the console drops any that slipped through too.
        fields: ask.form.fields
          .filter((f) => !isRefusedAskField(f))
          .map(fieldView),
      };
    case "act": {
      const act = actView(ask);
      return { mode: "act", url: act?.url ?? null, steps: act?.steps ?? [] };
    }
    case "provide":
      return {
        mode: "provide",
        kind: ask.provide.kind,
        wants: provideWants(ask),
      };
  }
}

export function askView(slot: AskSlot): AskView {
  const refs = (slot.ask?.lookedAt ?? []) as ReadonlyArray<{
    kind: AskLookedAtKind;
    id: string;
    title?: string;
  }>;
  return {
    heading: slot.label,
    why: slot.why,
    claimedDone: slot.claimedDone,
    lookedAt: refs.map((r) => ({
      kind: r.kind,
      id: r.id,
      // The pod resolved the name through the reader's own access floor; an
      // agent's title never reaches here.
      label: r.title?.trim() || resolveObjectNoun(r.kind),
    })),
    control: controlOf(slot.ask),
  };
}

// ─── Form values ─────────────────────────────────────────────────────────────

/** What the form holds while it is being filled. */
export type FormDraft = Record<string, string | boolean>;

/** Every field at its empty value (a switch starts off). */
export function initialFormDraft(fields: readonly FormFieldView[]): FormDraft {
  return Object.fromEntries(
    fields.map((f) => [f.key, f.control === "switch" ? false : ""])
  );
}

function blank(v: string | boolean | undefined): boolean {
  return v === undefined || (typeof v === "string" && v.trim() === "");
}

function safePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

/**
 * The hints a field shows before anything is sent — required, a number's
 * bounds, a text's pattern. The pod's own rule still decides
 * (`validateAnswerAgainstAsk`); these only save a round trip. Keyed by field.
 */
export function formFieldErrors(
  fields: readonly FormFieldView[],
  draft: FormDraft
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = draft[f.key];
    if (blank(v)) {
      if (f.required && f.control !== "switch") errors[f.key] = "Required.";
      continue;
    }
    if (f.control === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.key] = "Enter a number.";
      else if (f.min !== null && n < f.min)
        errors[f.key] = `At least ${f.min}.`;
      else if (f.max !== null && n > f.max) errors[f.key] = `At most ${f.max}.`;
    } else if (typeof v === "string" && f.pattern) {
      const re = safePattern(f.pattern);
      if (re && !re.test(v.trim()))
        errors[f.key] = "Not in the expected format.";
    }
  }
  return errors;
}

/** The values the pod receives: blanks left out, numbers as numbers. */
export function formAnswerValues(
  fields: readonly FormFieldView[],
  draft: FormDraft
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = draft[f.key];
    if (blank(v)) continue;
    out[f.key] =
      f.control === "number" ? Number(v) : typeof v === "string" ? v.trim() : v;
  }
  return out;
}

// ─── The calls ───────────────────────────────────────────────────────────────

/** "Other…" in a choose — never an option key (keys are the agent's values). */
export const OTHER_KEY = "\u0000other";

/** What the reader chose, before it is checked. */
export type AskDraft =
  | { type: "confirm"; confirmed: boolean; note?: string }
  | { type: "choose"; key: string; other?: string }
  | { type: "form"; draft: FormDraft }
  /** A reference to what is handed over — a vault secret, a connection, a file. */
  | { type: "provide"; ref: AskProvideRef }
  /** A slot with no typed ask: the answer in words. */
  | { type: "text"; text: string };

/** `focusSessions.answerOutput`'s input. */
export interface AnswerCall {
  sessionId: string;
  expectedLabel: string;
  text?: string;
  value: AskAnswerValue;
  askFingerprint: string;
  /** A secret answer: the agent the person was told will read it. */
  expectedGranteeId?: string;
}

/** `attestOutput` / `askAboutSlot` input: the slot, and the ask the reader saw. */
export interface SlotCall {
  sessionId: string;
  expectedLabel: string;
  askFingerprint: string;
}

export type AnswerCallResult =
  | { ok: true; call: AnswerCall }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

function valueOf(
  slot: AskSlot,
  draft: AskDraft
):
  | { ok: true; value: AskAnswerValue; text?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> } {
  const ask = slot.ask;
  switch (draft.type) {
    case "confirm":
      return {
        ok: true,
        value: { type: "confirm", confirmed: draft.confirmed },
        text: draft.note?.trim() || undefined,
      };
    case "choose": {
      if (draft.key === OTHER_KEY) {
        return {
          ok: true,
          value: { type: "text" },
          text: draft.other?.trim() || undefined,
        };
      }
      const option = askOptionForChip(ask, { value: draft.key });
      return option
        ? { ok: true, value: { type: "chip", chip: option } }
        : { ok: false, message: "Pick one of the offered options." };
    }
    case "form": {
      if (ask?.mode !== "form") {
        return { ok: false, message: "This ask takes the form's values." };
      }
      const fields = ask.form.fields
        .filter((f) => !isRefusedAskField(f))
        .map(fieldView);
      const fieldErrors = formFieldErrors(fields, draft.draft);
      if (Object.keys(fieldErrors).length > 0) {
        return {
          ok: false,
          message: "Check the highlighted fields.",
          fieldErrors,
        };
      }
      return {
        ok: true,
        value: { type: "form", values: formAnswerValues(fields, draft.draft) },
      };
    }
    case "text":
      return {
        ok: true,
        value: { type: "text" },
        text: draft.text.trim() || undefined,
      };
    case "provide":
      return { ok: true, value: { type: "provide", ref: draft.ref } };
  }
}

/**
 * The `answerOutput` call for a draft — checked first with the pod's own rule,
 * so the console never sends what the pod would refuse, and carrying the
 * fingerprint of the ask the reader SAW, so an ask the agent changed
 * underneath is refused as stale instead of answered blind.
 */
export function answerCall(slot: AskSlot, draft: AskDraft): AnswerCallResult {
  const built = valueOf(slot, draft);
  if (!built.ok) return built;
  const checked = validateAnswerAgainstAsk(slot.ask, built.value, built.text);
  if (!checked.ok) return { ok: false, message: checked.message };
  return {
    ok: true,
    call: {
      sessionId: slot.sessionId,
      expectedLabel: slot.label,
      value: checked.value,
      ...(built.text ? { text: built.text } : {}),
      askFingerprint: askFingerprint(slot.ask),
    },
  };
}

export function slotCall(slot: AskSlot): SlotCall {
  return {
    sessionId: slot.sessionId,
    expectedLabel: slot.label,
    askFingerprint: askFingerprint(slot.ask),
  };
}

// ─── After an answer ─────────────────────────────────────────────────────────

/** The row focus moves to once one is answered: the next, else the previous. */
export function nextRowKey(
  keys: readonly string[],
  answered: string
): string | null {
  const i = keys.indexOf(answered);
  if (i < 0) return keys[0] ?? null;
  return keys[i + 1] ?? keys[i - 1] ?? null;
}
