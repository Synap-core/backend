/**
 * TRIPWIRE — every profile-SCHEMA write procedure passes the ownership gate
 * before it writes.
 *
 * The hole: the write procedures in these routers resolved a caller-supplied
 * profile UUID and then wrote, never asking whose profile it was. A member of
 * one workspace could delete another workspace's profile, and any member could
 * link a `required` field onto a system kind — a pod-wide break, because a link
 * row carries no workspace. The gate is `assertProfileSchemaWrite`
 * (utils/profile-schema-write-access.ts).
 *
 * WHAT THIS CHECKS. The procedure set is DERIVED: every `.mutation(` procedure
 * in the three routers, so a new write procedure joins the scan by existing.
 * Each must either call the gate BEFORE its first repository write, or appear
 * in EXEMPT with a reason. An exemption naming a procedure that no longer
 * exists, or is no longer a mutation, fails — the list can only shrink honestly.
 *
 * WHAT THIS DOES NOT SEE (measured, not implied):
 *   • Dominance. "Gate text appears before the first write text" is ordering in
 *     the source, not control flow — a gate inside an `if` that skips it still
 *     passes. The behavioural tests (routers/profile-schema-write-access.test.ts)
 *     are what prove refusal.
 *   • Writes reached through a helper instead of `<name>Repo.<verb>(`. A write
 *     that does not match WRITE_CALL is invisible to the ordering check (the
 *     gate is still required, just not ordered).
 *   • Comments are stripped before scanning, so a gate named only in a comment
 *     does not count. The stripper is regex-based and would also eat a `//`
 *     inside a string literal; none of the scanned bodies contain one today.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTERS = join(process.cwd(), "src", "routers");
const FILES = [
  "profiles.ts",
  "profile-properties.ts",
  "profile-relations.ts",
  "property-defs.ts",
];

const GATE = /\bassertProfileSchemaWrite\(/;
const WRITE_CALL =
  /\b\w+Repo\.(link|unlink|update|delete|grantAccess|revokeAccess)\(/;
const PROCEDURE_MARK =
  /^ {2}([a-zA-Z0-9_]+):\s*(workspaceProcedure|podProcedure|protectedProcedure|podAdminProcedure|publicProcedure)\b/gm;

/** Mutations that are not writes to an EXISTING profile's schema. Shrink-only. */
const EXEMPT: Record<string, string> = {
  "profiles.ts::create":
    "creates a NEW profile — no existing row to own; governed by checkPermissionOrPropose",
  "profiles.ts::setProfileRendererOverride":
    "writes the WORKSPACE overlay (workspaces.settings), governed by checkPermissionOrPropose",
  "profiles.ts::resolveDashboard":
    "KNOWN HOLE, out of this change: writes the pod-wide dashboard renderer (see profile-pod-wide-fields.ts)",
  "profiles.ts::saveDashboard":
    "KNOWN HOLE, out of this change: writes the pod-wide dashboard renderer (see profile-pod-wide-fields.ts)",
  "property-defs.ts::delete":
    "gated by assertWorkspaceWrite on the def row; a base/global def is refused for everyone (stricter than the ownership gate)",
};

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface Procedure {
  id: string;
  body: string;
}

function extractProcedures(file: string, src: string): Procedure[] {
  const marks = [...src.matchAll(PROCEDURE_MARK)];
  return marks.map((m, i) => ({
    id: `${file}::${m[1]}`,
    body: src.slice(m.index!, marks[i + 1]?.index ?? src.length),
  }));
}

function ungated(procedures: Procedure[]): string[] {
  const violations: string[] = [];
  for (const proc of procedures) {
    if (!proc.body.includes(".mutation(")) continue;
    if (proc.id in EXEMPT) continue;
    const gateAt = proc.body.search(GATE);
    const writeAt = proc.body.search(WRITE_CALL);
    if (gateAt === -1) violations.push(`${proc.id}: never calls the gate`);
    else if (writeAt !== -1 && writeAt < gateAt)
      violations.push(`${proc.id}: writes before the gate`);
  }
  return violations;
}

const PROCEDURES = FILES.flatMap((file) =>
  extractProcedures(
    file,
    stripComments(readFileSync(join(ROUTERS, file), "utf8"))
  )
);
const MUTATIONS = PROCEDURES.filter((p) => p.body.includes(".mutation("));

describe("profile schema writes pass the ownership gate", () => {
  it("the scan sees the routers' write procedures (non-vacuity)", () => {
    // 9 in profiles.ts, 3 in profile-properties.ts, 2 in profile-relations.ts,
    // 3 in property-defs.ts today.
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(17);
    expect(
      MUTATIONS.length - Object.keys(EXEMPT).length
    ).toBeGreaterThanOrEqual(10);
  });

  it("every non-exempt mutation calls assertProfileSchemaWrite before its first repository write", () => {
    expect(ungated(PROCEDURES)).toEqual([]);
  });

  it("every exemption still names an existing mutation", () => {
    const mutationIds = new Set(MUTATIONS.map((p) => p.id));
    const stale = Object.keys(EXEMPT).filter((id) => !mutationIds.has(id));
    expect(stale).toEqual([]);
  });

  it("self-check: the scan flags an ungated write, a write-before-gate, and a comment-only gate", () => {
    const sample = stripComments(`export const r = router({
  bad: workspaceProcedure
    .input(z.object({}))
    .mutation(async () => { await profileRepo.delete(id); }),
  late: workspaceProcedure
    .mutation(async () => { await profilePropertyRepo.link(x); await assertProfileSchemaWrite(db, u, p, o); }),
  commented: workspaceProcedure
    .mutation(async () => { /* assertProfileSchemaWrite(db) */ await profileRepo.update(id); }),
  good: workspaceProcedure
    .mutation(async () => { await assertProfileSchemaWrite(db, u, p, o); await profileRepo.delete(id); }),
  read: workspaceProcedure.query(async () => profileRepo.update(id)),
});`);
    expect(ungated(extractProcedures("sample.ts", sample))).toEqual([
      "sample.ts::bad: never calls the gate",
      "sample.ts::late: writes before the gate",
      "sample.ts::commented: never calls the gate",
    ]);
  });
});
