/**
 * TRIPWIRE — `settings.exposurePolicy` has ONE writer (Sites W2 S3).
 *
 * The exposure policy decides what a workspace lets its owner share with
 * guests, link holders and the public. It is server-owned: only
 * `shares.setPolicy` (owner, signed-in human) may write it, through
 * `WorkspaceRepository.setExposurePolicy`. The repository's generic writers
 * (create / update / mergeSettings — the doors every package / template
 * applier and settings router uses) strip it; that BEHAVIOUR is proven on
 * PGlite in `services/sharing/__tests__/share-doors.pglite.test.ts`
 * ("generic settings writes and package appliers can neither set nor erase
 * it").
 *
 * This file guards the part a behavioural test cannot see: a NEW writer of the
 * `workspaces` row that bypasses the repository. It DERIVES the set of every
 * `.update(workspaces)` / `.insert(workspaces)` call site in every
 * `packages/*\/src` and `apps/*\/src` file (tests excluded) and requires each
 * file's site COUNT to be classified below with the reason it cannot plant the
 * key. A new call site — in a new file or an already-classified one — fails
 * until someone decides it.
 *
 * Second scan: the literal `exposurePolicy` may appear only in the files that
 * own the key. A writer that names it anywhere else is either a second door or
 * a planted value.
 *
 * WHAT THIS DOES NOT SEE (measured by reading the scan, not assumed): a writer
 * through a raw SQL string (`UPDATE workspaces SET …` in a template — zero exist
 * today, checked by grep 2026-09-26), a table alias (`const t = workspaces;
 * db.update(t)`), or a writer that builds the key name dynamically. The
 * classification is per FILE + COUNT, not per call site: moving a site within
 * a file is invisible.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const dir = path.join(REPO, group);
    if (!fs.existsSync(dir)) continue;
    for (const pkg of fs.readdirSync(dir)) {
      const src = path.join(dir, pkg, "src");
      if (fs.existsSync(src)) roots.push(src);
    }
  }
  return roots;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.") &&
      !full.includes("__tests__") &&
      !full.includes("__tripwires__")
    ) {
      out.push(full);
    }
  }
  return out;
}

const WRITER = /\.(?:update|insert)\(\s*(?:schema\.)?workspaces\s*\)/g;

/**
 * Every file that writes the `workspaces` row, with its call-site count and
 * WHY it cannot plant `exposurePolicy`.
 */
const CLASSIFIED: Record<string, { sites: number; why: string }> = {
  "packages/database/src/repositories/workspace-repository.ts": {
    sites: 5,
    why: "THE door: create/update/mergeSettings strip the key (update carries the stored value over); setExposurePolicy is the one writer; setPrimarySurface is a jsonb_set on layout.",
  },
  // Key-targeted SQL: `settings || '{<fixed key>: …}'` or jsonb_set on a
  // fixed path — the key written is a code literal, never the policy.
  "packages/api/src/routers/connectors-trpc.ts": {
    sites: 1,
    why: "settings || {enrichment}",
  },
  "packages/api/src/routers/devplane.ts": {
    sites: 1,
    why: "settings || {devplane}",
  },
  "packages/api/src/routers/intelligence.ts": {
    sites: 2,
    why: "jsonb_set on serviceCommands / intelligenceServiceId",
  },
  "packages/api/src/routers/proactive.ts": {
    sites: 1,
    why: "settings || {proactiveAi}",
  },
  "packages/api/src/routers/system.ts": {
    sites: 1,
    why: "settings || {corsAllowedOrigins}",
  },
  "packages/api/src/routers/workspaces/mcp-servers.ts": {
    sites: 1,
    why: "settings || {mcpServers}",
  },
  "apps/api/src/startup-hooks.ts": {
    sites: 1,
    why: "settings || {corsAllowedOrigins}",
  },
  // Stored-spread: read the STORED settings, spread them, add/remove a fixed
  // code key. They carry an existing policy over unchanged and cannot add one.
  "packages/api/src/routers/workspaces/definition-engine.ts": {
    sites: 3,
    why: "{...stored, appId/proposalId/composedFrom}",
  },
  "packages/api/src/services/package-apply-post-workspace.ts": {
    sites: 1,
    why: "{...stored, actionPlacements}",
  },
  "packages/api/src/services/workspace-creation-service.ts": {
    sites: 3,
    why: "settings || {fixed keys} / {...stored, proposalId}",
  },
  "packages/database/src/utils/create-default-whiteboard.ts": {
    sites: 2,
    why: "{...stored, mainWhiteboardId}",
  },
  "packages/database/src/utils/preferences.ts": {
    sites: 1,
    why: "setNestedValue(stored, typed WorkspacePreferenceKey)",
  },
  "packages/database/src/services/user-provisioning.ts": {
    sites: 2,
    why: "system-created pod-admin workspace: literal settings / {...stored, systemSlug, surfaceClass}",
  },
  "apps/api/src/routers/provision.ts": {
    sites: 3,
    why: "{...stored, intelligenceServiceId} / stored minus intelligenceServiceId / stored minus controlPlane",
  },
  // Writes that do not touch settings at all.
  "packages/api/src/routers/workspaces.ts": {
    sites: 1,
    why: "no settings (archive/name column write); the settings door is WorkspaceRepository",
  },
  "packages/database/src/utils/create-workspace-from-definition.ts": {
    sites: 1,
    why: "no settings (name column); settings go through WorkspaceRepository.create/mergeSettings",
  },
  // Operator bootstrap script, never reachable from a request.
  "packages/api/src/scripts/create-admin-user.ts": {
    sites: 3,
    why: "CLI bootstrap: literal settings for a fresh admin workspace",
  },
  // Replication of the owner's OWN rows between their devices/pods: it copies
  // the stored settings verbatim (including a policy the owner set), it does
  // not originate one.
  "packages/api/src/routers/sync.ts": {
    sites: 1,
    why: "replica upsert of a synced row",
  },
  // KNOWN DEFECT, recorded not fixed (Sites W2 S3 finding): the agent-preset
  // re-provision REPLACES the whole blob with a 3-key literal, which erases
  // every stored key — controlPlane and exposurePolicy included. It cannot
  // PLANT a policy (the literal has no such key); it can only reset one.
  "packages/api/src/routers/hub-protocol/rest/workspaces.ts": {
    sites: 1,
    why: "agent preset literal REPLACE (erases, cannot plant)",
  },
};

/** Files allowed to name the key. */
const KEY_OWNERS = new Set([
  "packages/database/src/utils/exposure-policy-settings.ts",
  "packages/database/src/repositories/workspace-repository.ts",
  "packages/api/src/connectors/server-owned-settings.ts",
  "packages/api/src/services/sharing/exposure-policy.ts",
  "packages/api/src/services/sharing/share-service.ts",
]);

const files = sourceRoots().flatMap((r) => walk(r));

function writerCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const n = [...fs.readFileSync(file, "utf8").matchAll(WRITER)].length;
    if (n > 0) counts.set(path.relative(REPO, file), n);
  }
  return counts;
}

describe("settings.exposurePolicy — one writer", () => {
  const found = writerCounts();

  it("the scan is not vacuous", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(found.size).toBeGreaterThanOrEqual(15);
    // self-check: the regex still sees a literal sample of what it hunts
    expect([..."db.update(workspaces)".matchAll(WRITER)]).toHaveLength(1);
    expect(
      found.get("packages/database/src/repositories/workspace-repository.ts")
    ).toBe(5);
  });

  it("every workspaces-row writer is classified, with its exact site count", () => {
    const unclassified: string[] = [];
    for (const [file, n] of found) {
      const c = CLASSIFIED[file];
      if (!c || c.sites !== n) {
        unclassified.push(
          `${file}: ${n} site(s)${c ? ` (classified ${c.sites})` : ""}`
        );
      }
    }
    expect(
      unclassified,
      "A new writer of the `workspaces` row. Route settings through WorkspaceRepository (which strips `exposurePolicy`), or classify the site here with the reason it cannot plant the key."
    ).toEqual([]);
  });

  it("no classified entry is stale", () => {
    const stale = Object.keys(CLASSIFIED).filter((f) => !found.has(f));
    expect(
      stale,
      "remove the entry — the file no longer writes the row"
    ).toEqual([]);
  });

  it("only the owning files name the key", () => {
    const naming = files
      .filter((f) => fs.readFileSync(f, "utf8").includes("exposurePolicy"))
      .map((f) => path.relative(REPO, f));
    // non-vacuity: the owners are really found by this scan
    expect(naming).toContain(
      "packages/api/src/services/sharing/exposure-policy.ts"
    );
    expect(naming.filter((f) => !KEY_OWNERS.has(f))).toEqual([]);
  });
});
