/**
 * Template kind on a matched playbook row, and the ONE ordering rule that
 * prefers a TRACK template over its session twin (X1).
 *
 * Why: `find` / `match_playbooks` rows carried no scope, so an agent could not
 * tell "Business Model (GRP)" (scope project — a method a project runs as a
 * TRACK) from its superseded session twin "GRP Business Model Interrogation",
 * and the twin ranked first. The noun comes from the vocabulary door
 * (`resolveTemplateNoun`), never a local label.
 */
import { projectNameTokens } from "@synap/database";
import { resolveTemplateNoun } from "@synap-core/types/vocabulary";

export type PlaybookScope = "session" | "project";

/** `scope` + its user noun for a playbook row. NULL scope reads as session. */
export function templateKindFields(scope: string | null | undefined): {
  scope: PlaybookScope;
  templateKind: string;
} {
  const s: PlaybookScope = scope === "project" ? "project" : "session";
  return { scope: s, templateKind: resolveTemplateNoun(s) };
}

/** The caller is working at project/track altitude. */
export function wantsTrackTemplate(input: {
  projectId?: string | null;
  intentText?: string | null;
}): boolean {
  return (
    Boolean(input.projectId) ||
    /\b(projects?|tracks?)\b/i.test(input.intentText ?? "")
  );
}

/**
 * Same-name twins: one name's token set CONTAINS the other's (after the
 * shared name normalization — punctuation and filler words dropped). Chosen
 * over Jaccard because a session twin usually ADDS words to the method's name
 * ("GRP Business Model Interrogation" ⊇ "Business Model (GRP)", Jaccard 0.75).
 */
export function isTemplateNameTwin(a: string, b: string): boolean {
  const ta = projectNameTokens(a);
  const tb = projectNameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

/**
 * THE RULE: when the caller works at project/track altitude
 * (`wantsTrackTemplate`), each project-scope template moves directly above the
 * FIRST session-scope template ranked above it that is its name twin. Scores
 * are untouched; every other row keeps its order. A track template never jumps
 * an unrelated session template — only its own twin.
 */
export function preferTrackTemplates<
  T extends { name: string; scope: PlaybookScope },
>(ranked: readonly T[], preferTrack: boolean): T[] {
  const out = [...ranked];
  if (!preferTrack) return out;
  for (const track of ranked.filter((r) => r.scope === "project")) {
    const at = out.indexOf(track);
    const twinAt = out.findIndex(
      (r, i) =>
        i < at &&
        r.scope === "session" &&
        isTemplateNameTwin(r.name, track.name)
    );
    if (twinAt >= 0) {
      out.splice(at, 1);
      out.splice(twinAt, 0, track);
    }
  }
  return out;
}
