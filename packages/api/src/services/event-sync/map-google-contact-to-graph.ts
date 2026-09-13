/**
 * Google People connection → sync graph mapper (PURE function; no I/O).
 *
 * Input is one `connections[]` Person from the `contacts_list` verb
 * (`people.connections.list`, personFields names,emailAddresses,phoneNumbers,
 * organizations).
 *
 * A contact is a `person` (a `contact` is a person wearing a business hat — the
 * kind/facet manifest converts `contact` → person). Its upsert identity is the
 * People `resourceName` under the `google` provider, so a re-sync hits the
 * external link exactly. A contact WITH an email shares the `person:<email>` ref
 * with the same address seen on events/threads, so the run folds them together.
 *
 * CONFIDENCE GATE: a contact with neither an email nor a phone carries no strong
 * identity signal, so it could only ever merge on a name — it is skipped rather
 * than imported as an unmatchable duplicate. `url` is null: Google documents no
 * web URL for a People resource, and a place is never guessed.
 */

import {
  emptySyncGraph,
  mergeSyncGraph,
  participantsGraph,
  personRef,
  type SyncGraph,
} from "./sync-graph.js";
import { GOOGLE_PROVIDER } from "./map-gcal-to-graph.js";

interface Primary {
  metadata?: { primary?: boolean } | null;
}

export interface GooglePerson {
  resourceName?: string;
  names?: Array<Primary & { displayName?: string }> | null;
  emailAddresses?: Array<Primary & { value?: string }> | null;
  phoneNumbers?: Array<Primary & { value?: string }> | null;
  organizations?: Array<Primary & { name?: string; title?: string }> | null;
}

export interface GoogleContactGraph {
  resourceName: string;
  graph: SyncGraph;
}

function pickPrimary<T extends Primary>(
  list: T[] | null | undefined
): T | undefined {
  const items = list ?? [];
  return items.find((x) => x?.metadata?.primary) ?? items[0];
}

export function mapGoogleContactToGraph(
  person: GooglePerson
): GoogleContactGraph | null {
  const resourceName = person.resourceName?.trim();
  if (!resourceName) return null;

  const email = pickPrimary(person.emailAddresses)?.value?.trim().toLowerCase();
  const phone = pickPrimary(person.phoneNumbers)?.value?.trim();
  if (!email && !phone) return null;

  const name = pickPrimary(person.names)?.displayName?.trim();
  const org = pickPrimary(person.organizations);

  const graph = emptySyncGraph();
  if (email) {
    // Person + company/works_at from the shared participant rules first…
    mergeSyncGraph(
      graph,
      participantsGraph([{ email, ...(name ? { name } : {}) }])
    );
  }
  // …then the contact record itself under the same ref, whose provider identity
  // replaces the derived email identity on merge.
  mergeSyncGraph(graph, {
    entities: [
      {
        ref: email ? personRef(email) : `contact:${resourceName}`,
        profileSlug: "person",
        title: name || email?.split("@")[0] || phone || "Unknown contact",
        properties: {
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(org?.title?.trim() ? { jobTitle: org.title.trim() } : {}),
          googleContactId: resourceName,
          source: GOOGLE_PROVIDER,
        },
        identity: {
          source: GOOGLE_PROVIDER,
          externalId: resourceName,
          url: null,
        },
      },
    ],
    relations: [],
  });
  return { resourceName, graph };
}
