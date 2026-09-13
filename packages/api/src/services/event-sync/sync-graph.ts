/**
 * The connection-sync GRAPH — the one shape every sync-kind mapper produces
 * (PURE; no I/O).
 *
 * A mapper turns a page of provider records into entities + relations keyed by
 * STABLE refs, so the same real-world subject seen twice in a run (an attendee on
 * two events, a correspondent on ten threads, a contact who also emailed) folds
 * into ONE entity before anything is written:
 *   - `person:<email>`        — a person is identified by their address
 *   - `company:<domain>`      — an organization by its corporate email domain
 *   - `event:<googleEventId>` / `contact:<resourceName>` — provider records
 *
 * The runner then lands the merged graph either as ONE grouped `import.graph`
 * proposal (first run) or through `EntityUpsertService` (steady, rule = auto).
 * Both need the same two facts per entity, carried here: WHICH upsert identity
 * (source + externalId, the `entity_external_links` key) and WHERE the record
 * lives upstream (`url`, null when the provider gives none — never guessed).
 */

import {
  emailDomain,
  isCorporateDomain,
  companyNameFromDomain,
} from "../../utils/email-domain.js";

/** Upsert identity of one entity: the `entity_external_links` (provider, externalId) key. */
export interface SyncIdentity {
  source: string;
  externalId: string;
  /** Where the record lives upstream; null when the provider exposes no link. */
  url: string | null;
}

export interface SyncGraphEntity {
  ref: string;
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
  identity: SyncIdentity;
}

export interface SyncGraphRelation {
  sourceRef: string;
  targetRef: string;
  type: string;
}

export interface SyncGraph {
  entities: SyncGraphEntity[];
  relations: SyncGraphRelation[];
}

// Relation-def slugs (default-relation-defs.ts). Never invented here.
export const RELATION_ATTENDED_BY = "attended_by";
export const RELATION_RELATES_TO = "relates_to";
export const RELATION_WORKS_AT = "works_at";

/** Source tags for identities that are not a provider record id. */
export const EMAIL_IDENTITY_SOURCE = "email";
export const DOMAIN_IDENTITY_SOURCE = "domain";

export function emptySyncGraph(): SyncGraph {
  return { entities: [], relations: [] };
}

export function personRef(email: string): string {
  return `person:${email.trim().toLowerCase()}`;
}

export function companyRef(domain: string): string {
  return `company:${domain}`;
}

/**
 * Fold `next` into `into` IN PLACE by ref. The first entity for a ref keeps its
 * title; properties are filled (never overwritten) from later sightings; a
 * provider identity (a real record link) replaces an email/domain identity, since
 * it is the stronger thing to link. Relations dedup on (source, target, type).
 */
export function mergeSyncGraph(into: SyncGraph, next: SyncGraph): SyncGraph {
  const byRef = new Map(into.entities.map((e) => [e.ref, e]));
  for (const e of next.entities) {
    const prior = byRef.get(e.ref);
    if (!prior) {
      const copy = { ...e, properties: { ...e.properties } };
      into.entities.push(copy);
      byRef.set(e.ref, copy);
      continue;
    }
    for (const [k, v] of Object.entries(e.properties)) {
      if (prior.properties[k] === undefined) prior.properties[k] = v;
    }
    if (isDerivedIdentity(prior.identity) && !isDerivedIdentity(e.identity)) {
      prior.identity = e.identity;
    }
  }
  const seen = new Set(into.relations.map(relationKey));
  for (const r of next.relations) {
    const k = relationKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    into.relations.push(r);
  }
  return into;
}

function isDerivedIdentity(id: SyncIdentity): boolean {
  return (
    id.source === EMAIL_IDENTITY_SOURCE || id.source === DOMAIN_IDENTITY_SOURCE
  );
}

function relationKey(r: SyncGraphRelation): string {
  return `${r.sourceRef}|${r.targetRef}|${r.type}`;
}

export interface Participant {
  email: string;
  name?: string;
}

/**
 * Local parts of automated senders. A first sync over mail must not mint a
 * person for every notification robot the user ever received from.
 */
const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|updates?|newsletters?)([+._-]|$)/i;

export function isAutomatedAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return AUTOMATED_LOCAL_PART.test(local);
}

/**
 * Person (+ company for a corporate domain + `works_at`) for each participant,
 * optionally linked FROM an anchor entity (an event's `attended_by`). Refs are
 * email/domain keyed so the runner's merge collapses repeats across records.
 */
export function participantsGraph(
  participants: Participant[],
  anchor?: { ref: string; personRelation: string; companyRelation?: string }
): SyncGraph {
  const graph = emptySyncGraph();
  for (const p of participants) {
    const email = p.email.trim().toLowerCase();
    if (!email.includes("@")) continue;
    const pRef = personRef(email);
    mergeSyncGraph(graph, {
      entities: [
        {
          ref: pRef,
          profileSlug: "person",
          title: p.name?.trim() || email.split("@")[0] || "Unknown contact",
          properties: { email, source: "google" },
          identity: {
            source: EMAIL_IDENTITY_SOURCE,
            externalId: email,
            url: null,
          },
        },
      ],
      relations: anchor
        ? [
            {
              sourceRef: anchor.ref,
              targetRef: pRef,
              type: anchor.personRelation,
            },
          ]
        : [],
    });

    const domain = emailDomain(email);
    if (domain && isCorporateDomain(domain)) {
      const cRef = companyRef(domain);
      const relations: SyncGraphRelation[] = [
        { sourceRef: pRef, targetRef: cRef, type: RELATION_WORKS_AT },
      ];
      if (anchor?.companyRelation) {
        relations.push({
          sourceRef: anchor.ref,
          targetRef: cRef,
          type: anchor.companyRelation,
        });
      }
      mergeSyncGraph(graph, {
        entities: [
          {
            ref: cRef,
            profileSlug: "company",
            title: companyNameFromDomain(domain),
            properties: { website: `https://${domain}`, source: "google" },
            identity: {
              source: DOMAIN_IDENTITY_SOURCE,
              externalId: domain,
              url: null,
            },
          },
        ],
        relations,
      });
    }
  }
  return graph;
}

/**
 * Parse an RFC 5322-ish address-list header (`From`/`To`/`Cc`):
 * `Jane Doe <jane@acme.io>, "Doe, John" <john@acme.io>, bare@x.com`.
 * Commas inside quotes or angle brackets do not split. Entries without an
 * address are dropped.
 */
export function parseAddressList(
  header: string | null | undefined
): Participant[] {
  if (!header) return [];
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of header) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);

  const out: Participant[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*)<([^>]+)>\s*$/);
    const email = (angle ? angle[2] : part).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const name = angle
      ? angle[1]
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .trim()
      : "";
    out.push({ email: email.toLowerCase(), ...(name ? { name } : {}) });
  }
  return out;
}
