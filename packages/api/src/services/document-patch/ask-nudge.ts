/**
 * WRITE-TIME ASK NUDGE: an agent that writes a question for the person in
 * prose (a line ending in `?` under an "Open questions" or "Decisions" heading)
 * and files no `:::synap-ask` block is told, once, in one line, that an ask
 * block lets the person answer on a card. A NUDGE, never a refusal: it rides
 * on the write's receipt as `nudge` and changes nothing about the write.
 *
 * Quiet by design: only an agent's write, only a question under a heading that
 * names a question or a decision, only when the document holds no ask block at
 * all (a definition or a reference), fenced code never counts, and one line per
 * call however many questions there are. The teaching lives in the pod skill
 * `reports/rich-documents` and in the `synap_create_document` description.
 */

import type { DocumentPatchOp } from "./patch-ops.js";

/** The one line (kept equal to the tool descriptions' teaching by a tripwire). */
export const ASK_NUDGE =
  'This reads like a question for the person: an ask block lets them answer on the card (synap_load_skill("reports/rich-documents")).';

/** A heading that says "this part is for the person to decide or answer". */
const QUESTION_HEADING =
  /\b(open questions?|questions?( for (you|the team|review))?|decisions?( needed| to (make|take))?|to decide|your call|needs? your (input|decision|answer)|for you to (decide|answer)|questions? ouvertes?|d[ée]cisions?( [àa] prendre)?)\b/i;

/** Any directive that is an ask, in either form (definition or reference). */
const ASK_DIRECTIVE = /^[ \t]*:{3,}synap-ask\b/m;

/** The first prose question line under a question-ish heading, or null. */
export function findProseQuestion(markdown: string): string | null {
  let fence: string | null = null;
  let inQuestionSection = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const fenceOpen = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (line.length >= fence.length && line === fence[0]!.repeat(line.length))
        fence = null;
      continue;
    }
    if (fenceOpen) {
      fence = fenceOpen[1]!;
      continue;
    }
    if (/^:{3,}/.test(line)) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inQuestionSection = QUESTION_HEADING.test(heading[1]!);
      continue;
    }
    if (!inQuestionSection) continue;
    const text = line
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (text.length >= 8 && text.endsWith("?")) return text;
  }
  return null;
}

/**
 * The nudge for a write, or null. `written` is the markdown the write adds
 * (the create's content, or the patch's op texts); `whole` is the document as
 * it will stand (so a document that already holds an ask stays quiet).
 */
export function askNudgeFor(
  written: readonly string[],
  whole: string = written.join("\n")
): string | null {
  if (ASK_DIRECTIVE.test(whole) || written.some((t) => ASK_DIRECTIVE.test(t)))
    return null;
  return written.some((t) => findProseQuestion(t) !== null) ? ASK_NUDGE : null;
}

/** The markdown a patch op adds (a section op counts its title as a heading). */
export function patchOpTexts(ops: readonly DocumentPatchOp[]): string[] {
  const texts: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "upsert_section":
        texts.push(`## ${op.title}\n\n${op.body}`);
        break;
      case "append":
        texts.push(op.body);
        break;
      case "replace_text":
        texts.push(op.new);
        break;
      case "replace_all":
        texts.push(op.content);
        break;
      default:
        break;
    }
  }
  return texts;
}
