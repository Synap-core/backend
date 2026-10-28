/**
 * The grant SUBJECT CATALOG — which subjects a person can grant from a UI, and
 * which actions each one offers.
 *
 * It is the user-facing slice of the grammar (`./grammar.ts`), not a second
 * grammar: every cell it offers is a plain `<subject>[.<kind>].<action>` key.
 * A pattern outside the catalog (`vault.redeem`, `entity.note.merge`) is still
 * a valid grant — the selector keeps it verbatim and the summary lists it as
 * "other"; it simply has no checkbox.
 *
 * Labels are NEVER written here. Every word comes from the vocabulary door
 * (`resolveObjectNounPlural`, `resolveActionLabel`), so a subject renders the
 * same in the grant UI as everywhere else (`.claude/rules/vocabulary.md`).
 */

import {
  resolveActionLabel,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";
import { GRANT_ACTIONS, QUALIFIED_GRANT_SUBJECTS } from "./grammar.js";

/** One of the four verbs a grant UI offers. */
export type GrantAction = (typeof GRANT_ACTIONS)[number];

export interface GrantSubjectSpec {
  /** The grammar subject (the governance spelling): `entity`, `document`, … */
  readonly subject: string;
  /** The actions the UI offers for it, in display order. */
  readonly actions: readonly GrantAction[];
  /**
   * The vocabulary key that names it, when that is not the subject itself.
   * `event` is the event log here, while the vocabulary's `event` is the
   * calendar kind; the log's noun is `activity`. A renderer that resolves an
   * icon or a noun for a row reads `grantSubjectNoun(subject)`, never the
   * bare subject.
   */
  readonly noun?: string;
}

/**
 * The subjects a selector offers, in display order. The set is the read
 * subjects the access layer knows (`api/src/access/grant-read.ts`
 * GRANT_READ_SPECS) that a person would plausibly hand to an app or an AI;
 * the actions are the writes each one has a governed door for. Internal
 * subjects (vault, apiKey, preference, …) are deliberately absent — they are
 * granted only by an explicit pattern, never by a checkbox.
 */
export const GRANT_SUBJECT_CATALOG: readonly GrantSubjectSpec[] = [
  { subject: "entity", actions: GRANT_ACTIONS },
  { subject: "document", actions: GRANT_ACTIONS },
  { subject: "view", actions: GRANT_ACTIONS },
  { subject: "relation", actions: GRANT_ACTIONS },
  { subject: "project", actions: ["read", "create", "update"] },
  { subject: "session", actions: ["read", "create", "update"] },
  { subject: "proposal", actions: ["read"] },
  { subject: "channel", actions: ["read", "create"] },
  { subject: "automation", actions: ["read", "create", "update"] },
  { subject: "playbook", actions: ["read", "create", "update"] },
  // The event log (`observations.append` checks `event.create`): what a CI or
  // devbox poster needs, and nothing else. Last, so adding it moved no other
  // subject's canonical order (`normalizeGrantPermissions` sorts by catalog
  // index). Display order is the sections' (`sections.ts`, group Activity).
  { subject: "event", actions: ["read", "create"], noun: "activity" },
];

/** Is this subject's key qualified by a kind (`entity.<kind>.<action>`)? */
export function isQualifiedGrantSubject(subject: string): boolean {
  return (QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(subject);
}

/** The catalog entry for a subject, or undefined when it is not offered. */
export function grantSubjectSpec(
  subject: string
): GrantSubjectSpec | undefined {
  return GRANT_SUBJECT_CATALOG.find((s) => s.subject === subject);
}

/**
 * The vocabulary key of a subject the catalog does not offer, when that is not
 * the subject itself. A facet is a ROLE to the person ("Users see Role, not
 * Facet"); granted by an explicit pattern (`facet.create`), it still reads as
 * one.
 */
const UNOFFERED_SUBJECT_NOUNS: Readonly<Record<string, string>> = {
  facet: "role",
};

/** The vocabulary key a subject is named by (`event` → `activity`). */
export function grantSubjectNoun(subject: string): string {
  return (
    grantSubjectSpec(subject)?.noun ??
    UNOFFERED_SUBJECT_NOUNS[subject] ??
    subject
  );
}

/**
 * A door's own spelling of a plain verb, keyed `<subject>.<action>`: putting a
 * role on a record CREATES its facet row, taking it off DELETES it (#411; the
 * same fold as governance-policy's GRANT_ACTION_FOLDS). A UI treats and names
 * the door's spelling as that verb.
 */
const PLAIN_ACTION_OF: Readonly<Record<string, GrantAction>> = {
  "facet.attach": "create",
  "facet.detach": "delete",
};

/** The plain verb a subject's action is (`facet`, `attach` → `create`). */
export function grantPlainAction(
  subject: string,
  action: string | null
): string | null {
  if (action === null) return null;
  return PLAIN_ACTION_OF[`${subject}.${action}`] ?? action;
}

/** "Documents", "Entities", "Activity" — the plural noun, from the vocabulary. */
export function grantSubjectLabel(subject: string): string {
  return resolveObjectNounPlural(grantSubjectNoun(subject));
}

/** A kind row's label: the pod's own name for it, else the vocabulary noun. */
export function grantKindLabel(kind: string, name?: string | null): string {
  return name?.trim() ? name : resolveObjectNounPlural(kind);
}

/** "Read", "Create" — the imperative verb, from the vocabulary. */
export function grantActionLabel(action: string): string {
  return resolveActionLabel(action, "imperative");
}
