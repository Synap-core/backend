/**
 * TRIPWIRE — `capture.execute` links the file `capture.structure` already kept
 * for the run instead of uploading a second copy (decision C, 2026-09-13).
 *
 * The doors are proven on their own: `findRunStagedSource` on PGlite
 * (`known-source-hashes.pglite.test.ts`), `gateAndAttachStagedSourceBlob` +
 * the intake-source discard guard in `utils/__tests__/store-entity-source-blob.test.ts`.
 * What those cannot see is whether the PROCEDURE still uses them on BOTH of
 * its file branches — execute needs governance, materialize and search to run
 * end to end, so this reads its source.
 *
 * Cannot see: the order of the upload fallback relative to a failed lookup
 * beyond the literal shapes below, or a third file branch added elsewhere.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../../routers/capture.ts"), "utf8");

function executeSlice(): string {
  const start = SRC.indexOf("  execute: podProcedure");
  const end = SRC.indexOf("  executeWithSchema: podProcedure", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("capture.execute reuses the run's staged source", () => {
  const slice = executeSlice();
  const flat = slice.replace(/\s+/g, " ");

  it("resolves the run source once, through the one owner/run-floored reader", () => {
    expect(slice.match(/await findRunStagedSource\(/g)).toHaveLength(1);
    expect(flat).toMatch(/sessionId: runSessionId,/);
  });

  it("the GOVERNED branch stages a new blob only when the run holds none", () => {
    expect(flat).toContain(
      "let stagedCaptureFile: StagedSourceBlob | undefined = attachRunSource ?? undefined; if (!stagedCaptureFile && input.keepRaw && input.file) {"
    );
  });

  it("the DIRECT branch links the run source, and uploads only as the fallback", () => {
    expect(flat).toContain(
      "if ((input.keepRaw && input.file) || attachRunSource) {"
    );
    expect(flat).toMatch(
      /const stored = attachRunSource \? \/\/ [^\n]*? await gateAndAttachStagedSourceBlob\(\{[^}]*staged: attachRunSource,[\s\S]*?\}\) : await storeEntitySourceBlob\(\{/
    );
  });

  it("ABSENT keepRaw still links the run source (hub/MCP omit it); only an explicit false withholds", () => {
    // The documented contract on the execute input: a run that already holds
    // the file's original bytes costs no upload, so omitting keepRaw links it.
    // Cannot see: a caller-side default that sends `keepRaw: false`.
    expect(flat).toMatch(
      /if \( runSessionId && input\.keepRaw !== false && \(input\.sourceDocumentId \|\| input\.sourceSha256 \|\| input\.file\) \) \{/
    );
    expect(flat).not.toMatch(
      /input\.keepRaw === true && \(input\.sourceDocumentId/
    );
  });

  it("non-vacuity: the slice still contains both file branches", () => {
    expect(slice).toContain("stageSourceBlob({");
    expect(slice).toContain("storeEntitySourceBlob({");
  });
});
