/**
 * Gmail thread → sync graph mapper (PURE function; no I/O).
 *
 * Input is one item of the `gmail_list_threads` verb: a `threads.list` row
 * expanded with `threads.get?format=metadata` (messages[].id / internalDate /
 * labelIds / headers — the fields Google documents for METADATA format).
 *
 * WHAT A THREAD PRODUCES: its correspondents. Each participant becomes a
 * person (email identity) and, for a corporate domain, a company linked with
 * `works_at` — the SAME `participantsGraph` calendar attendees use, so a person
 * met on an event and emailed later folds into one entity.
 *
 * The thread ITSELF is not materialized: no system profile models an email
 * thread today (a thread is a typed `channel` in the messaging model, and
 * minting a new kind is a schema decision, not a mapper's).
 *
 * RELEVANCE, cheap signals before any LLM:
 *   - only threads the user took part in (a message labelled `SENT`) — mail the
 *     user merely received (newsletters, receipts) is not their network;
 *   - the user's own addresses (the `From` of their SENT messages) are never a
 *     participant;
 *   - automated senders (no-reply@, notifications@ …) are dropped.
 */

import {
  emptySyncGraph,
  isAutomatedAddress,
  mergeSyncGraph,
  parseAddressList,
  participantsGraph,
  type Participant,
  type SyncGraph,
} from "./sync-graph.js";

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailThreadMessage {
  id?: string;
  internalDate?: string | null;
  labelIds?: string[] | null;
  headers?: GmailHeader[] | null;
}

export interface GmailThreadItem {
  id?: string;
  snippet?: string | null;
  messages?: GmailThreadMessage[] | null;
  /** Set by the verb's expand when the per-thread detail call failed. */
  error?: string;
}

export interface GmailThreadGraph {
  threadId: string;
  graph: SyncGraph;
  /** Latest message time in the thread (ms), for the run's cursor. */
  lastMessageMs: number | null;
}

function header(msg: GmailThreadMessage, name: string): string | undefined {
  const h = (msg.headers ?? []).find(
    (x) => (x?.name ?? "").toLowerCase() === name.toLowerCase()
  );
  return typeof h?.value === "string" ? h.value : undefined;
}

/**
 * Map ONE expanded Gmail thread to its correspondent graph. Returns null when
 * the thread has no id, its detail failed, or the user never wrote in it.
 */
export function mapGmailThreadToGraph(
  item: GmailThreadItem
): GmailThreadGraph | null {
  const threadId = item.id?.trim();
  if (!threadId || item.error) return null;
  const messages = item.messages ?? [];

  const sent = messages.filter((m) => (m.labelIds ?? []).includes("SENT"));
  if (sent.length === 0) return null;

  const own = new Set<string>();
  for (const m of sent) {
    for (const p of parseAddressList(header(m, "From"))) own.add(p.email);
  }

  const byEmail = new Map<string, Participant>();
  let lastMessageMs: number | null = null;
  for (const m of messages) {
    const ms = Number(m.internalDate);
    if (Number.isFinite(ms) && (lastMessageMs === null || ms > lastMessageMs)) {
      lastMessageMs = ms;
    }
    for (const name of ["From", "To", "Cc"]) {
      for (const p of parseAddressList(header(m, name))) {
        if (own.has(p.email) || isAutomatedAddress(p.email)) continue;
        const prior = byEmail.get(p.email);
        if (!prior || (!prior.name && p.name)) byEmail.set(p.email, p);
      }
    }
  }

  const graph = emptySyncGraph();
  mergeSyncGraph(graph, participantsGraph([...byEmail.values()]));
  return { threadId, graph, lastMessageMs };
}
