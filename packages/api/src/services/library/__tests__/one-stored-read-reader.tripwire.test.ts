/**
 * TRIPWIRE — the stored Library shape is READ through one door.
 *
 * `documents.metadata.importItem` / `importRead` is the contract between the
 * pod, the sweep, Build and every client. Hand-parsing it at a call site
 * (`(metadata as …).importRead as …`) is how `storedReadTextKey` and
 * `awaitsLightRead` came to disagree with `isFinal` about what "not read"
 * means (Q1 MAJOR 1). The readers are `libraryItemOf` / `libraryItemUrl` /
 * `readLibraryItemRead` / `readLibraryItemMedia` (`@synap-core/types/imports`)
 * and, for the pod's bookkeeping, `readStoredLibraryRead`
 * (`light-read-store.ts`, the one file allowed to touch the bag — it holds
 * the reader and the writers).
 *
 * Scans every non-test `.ts` under `api/src` (DERIVED, so a new file joins by
 * existing) for a JS property access `.importItem` / `.importRead` (and the
 * bracket form). NOT seen: SQL strings (`'{importRead,status}'`,
 * `? 'importItem'` — queries, not parses), names that merely start with the
 * word (`importItemsWhere`, `importReadLease`…), and a parse that goes
 * through a computed key held in a variable (`meta[KEY]`).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ALLOWED = new Set(["services/library/light-read-store.ts"]);
const ACCESS =
  /(?:\.\s*import(?:Item|Read)\b|\[\s*["'`]import(?:Item|Read)["'`]\s*\])/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Lines that read the bag as a JS property (comments skipped). */
function hits(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => ACCESS.test(l));
}

describe("the stored Library shape has ONE reader", () => {
  const files = walk(SRC);

  it("no file outside the reader reads `.importItem` / `.importRead` itself", () => {
    const offenders = files
      .map((f) => ({
        file: relative(SRC, f),
        lines: hits(readFileSync(f, "utf8")),
      }))
      .filter((h) => h.lines.length > 0 && !ALLOWED.has(h.file));
    expect(offenders).toEqual([]);
  });

  it("non-vacuous: the scan sees the source tree and can still see a parse", () => {
    expect(files.length).toBeGreaterThan(500);
    const reader = files.find((f) => relative(SRC, f) === [...ALLOWED][0]);
    expect(reader, "the allowed reader file moved").toBeDefined();
    expect(hits(readFileSync(reader!, "utf8")).length).toBeGreaterThan(0);
    expect(hits("const r = (m as any).importRead as X;")).toHaveLength(1);
    expect(hits('const r = meta["importItem"];')).toHaveLength(1);
    expect(hits("drizzleSql`${m} #>> '{importRead,status}'`")).toHaveLength(0);
    expect(hits("importItemsWhere(userId)")).toHaveLength(0);
  });
});
