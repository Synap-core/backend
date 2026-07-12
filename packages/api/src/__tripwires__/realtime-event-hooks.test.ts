import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — realtime-relevant repositories must be fed the shared
 * `eventRepository` singleton, never a fresh `new EventRepository(sql)`.
 *
 * Root cause (P0): `EventRepository.eventHooks` is a plain per-instance
 * field. The realtime bridge, materialization, and sync-push hooks are
 * registered ONCE at startup (`setupEventBroadcasting()`) on the module-level
 * `eventRepository` singleton (`@synap/database`). Any repository —
 * EntityRepository, ViewRepository, RelationRepository, WorkspaceRepository,
 * WorkspaceMemberRepository, DocumentRepository, FacetRepository,
 * ProjectMemberRepository — constructed with a *different*, freshly-`new`'d
 * `EventRepository` instance has an empty hook list, so its
 * `BaseRepository.emitCompleted()` → `append()` silently never reaches those
 * hooks. This is exactly how entity/view/relation/workspace realtime socket
 * events went dark.
 *
 * This does NOT ban `new EventRepository(sql)` outright — `utils/audit-log.ts`
 * deliberately constructs fresh, hookless instances for non-`.validated`
 * phases to avoid double-firing hooks for events it appends outside the
 * repository layer (see the comment there). Repositories whose subject type
 * has no realtime mapping (ApiKeyRepository, RoleRepository,
 * SecretsVaultRepository, ProjectRepository, ...) are also unaffected by this
 * bug and are intentionally out of scope.
 *
 * If this fails: change the flagged `new EventRepository(...)` to reference
 * the imported singleton `eventRepository` instead (`import { eventRepository
 * } from "@synap/database"`), matching every other call site that feeds one
 * of the REALTIME_REPO_CLASSES below.
 */

const REALTIME_REPO_CLASSES = [
  "EntityRepository",
  "ViewRepository",
  "RelationRepository",
  "WorkspaceRepository",
  "WorkspaceMemberRepository",
  "DocumentRepository",
  "FacetRepository",
  "ProjectMemberRepository",
];

const FRESH_INSTANCE_RE = /const\s+(\w+)\s*=\s*new EventRepository\(/;
const REALTIME_CTOR_RE = new RegExp(
  `new (?:${REALTIME_REPO_CLASSES.join("|")})\\(`
);
// How many lines after a fresh-instance declaration we scan for it being fed
// into a realtime-mapped repository constructor.
const LOOKAHEAD_LINES = 15;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

// The one deliberate exception — see the module doc comment above.
const ALLOWLIST = new Set<string>(["utils/audit-log.ts"]);

describe("tripwire: realtime-relevant repositories share the eventRepository singleton", () => {
  it("no fresh `new EventRepository(...)` instance is fed to a realtime-mapped repository constructor", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const file of tsFiles(srcRoot)) {
      const rel = relative(srcRoot, file);
      if (ALLOWLIST.has(rel)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(FRESH_INSTANCE_RE);
        if (!match) continue;
        const varName = match[1];

        const window = lines.slice(i + 1, i + 1 + LOOKAHEAD_LINES).join("\n");
        const feedsRealtimeRepo =
          REALTIME_CTOR_RE.test(window) &&
          new RegExp(
            `new (?:${REALTIME_REPO_CLASSES.join("|")})\\([^)]*\\b${varName}\\b`
          ).test(window);

        if (feedsRealtimeRepo) {
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
