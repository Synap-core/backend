/**
 * SESSION KINDS — which of the three populations a `focus_sessions` row
 * belongs to, declared ONCE for every surface.
 *
 *   - `work`    — a unit of work a person owns (the default lens);
 *   - `run`     — a playbook or automation run (or a capture intake) recorded
 *                 as a session;
 *   - `receipt` — the container an agent's proposals are filed under.
 *
 * The kind is DERIVED, never stored: the predicate that computes it (SQL and
 * TypeScript halves) lives in the backend, `packages/api/src/services/
 * focus-sessions/session-kind.ts`, which re-exports this list so the two can
 * never name different kinds. It moved here because the apps (Relay, the
 * browser, the synap-app SDK, the CLI) each hand-typed the union
 * `"work" | "run" | "receipt"`; they import it from here instead.
 *
 * Zero imports: safe in browser, Electron, React Native, Node and CLI.
 */

/** The three populations. `all` is a filter sentinel, never a value. */
export const SESSION_KINDS = ["work", "run", "receipt"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** A list door's `kind` filter: one population, or `all` (no filter). */
export const SESSION_KIND_FILTERS = [...SESSION_KINDS, "all"] as const;
export type SessionKindFilter = (typeof SESSION_KIND_FILTERS)[number];

export function isSessionKind(v: string | null | undefined): v is SessionKind {
  return v != null && (SESSION_KINDS as readonly string[]).includes(v);
}
