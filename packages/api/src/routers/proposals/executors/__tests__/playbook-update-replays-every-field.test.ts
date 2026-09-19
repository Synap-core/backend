/**
 * The `playbook/update` executor replays a hand-listed `REPLAYED` set. A field
 * `playbooks.update` accepts but the executor does not replay makes an APPROVED
 * update a silent no-op for that field — exactly how `criteria` would have gone
 * missing. The set checked here is DERIVED from `updateInputSchema`, so a new
 * field joins the scan by existing.
 *
 * Limitation (measured by reading, not a mutation): this pins the REPLAYED
 * literal's contents in source; it does not execute the executor.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateInputSchema } from "../../../playbooks.js";

/** Gate / attribution fields — not part of the playbook patch. */
const NOT_REPLAYED = new Set(["id", "agentUserId", "source", "reasoning"]);

describe("playbook/update executor replays every updatable field", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../playbook.ts"),
    "utf8"
  );
  const block = src.match(/const REPLAYED = \[([\s\S]*?)\] as const;/);

  it("can still see the REPLAYED literal (non-vacuity)", () => {
    expect(block).not.toBeNull();
    expect(block![1]).toContain('"goalTemplate"');
  });

  it("every updateInputSchema field is replayed", () => {
    const fields = Object.keys(updateInputSchema.shape).filter(
      (k) => !NOT_REPLAYED.has(k)
    );
    expect(fields.length).toBeGreaterThan(10);
    const missing = fields.filter((f) => !block![1].includes(`"${f}"`));
    expect(missing).toEqual([]);
  });
});
