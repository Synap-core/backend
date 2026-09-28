/**
 * "WHAT I LOOKED AT" — the names on an ask's provenance, resolved for the
 * person reading it.
 *
 * The agent declares `{kind, id}` only (`AskLookedAtRefSchema` strips any
 * title it sends), and the declaring door floors each ref against the WRITER
 * (`findUnreachableOutputRefs`). This is the READ half: each name is resolved
 * through the READER's access floor — the registered `VisibilityRule` for the
 * kind, via `scopedDb` — so a name is never shown to someone who could not open
 * the thing, and a rename shows up. A ref the reader cannot see (moved,
 * deleted, never theirs) is DROPPED, indistinguishable from one that does not
 * exist.
 */

import { inArray } from "@synap/database";
import {
  entities,
  documents,
  views,
  automations,
  playbooks,
} from "@synap/database/schema";
import type { SlotAsk, SlotAskLookedAt } from "@synap/playbooks";
// The BARREL: importing it runs `registry.ts`'s registrations, without which
// `scopedDb` throws on every table.
import { AccessContext, scopedDb } from "../../access/index.js";
import { UUID_RE } from "./session-metadata.js";

type Named = { id: string; title?: string | null; name?: string | null };

/** `kind:id` → display name, for the refs `userId` may see. */
async function visibleNames(
  userId: string,
  refs: readonly SlotAskLookedAt[]
): Promise<Map<string, string | null>> {
  const byKind = new Map<string, string[]>();
  for (const r of refs) {
    if (!UUID_RE.test(r.id)) continue;
    const ids = byKind.get(r.kind) ?? [];
    if (!ids.includes(r.id)) ids.push(r.id);
    byKind.set(r.kind, ids);
  }
  const scoped = scopedDb(AccessContext.operator({ userId }));
  const read = async (
    kind: SlotAskLookedAt["kind"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: any,
    nameColumn: "title" | "name"
  ): Promise<Array<[string, string | null]>> => {
    const ids = byKind.get(kind);
    if (!ids?.length) return [];
    const rows = await scoped.findMany<Named>(table, {
      where: inArray(table.id, ids),
      columns: { id: true, [nameColumn]: true },
    });
    return rows.map((r) => [`${kind}:${r.id}`, r[nameColumn] ?? null]);
  };
  const found = await Promise.all([
    read("entity", entities, "title"),
    read("document", documents, "title"),
    read("view", views, "name"),
    read("automation", automations, "name"),
    read("playbook", playbooks, "name"),
  ]);
  return new Map(found.flat());
}

/**
 * Resolve every `ask.lookedAt` on these items for `userId`: visible refs gain
 * their `title` (absent when the object has none), invisible ones are dropped.
 * Items with no provenance are returned untouched, and no query runs when
 * none has any.
 */
export async function resolveLookedAtForReader<
  T extends { ask?: SlotAsk | null },
>(
  userId: string,
  items: T[]
): Promise<T[]> {
  const all = items.flatMap((i) => i.ask?.lookedAt ?? []);
  if (all.length === 0) return items;
  const names = await visibleNames(userId, all);
  return items.map((item) => {
    const lookedAt = item.ask?.lookedAt;
    if (!item.ask || !lookedAt) return item;
    const resolved: SlotAskLookedAt[] = [];
    for (const ref of lookedAt) {
      const key = `${ref.kind}:${ref.id}`;
      if (!names.has(key)) continue;
      const title = names.get(key);
      resolved.push({ kind: ref.kind, id: ref.id, ...(title ? { title } : {}) });
    }
    return { ...item, ask: { ...item.ask, lookedAt: resolved } };
  });
}
