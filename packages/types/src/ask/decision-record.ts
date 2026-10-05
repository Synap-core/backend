/**
 * The decision ENTITY's ask record, read off its properties — the ONE adapter
 * between a `decision` entity and the shared rule `askRecommendationOutcome`.
 *
 * The pod files an answered confirm/choose as a `decision` and stamps the
 * frozen ask onto it as flat properties: `decisionOptions`
 * (`[{label, value?, description?, recommended?}]`), `chosenOption` and
 * `recommendedOption` (option KEYS — `askOptionKey`, i.e. `value ?? label`),
 * `followedRecommendation` (absent, never `false`, when nothing was
 * recommended), `decisionStatus`, `sourceSessionId`.
 *
 * Props come off the wire, so every read is defensive: unknown or invalid
 * input yields an empty, honest view and never throws. The followed / overrode
 * verdict is NEVER derived here — the props are shaped into an `AskSnapshot`
 * and handed to `askRecommendationOutcome`. A missing `followedRecommendation`
 * stays `null` (the rule reads `none`), never "overrode" advice nobody gave.
 *
 * Options are parsed LENIENTLY (a row needs a non-blank label; blank
 * value/description are dropped; no length caps): the pod already validated
 * them, and dropping a stored option would hide it from the page.
 */

import { askOptionKey, type AskOption, type AskSnapshot } from "./index.js";
import {
  askRecommendationOutcome,
  type AskRecommendationOutcome,
} from "./card.js";

/** One option as a decision page draws it, both marks resolved. */
export interface DecisionRecordOption {
  key: string;
  label: string;
  description: string | null;
  recommended: boolean;
  chosen: boolean;
}

export interface DecisionRecordView {
  /** `proposed | accepted | superseded | rejected`, or `null` when unset. */
  status: string | null;
  options: DecisionRecordOption[];
  outcome: AskRecommendationOutcome;
  /** The session the decision came from, when stamped. */
  sourceSessionId: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function readOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const label = str(r.label);
    if (!label) continue;
    const value = str(r.value);
    const description = str(r.description)?.trim();
    out.push({
      label,
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(r.recommended === true ? { recommended: true } : {}),
    });
  }
  return out;
}

/**
 * The properties as the snapshot the shared rule reads. Always a `choose`: a
 * filed confirm carries no recommendation, so the rule answers `none` anyway.
 * The recommendation is `recommendedOption` when set, else the option flagged
 * `recommended`.
 */
export function decisionAskSnapshot(
  props: Record<string, unknown>
): AskSnapshot {
  const p = props && typeof props === "object" ? props : {};
  const options = readOptions(p.decisionOptions);
  const flagged = options.find((o) => o.recommended === true);
  return {
    mode: "choose",
    options,
    chosenKey: str(p.chosenOption),
    recommendedKey:
      str(p.recommendedOption) ?? (flagged ? askOptionKey(flagged) : null),
    followedRecommendation:
      typeof p.followedRecommendation === "boolean"
        ? p.followedRecommendation
        : null,
  };
}

export function decisionRecordView(props: unknown): DecisionRecordView {
  const p =
    props && typeof props === "object" && !Array.isArray(props)
      ? (props as Record<string, unknown>)
      : {};
  const snapshot = decisionAskSnapshot(p);
  return {
    status: str(p.decisionStatus),
    options: (snapshot.options ?? []).map((o) => {
      const key = askOptionKey(o);
      return {
        key,
        label: o.label,
        description: o.description ?? null,
        recommended: key === snapshot.recommendedKey,
        chosen: key === snapshot.chosenKey,
      };
    }),
    outcome: askRecommendationOutcome(snapshot),
    sourceSessionId: str(p.sourceSessionId),
  };
}
