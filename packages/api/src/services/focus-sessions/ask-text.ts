/**
 * An owed ask says each thing ONCE (the founder, 2026-10-26:
 * "there is repeated multiple times the same question"). The card dedupes what
 * it draws (`askCardView`, @synap-core/types/ask); this keeps the STORED slot
 * from repeating itself at the doors that write it, with the same fold
 * (`askTextRestates`), so the two can never disagree about what "the same
 * words" is.
 *
 * Never refuses: a `why` that only repeats the confirm's prompt is dropped (or
 * the prompt cut off its end — a room question's words carry it), and a prompt
 * that only restates the label earns the writer a hint.
 */

import { askTextRestates } from "@synap-core/types/ask";

/** The same words, once case, punctuation and a verb prefix are folded. */
function sameAskText(a: string, b: string): boolean {
  return askTextRestates(a, b) && askTextRestates(b, a);
}

/** A slot as any write door holds it (stored, or parsed off the wire). */
interface AskTextSlot {
  why?: string | null;
  ask?: { mode: string; prompt?: string | null } | null;
}

function confirmPrompt(slot: AskTextSlot): string {
  return slot.ask?.mode === "confirm" ? (slot.ask.prompt?.trim() ?? "") : "";
}

/**
 * The slot without a `why` that repeats its confirm prompt: dropped when it is
 * the prompt, cut when it ends with it. The same object when nothing repeats.
 * Pure.
 */
export function withoutRestatedWhy<T extends AskTextSlot>(slot: T): T {
  const prompt = confirmPrompt(slot);
  const why = slot.why?.trim() ?? "";
  if (!prompt || !why) return slot;
  if (sameAskText(why, prompt)) {
    const { why: _repeated, ...rest } = slot;
    return rest as T;
  }
  if (why.endsWith(prompt)) {
    const facts = why.slice(0, -prompt.length).trim();
    if (facts) return { ...slot, why: facts };
  }
  return slot;
}

/**
 * One hint per person-owned slot whose confirm prompt only restates its label
 * ("Decide: X" asked as "Accept: X?"). Said back to the writer, never refused.
 * Pure.
 */
export function restatedAskHints(
  slots: ReadonlyArray<AskTextSlot & { label: string; owner?: string | null }>
): string[] {
  const hints: string[] = [];
  for (const slot of slots) {
    if (slot?.owner !== "human") continue;
    const prompt = confirmPrompt(slot);
    if (!prompt || !sameAskText(prompt, slot.label)) continue;
    hints.push(
      `"${slot.label}": the prompt repeats the label. Make the label a short key (a few words) and the prompt the question, with what each answer does (yes / no descriptions).`
    );
  }
  return hints;
}
