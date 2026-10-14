import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPRECATED_INTAKE_PATHS,
  INTAKE_INPUT_KINDS,
  KEPT_AGENT_INTAKE_DOORS,
  REMOVED_INTAKE_PATHS,
  routeIntake,
  type IntakeInput,
  type IntakeInputKind,
  type IntakeRoute,
} from "./index.js";

/**
 * The routing rule and the deprecation record of
 * docs/CAPTURE_LIBRARY_PLAN.md (§1, §2).
 *
 * What these tests do NOT cover, measured: the `where` check proves the file
 * exists, names the symbol, and (for this repo's rows) carries the
 * `@deprecated intake path \`<id>\`` marker. It does not prove the marker sits
 * ON that symbol — granularity is the file. Rows in sibling repos
 * (relay-app, browser, synap-app) are checked only when those checkouts sit
 * next to this one (the monorepo layout); in a lone backend checkout they are
 * skipped, and the count of skipped rows is asserted against the host split.
 */

// ── routeIntake ──────────────────────────────────────────────────────────

/** The plan's §1 table, one row per input kind. */
const EXPECTED: Record<IntakeInputKind, IntakeRoute> = {
  typed: "capture",
  "share-note": "capture",
  url: "library",
  page: "library",
  file: "library",
  photo: "library",
  selection: "library",
  "shared-text": "library",
};

function inputOf(kind: IntakeInputKind, text = "a note"): IntakeInput {
  return kind === "typed" || kind === "share-note" ? { kind, text } : { kind };
}

describe("routeIntake", () => {
  it("the expected table classifies exactly the derived set of input kinds", () => {
    // INTAKE_INPUT_KINDS is build-checked against the union, so a new kind
    // joins this scan by existing — and fails here until it is classified.
    expect(INTAKE_INPUT_KINDS.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(EXPECTED).sort()).toEqual(
      [...INTAKE_INPUT_KINDS].sort()
    );
  });

  it.each([...INTAKE_INPUT_KINDS])("routes %s per the plan's table", (kind) => {
    expect(routeIntake(inputOf(kind))).toBe(EXPECTED[kind]);
  });

  it("splits by authorship, not by what the text contains", () => {
    // A typed sentence holding a URL is still the person's words.
    expect(
      routeIntake({ kind: "typed", text: "https://example.com read later" })
    ).toBe("capture");
    expect(routeIntake({ kind: "typed", text: "https://example.com" })).toBe(
      "capture"
    );
    // Shared text the person did not write is material they bring in.
    expect(routeIntake({ kind: "shared-text" })).toBe("library");
  });

  it("sends both routes somewhere (non-vacuity)", () => {
    const routes = new Set(
      INTAKE_INPUT_KINDS.map((k) => routeIntake(inputOf(k)))
    );
    expect([...routes].sort()).toEqual(["capture", "library"]);
  });
});

// ── the deprecation record ───────────────────────────────────────────────

const PLAN_ROWS: Record<string, readonly string[]> = {
  pod: [
    "capture.url",
    "capture.file",
    "capture.html",
    "capture.vision",
    "capture.linkReader",
    "capture.thought.url",
  ],
  relay: ["relay.note.attachments", "relay.captureUrlHint"],
  browser: [
    "browser.saveLink.capture",
    "browser.smartCapture",
    "browser.quickCapture.file",
  ],
  extension: ["extension.savePage.capture", "extension.tabScan"],
  cli: ["cli.capture.url"],
};

describe("DEPRECATED_INTAKE_PATHS", () => {
  it("holds exactly the plan's rows, per host", () => {
    for (const [host, ids] of Object.entries(PLAN_ROWS)) {
      const got = DEPRECATED_INTAKE_PATHS.filter((p) => p.host === host).map(
        (p) => p.id
      );
      expect(got.sort(), host).toEqual([...ids].sort());
    }
    expect(DEPRECATED_INTAKE_PATHS.length).toBe(
      Object.values(PLAN_ROWS).flat().length
    );
  });

  it("every row is fully shaped", () => {
    expect(DEPRECATED_INTAKE_PATHS.length).toBeGreaterThanOrEqual(14);
    for (const p of DEPRECATED_INTAKE_PATHS) {
      expect(p.since, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${p.since}T00:00:00Z`)), p.id).toBe(
        false
      );
      expect(["marked", "redirected", "refused", "removed"]).toContain(p.stage);
      // A live row is never `removed`: that row belongs in REMOVED_INTAKE_PATHS.
      expect(p.stage, p.id).not.toBe("removed");
      expect(p.reason.length, p.id).toBeGreaterThan(40);
      expect(p.replacedBy.length, p.id).toBeGreaterThan(0);
      expect(p.removalCriteria, p.id).toContain("CAPTURE_LIBRARY_PLAN.md §2");
      expect(p.decisionDoc, p.id).toBe("docs/CAPTURE_LIBRARY_PLAN.md");
      expect(p.where, p.id).toMatch(/^[a-z-]+\/[^:]+:\S/);
    }
  });

  it("ids are unique across live and removed rows", () => {
    const ids = [...DEPRECATED_INTAKE_PATHS, ...REMOVED_INTAKE_PATHS].map(
      (p) => p.id
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("REMOVED_INTAKE_PATHS rows are stage `removed` with a commit", () => {
    for (const p of REMOVED_INTAKE_PATHS) {
      expect(p.stage).toBe("removed");
      expect(p.removedIn).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });
});

// ── the agent door is KEPT, never a row ──────────────────────────────────

const AGENT_DOOR = /synap_capture|\bmcp\b/i;

describe("the agent capture door (founder, 2026-10-13)", () => {
  it("no deprecation row targets the agent door", () => {
    // Self-check: the pattern can still see what it hunts.
    expect(AGENT_DOOR.test("mcp.synap_capture")).toBe(true);
    expect(AGENT_DOOR.test("routers/mcp/tools/index.ts")).toBe(true);
    for (const p of [...DEPRECATED_INTAKE_PATHS, ...REMOVED_INTAKE_PATHS]) {
      expect(AGENT_DOOR.test(p.id), p.id).toBe(false);
      expect(AGENT_DOOR.test(p.where), p.id).toBe(false);
    }
  });

  it("is listed as kept, and kept ids never collide with deprecated ids", () => {
    expect(KEPT_AGENT_INTAKE_DOORS.length).toBeGreaterThan(0);
    const kept = KEPT_AGENT_INTAKE_DOORS.map((d) => d.id);
    expect(kept).toContain("mcp.synap_capture");
    const deprecated = new Set(DEPRECATED_INTAKE_PATHS.map((p) => p.id));
    for (const id of kept) expect(deprecated.has(id), id).toBe(false);
    for (const d of KEPT_AGENT_INTAKE_DOORS) {
      expect(d.why.length, d.id).toBeGreaterThan(20);
    }
  });

  it("every row on a pod path the agent shares says the agent path is kept", () => {
    const shared = DEPRECATED_INTAKE_PATHS.filter((p) =>
      p.where.startsWith("synap-backend/")
    );
    expect(shared.length).toBeGreaterThanOrEqual(7);
    for (const p of shared) {
      expect(p.reason, p.id).toContain("agent path");
      expect(p.reason, p.id).toContain("is kept");
    }
  });
});

// ── every `where` is real (the tripwire that keeps the registry honest) ──

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/types/src/intake-route → the backend repo root. */
const BACKEND_ROOT = resolve(HERE, "../../../..");

/** Where a monorepo sibling checkout lives, if it is present at all. */
function repoRoot(repo: string): string | null {
  if (repo === "synap-backend") return BACKEND_ROOT;
  const candidates = [
    resolve(BACKEND_ROOT, "..", repo),
    resolve(BACKEND_ROOT, "..", "synap-workspace-root", repo),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function parseWhere(where: string): {
  repo: string;
  path: string;
  symbol: string;
} {
  const slash = where.indexOf("/");
  const colon = where.lastIndexOf(":");
  return {
    repo: where.slice(0, slash),
    path: where.slice(slash + 1, colon),
    symbol: where.slice(colon + 1),
  };
}

function markerFor(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@deprecated intake path \`${escaped}\``);
}

describe("every `where` names a real code site", () => {
  it("the marker pattern can see a literal sample (self-check)", () => {
    expect(
      markerFor("capture.url").test(
        "* @deprecated intake path `capture.url` (person's use)"
      )
    ).toBe(true);
    // A dot in the id is literal, not a wildcard.
    expect(
      markerFor("capture.url").test("* @deprecated intake path `captureXurl`")
    ).toBe(false);
  });

  it("deprecated rows: file exists, names its symbol; this repo's carry the marker", () => {
    let checkedHere = 0;
    let checkedSiblings = 0;
    let skipped = 0;
    for (const p of DEPRECATED_INTAKE_PATHS) {
      const { repo, path, symbol } = parseWhere(p.where);
      const root = repoRoot(repo);
      if (!root) {
        // A sibling checkout absent from this environment: say so by count.
        expect(repo, p.id).not.toBe("synap-backend");
        skipped += 1;
        continue;
      }
      const file = resolve(root, path);
      expect(existsSync(file), `${p.id}: ${file}`).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text.includes(symbol), `${p.id}: symbol ${symbol}`).toBe(true);
      if (repo === "synap-backend") {
        expect(markerFor(p.id).test(text), `${p.id}: marker in ${path}`).toBe(
          true
        );
        // The marker says the agent path is kept, right where it stands.
        const at = text.search(markerFor(p.id));
        expect(text.slice(at, at + 700), `${p.id}: agent kept`).toMatch(
          /agent path[\s\S]*is[\s*]+kept — founder 2026-10-13/
        );
        checkedHere += 1;
      } else {
        checkedSiblings += 1;
      }
    }
    // Non-vacuity: every row in this repo is always checked (6 pod + the CLI
    // row, whose door into the pod is the hub-rest-client input type).
    expect(checkedHere).toBe(
      DEPRECATED_INTAKE_PATHS.filter((p) =>
        p.where.startsWith("synap-backend/")
      ).length
    );
    expect(checkedHere).toBeGreaterThanOrEqual(7);
    expect(checkedHere + checkedSiblings + skipped).toBe(
      DEPRECATED_INTAKE_PATHS.length
    );
  });

  it("kept agent doors point at real code in this repo", () => {
    for (const d of KEPT_AGENT_INTAKE_DOORS) {
      const { repo, path, symbol } = parseWhere(d.where);
      expect(repo, d.id).toBe("synap-backend");
      const file = resolve(BACKEND_ROOT, path);
      expect(existsSync(file), `${d.id}: ${file}`).toBe(true);
      expect(readFileSync(file, "utf8").includes(symbol), d.id).toBe(true);
    }
  });
});
