/**
 * Every kept VERSION of a playbook's definition (0416, `playbook_versions`).
 *
 * A step that IS a playbook (`PlaybookStage.uses`) is pinned at a version
 * (founder decision, proposal 72fdca0b): the shared step keeps improving, and a
 * playbook that uses it keeps running the version it was written against until
 * its author moves the pin. That needs the old definition, and before 0416 a
 * playbook kept only its current one and an integer `version`.
 *
 * THE RULE: whoever sets `playbooks.version` (a create, or an update whose
 * definition changed, `definitionVersionChanged`) records that version here in
 * the SAME transaction, through {@link recordPlaybookVersion}. The tripwire
 * `__tripwires__/playbook-version-history.test.ts` scans every writer of
 * `playbooks` and holds each to it, or to a written reason it sets no version.
 *
 * Reads go through {@link loadPlaybookVersion} AFTER the caller has checked the
 * playbook itself is visible (the row carries no workspace of its own: it is
 * the playbook's, and the playbook's floor is the floor).
 */

import {
  and,
  eq,
  playbookVersions,
  type db as Pool,
  type Playbook,
} from "@synap/database";
import { DEFINITION_VERSION_FIELDS } from "./definition-version.js";

/**
 * What a kept version holds: every field that bumps `version`, plus what a run
 * of that version needs to read it as a playbook (its name, the kind it works
 * on, its executor and scope). The 0416 backfill builds the same object in SQL;
 * `playbook-versions.test.ts` pins the two together.
 */
export const PLAYBOOK_VERSION_FIELDS = [
  ...DEFINITION_VERSION_FIELDS,
  "name",
  "description",
  "subjectProfile",
  "executor",
  "scope",
] as const;

export type PlaybookVersionField = (typeof PLAYBOOK_VERSION_FIELDS)[number];

/** The definition a version keeps, read off a playbook row. Pure. */
export function playbookVersionDefinition(
  playbook: Pick<Playbook, PlaybookVersionField>
): Record<PlaybookVersionField, unknown> {
  const out = {} as Record<PlaybookVersionField, unknown>;
  for (const field of PLAYBOOK_VERSION_FIELDS) {
    out[field] = playbook[field] ?? null;
  }
  return out;
}

/** The pool, or a transaction opened on it. */
type DbOrTx =
  typeof Pool | Parameters<Parameters<(typeof Pool)["transaction"]>[0]>[0];

/**
 * Keep `playbook`'s CURRENT version. Call it in the transaction that set
 * `playbooks.version` (or created the row). Idempotent: a version already kept
 * is left as it is (a version, once kept, never changes).
 */
export async function recordPlaybookVersion(
  tx: DbOrTx,
  playbook: Pick<Playbook, "id" | "version" | PlaybookVersionField>,
  createdBy?: string | null
): Promise<void> {
  await tx
    .insert(playbookVersions)
    .values({
      playbookId: playbook.id,
      version: playbook.version,
      definition: playbookVersionDefinition(playbook),
      createdBy: createdBy ?? null,
    })
    .onConflictDoNothing();
}

/**
 * One kept version's definition, or `null` when the pod does not keep it.
 * The caller has already checked that the playbook is visible.
 */
export async function loadPlaybookVersion(
  reader: DbOrTx,
  playbookId: string,
  version: number
): Promise<Record<string, unknown> | null> {
  const [row] = await reader
    .select({ definition: playbookVersions.definition })
    .from(playbookVersions)
    .where(
      and(
        eq(playbookVersions.playbookId, playbookId),
        eq(playbookVersions.version, version)
      )
    )
    .limit(1);
  return row?.definition ?? null;
}

/**
 * `playbook` as it stood at the kept `version` (a step that `uses` it is pinned
 * there): every kept field of that version over the live row, `version` set to
 * the pin. The live row is returned unchanged when it IS that version. Throws
 * when the pod does not keep the version (the write door refuses such a pin;
 * this is the floor for a definition written before it). The caller has
 * already checked the playbook itself is visible.
 */
export async function playbookAtVersion<P extends Playbook>(
  reader: DbOrTx,
  playbook: P,
  version: number
): Promise<P> {
  if (playbook.version === version) return playbook;
  const definition = await loadPlaybookVersion(reader, playbook.id, version);
  if (!definition) {
    throw new Error(
      `Version ${version} of "${playbook.name}" is not kept: pin version ${playbook.version} or a kept one.`
    );
  }
  const pinned = { ...playbook, version } as P;
  for (const field of PLAYBOOK_VERSION_FIELDS) {
    if (field in definition) {
      (pinned as Record<string, unknown>)[field] = definition[field];
    }
  }
  return pinned;
}
