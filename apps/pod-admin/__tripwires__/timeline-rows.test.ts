import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * One timeline row (founder, 18 Nov 2026): wherever pod admin lists a history
 * or an audit chain, the row is `TimelineList`, fed by entries derived through
 * `entryOf` / `groupEntries` (`@synap-core/types/work-view`). Fails when such
 * a page (1) stops drawing through `TimelineList`, (2) draws its own row
 * (`ResourceRow`, a hand `<li>` of events), or (3) the shared module stops
 * deriving through the work-view door.
 *
 * The scanned set is DERIVED, not listed: every file under `app/` that reads
 * the audit log (`listAuditLogs`) or defines Historique's list
 * (`export function HistoryList`). A new page that reads the audit log joins
 * the set by doing so.
 */

const APP = join(fileURLToPath(new URL(".", import.meta.url)), "..", "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const src = (p: string) => stripComments(readFileSync(p, "utf8"), "ts");
const files = walk(APP);
const TIMELINE_PAGES = files.filter((f) => {
  const s = src(f);
  return (
    /listAuditLogs\.use/.test(s) || /export function HistoryList\b/.test(s)
  );
});

describe("history and audit rows are the shared timeline row", () => {
  it("the derived set is not empty (reachability)", () => {
    expect(TIMELINE_PAGES.length).toBeGreaterThanOrEqual(2);
  });

  for (const f of TIMELINE_PAGES) {
    const rel = f.slice(APP.length + 1);
    const s = src(f);
    it(`${rel} draws through TimelineList`, () => {
      expect(s).toMatch(/<TimelineList\b/);
    });
    it(`${rel} draws no row of its own`, () => {
      expect(s).not.toMatch(/<ResourceRow\b/);
      expect(s).not.toMatch(/function (Activity|History)Row(View)?\b/);
    });
  }

  it("the shared module derives through the work-view door", () => {
    const model = src(join(APP, "_lib/timeline/timeline-model.ts"));
    expect(model).toMatch(/entryOf/);
    expect(model).toMatch(/groupEntries/);
    expect(model).toMatch(/from "@synap-core\/types\/work-view"/);
    expect(src(join(APP, "_lib/timeline/timeline-list.tsx"))).toMatch(
      /dayGroups/
    );
  });
});
