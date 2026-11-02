/**
 * DOCUMENT SCOPE AND REFRESHER — the ONE reading of what a write may store in
 * `documents.scope` and `documents.refresh_automation_id` (0387; Generative UI
 * plan 678c56c4, contracts 3 and 4). Every door that writes either field reads
 * it here first: tRPC `documents.create|update`, hub `createDocument`, and the
 * `set_scope` / `set_refresher` patch ops (so MCP and Hub REST too).
 *
 * SCOPE: the stored value is a `LensScope` read by `readLensScope`
 * (`@synap-core/types/lens` — the one scope model, no second one), limited to
 * the five kinds a document reads through (pod, workspace (+ projectId),
 * project, track, session). FLOOR: every id the scope names must be one the
 * WRITER can read (a workspace they are a member of; a project, goal or
 * session the access layer shows them). A scope naming something they cannot
 * read is refused with the same words whether it exists or not, so the refusal
 * never tells them it is there.
 *
 * REFRESHER: an automation id the writer can see (the access layer's
 * automations rule). Binding one is what lets its run sessions rewrite the
 * document's own AI sections without review (decision D4), so it is checked
 * like the scope.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  inArray,
  automations,
  focusSessions,
  projects,
  projectTracks,
  getWorkspaceMembership,
} from "@synap/database";
import {
  lensScopeIds,
  readLensScope,
  type LensScope,
  type LensScopeKind,
} from "@synap-core/types/lens";
import { AccessContext, scopedDb } from "../../access/index.js";

/** The kinds a document's scope may be (contract 3). */
export const DOCUMENT_SCOPE_KINDS = [
  "pod",
  "workspace",
  "project",
  "track",
  "session",
] as const satisfies readonly LensScopeKind[];

export type ScopeObjectKind = "project" | "track" | "session" | "automation";

/** What the floor asks (injectable, so the reading is testable without a DB). */
export interface DocumentScopeFloor {
  /** Ids of `workspaceIds` the writer is a member of. */
  workspaces(workspaceIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Ids of `ids` of `kind` the writer can read. */
  visible(
    kind: ScopeObjectKind,
    ids: readonly string[]
  ): Promise<ReadonlySet<string>>;
}

const TABLE_OF = {
  project: projects,
  track: projectTracks,
  session: focusSessions,
  automation: automations,
} as const;

/** The pod's floor for one writer: workspace membership + the access layer. */
export function podDocumentScopeFloor(userId: string): DocumentScopeFloor {
  const access = AccessContext.operator({ userId });
  return {
    async workspaces(ids) {
      const member = new Set<string>();
      for (const id of new Set(ids)) {
        if (await getWorkspaceMembership(db, id, userId)) member.add(id);
      }
      return member;
    },
    async visible(kind, ids) {
      if (ids.length === 0) return new Set();
      const table = TABLE_OF[kind];
      const rows = await scopedDb(access).findMany<{ id: string }>(table, {
        where: inArray(table.id, [...new Set(ids)]),
        columns: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    },
  };
}

function refuse(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function cannotRead(what: string): never {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: `The scope names ${what} you cannot read, or that does not exist. Name a space, project, goal or session you can open.`,
  });
}

/**
 * Read a scope a write SENT: `null` clears it, anything else must be a
 * document scope whose every id the writer can read. Returns what to store.
 */
export async function resolveDocumentScope(
  value: unknown,
  floor: DocumentScopeFloor
): Promise<LensScope | null> {
  if (value === null) return null;
  const read = readLensScope(value);
  if (!read.ok) refuse(`scope: ${read.reason}.`);
  const scope = read.scope;
  if (!(DOCUMENT_SCOPE_KINDS as readonly string[]).includes(scope.kind)) {
    refuse(
      `scope: a document reads through ${DOCUMENT_SCOPE_KINDS.join(", ")}, not "${scope.kind}".`
    );
  }
  const ids = lensScopeIds(scope);
  if (ids.workspaceIds.length > 0) {
    const member = await floor.workspaces(ids.workspaceIds);
    if (ids.workspaceIds.some((id) => !member.has(id))) cannotRead("a space");
  }
  const checks: Array<[ScopeObjectKind, string[], string]> = [
    ["project", ids.projectIds, "a project"],
    ["track", ids.trackIds, "a goal"],
    ["session", ids.sessionIds, "a session"],
  ];
  for (const [kind, wanted, noun] of checks) {
    if (wanted.length === 0) continue;
    const seen = await floor.visible(kind, wanted);
    if (wanted.some((id) => !seen.has(id))) cannotRead(noun);
  }
  return scope;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a refresher a write SENT: `null` unbinds, anything else must be the id
 * of an automation the writer can see.
 */
export async function resolveDocumentRefresher(
  value: unknown,
  floor: DocumentScopeFloor
): Promise<string | null> {
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    refuse("refreshAutomationId: an automation's id (a UUID), or null.");
  }
  const seen = await floor.visible("automation", [value]);
  if (!seen.has(value)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "refreshAutomationId names an automation you cannot see, or that does not exist. Use an id synap_list_automations returns.",
    });
  }
  return value;
}

/** What a write stores: each field read and floored; an absent key = unchanged. */
export interface DocumentScopeFields {
  scope?: LensScope | null;
  refreshAutomationId?: string | null;
}

/** The fields a write sends, read together; absent stays absent (no change). */
export async function resolveDocumentScopeFields(
  input: { scope?: unknown; refreshAutomationId?: unknown },
  floor: DocumentScopeFloor
): Promise<DocumentScopeFields> {
  return {
    ...(input.scope !== undefined
      ? { scope: await resolveDocumentScope(input.scope, floor) }
      : {}),
    ...(input.refreshAutomationId !== undefined
      ? {
          refreshAutomationId: await resolveDocumentRefresher(
            input.refreshAutomationId,
            floor
          ),
        }
      : {}),
  };
}
