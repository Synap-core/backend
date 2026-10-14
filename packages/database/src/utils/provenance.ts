/**
 * `provenance` and `provider` — HOW a record arrived and WHO it came from.
 *
 * Founder decision 2026-09-14 (pod dafee96b, "Split the source field into
 * provenance and leadSource"): the pod-wide `source` field carried transport
 * values (manual, import) and CRM lead attribution (referral, cold-outreach)
 * in ONE enum. One field name denoting two things was the bug, and on
 * 2026-10-12 it bit: the CRM lead list was unioned into the global `source`
 * def and every connector writing `source: 'fal.ai'` was refused at approval.
 *
 * The split:
 *  - `provenance` — a CLOSED enum of transport categories, below. Closed on
 *    purpose: it is filtered and grouped on, and a typo must fail at write
 *    time, not fork the vocabulary. Extending it is a one-line edit HERE (the
 *    seeder writes `constraints.enum` from this list; catalog writers are
 *    checked against it by `provenance-writers.tripwire.test.ts`).
 *  - `provider` — FREE text: the service or client a record came from
 *    ('fal.ai', 'cal.com', 'fireflies'). Open because the set of providers is
 *    open; a closed list would re-create the exact rejection this split fixes.
 *  - `leadSource` — CRM lead attribution, declared by the CRM template on
 *    person / company / the lead role ONLY (a profile overlay or base def,
 *    never a global).
 *
 * `source` stays as a legacy, free-text global def so values written before
 * the split stay readable; nothing new writes it.
 */
export const PROVENANCE_VALUES = [
  "manual",
  "mcp",
  "import",
  "connector",
  "automation",
  "agent",
  "webhook",
] as const;

export type Provenance = (typeof PROVENANCE_VALUES)[number];
