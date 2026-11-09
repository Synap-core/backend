/**
 * The versions of a drafted message, derived ONLY from its proposal row (Hub
 * `GET /channels/:id/drafts/:draftId/versions`, routers/hub-protocol/rest/
 * channel-conversations.ts): the words it was filed with, then each change of
 * its words in `revisionHistory` (every revise door records one entry, with
 * `before` and `patch`, through `mergeProposalRevision`). No second store.
 *
 * Version 1 is the FIRST words: the `before` of the first entry that changed
 * them (an entry's `before` holds the value it replaced), or the current words
 * when nothing changed them. Its author is whoever filed the draft: an agent
 * (`agentUserId` on the row, or `data.draftedBy.agentUserId`) is "ai",
 * otherwise the person. Each later version is an entry whose patch changed the
 * body or the subject: "ai" when the entry records an acting agent, else the
 * person (`by`). An entry that changes neither (a summary, a reasoning) is
 * not a version.
 *
 * Replayed FORWARD, so the last version is checked against the row's current
 * words: a history that does not end at them is refused
 * (`DraftHistoryInconsistentError`), never shown as if it did.
 */

export interface DraftVersion {
  version: number;
  author: "ai" | "person";
  authorId: string | null;
  at: string;
  text: string;
  subject?: string;
}

export interface DraftVersionsRow {
  data: unknown;
  revisionHistory: unknown;
  agentUserId: string | null;
  proposedByUserId: string | null;
  createdBy: string | null;
  createdAt: Date | string;
}

export class DraftHistoryInconsistentError extends Error {
  constructor() {
    super("This draft's history does not end at its current words.");
    this.name = "DraftHistoryInconsistentError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const iso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

interface Words {
  text: string;
  subject: string | undefined;
}

export function deriveDraftVersions(row: DraftVersionsRow): {
  revision: number;
  versions: DraftVersion[];
} {
  const data = isRecord(row.data) ? row.data : {};
  const history: unknown[] = Array.isArray(row.revisionHistory)
    ? row.revisionHistory
    : [];
  const entries = history.filter(isRecord);
  const current: Words = {
    text: str(data.body) ?? "",
    subject: str(data.subject),
  };

  // The first words: each field from the first entry that replaced it.
  const firstBefore = (field: "body" | "subject") => {
    const entry = entries.find(
      (e) => isRecord(e.patch) && has(e.patch, field) && isRecord(e.before)
    );
    return entry
      ? { found: true, value: (entry.before as Record<string, unknown>)[field] }
      : { found: false, value: undefined };
  };
  const body0 = firstBefore("body");
  const subject0 = firstBefore("subject");
  let words: Words = {
    text: body0.found ? (str(body0.value) ?? "") : current.text,
    subject: subject0.found ? str(subject0.value) : current.subject,
  };

  const draftedBy = isRecord(data.draftedBy) ? data.draftedBy : {};
  const drafter = row.agentUserId ?? str(draftedBy.agentUserId) ?? null;
  const versions: DraftVersion[] = [
    {
      version: 1,
      author: drafter ? "ai" : "person",
      authorId: drafter ?? row.proposedByUserId ?? row.createdBy ?? null,
      at: iso(row.createdAt),
      ...wire(words),
    },
  ];

  for (const entry of entries) {
    const patch = isRecord(entry.patch) ? entry.patch : {};
    const next: Words = {
      text: has(patch, "body") ? (str(patch.body) ?? "") : words.text,
      subject: has(patch, "subject") ? str(patch.subject) : words.subject,
    };
    if (next.text === words.text && next.subject === words.subject) continue;
    const agent = str(entry.actingAgentUserId);
    versions.push({
      version: versions.length + 1,
      author: agent ? "ai" : "person",
      authorId: agent ?? str(entry.by) ?? null,
      at: str(entry.at) ?? iso(row.createdAt),
      ...wire(next),
    });
    words = next;
  }

  if (words.text !== current.text || words.subject !== current.subject) {
    throw new DraftHistoryInconsistentError();
  }
  return { revision: history.length, versions };
}

function wire(w: Words): { text: string; subject?: string } {
  return w.subject !== undefined
    ? { text: w.text, subject: w.subject }
    : { text: w.text };
}
