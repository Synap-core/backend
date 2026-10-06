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
}

const ALL_ACTIONS = GRANT_ACTIONS;

/**
 * The subjects a selector offers, in display order. The set is the read
 * subjects the access layer knows (`api/src/access/grant-read.ts`
 * GRANT_READ_SPECS) that a person would plausibly hand to an app or an AI;
 * the actions are the writes each one has a governed door for. Internal
 * subjects (vault, apiKey, preference, …) are deliberately absent — they are
 * granted only by an explicit pattern, never by a checkbox.
 */
export const GRANT_SUBJECT_CATALOG: readonly GrantSubjectSpec[] = [
  { subject: "entity", actions: ALL_ACTIONS },
  { subject: "document", actions: ALL_ACTIONS },
  { subject: "view", actions: ALL_ACTIONS },
  { subject: "relation", actions: ALL_ACTIONS },
  { subject: "project", actions: ["read", "create", "update"] },
  { subject: "session", actions: ["read", "create", "update"] },
  { subject: "proposal", actions: ["read"] },
  { subject: "channel", actions: ["read", "create"] },
  { subject: "automation", actions: ["read", "create", "update"] },
  { subject: "playbook", actions: ["read", "create", "update"] },
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

/** "Documents", "Entities" — the plural noun, from the vocabulary. */
export function grantSubjectLabel(subject: string): string {
  return resolveObjectNounPlural(subject);
}

/** A kind row's label: the pod's own name for it, else the vocabulary noun. */
export function grantKindLabel(kind: string, name?: string | null): string {
  return name?.trim() ? name : resolveObjectNounPlural(kind);
}

/** "Read", "Create" — the imperative verb, from the vocabulary. */
export function grantActionLabel(action: string): string {
  return resolveActionLabel(action, "imperative");
}
