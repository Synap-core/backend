/**
 * TRIPWIRE — a door whose behaviour an agent cannot GUESS must SAY so.
 *
 * `profiles.create` is slug-idempotent (routers/profiles.ts: "Profile slug
 * exists, returning existing"), so `synap_define_kind` re-called with an
 * existing slug ADDS the `properties[]` that are missing. That is the only way
 * to add a field to an existing kind — there is no add-property tool.
 *
 * The defect this pins: on 2026-09-22 an agent reported to the user that
 * adding a property to an existing kind is IMPOSSIBLE via MCP and requires the
 * browser — after that same agent had successfully added three fields to the
 * `question` kind the day before. The capability never changed; the
 * description had been compressed to the three words "Slug-idempotent for
 * fields", buried after a sentence opening "Define a NEW entity KIND". An
 * under-claiming description costs exactly as much as an over-claiming one:
 * the model complies with the text, not with the code.
 *
 * WHAT IS ASSERTED: `synap_define_kind`'s SHIPPED description states (a) that
 * re-calling with an existing slug is how fields are added, and (b) that the
 * field spec carries `constraints` and `overlay` — the two keys the 09-22
 * agent asked a human to configure by hand.
 *
 * WHAT IS READ: `mcp-tools.manifest.json`, the SHIPPED artifact — not the
 * source that generates it (`manifest-freshness.test.ts` covers that half).
 *
 * WHAT THIS CANNOT SEE: whether the sentence is TRUE. It pins that the claim is
 * present, not that `profiles.create` still behaves that way — the behaviour is
 * covered by the define-profile seam tests. If the door ever stops being
 * idempotent, delete this guard rather than the sentence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(
    join(__dirname, "../routers/mcp/tools/mcp-tools.manifest.json"),
    "utf8"
  )
) as { tools?: Array<{ name: string; description?: string }> };

describe("tripwire: an idempotent door states its idempotency", () => {
  const tools = manifest.tools ?? [];

  it("the manifest is non-empty and carries synap_define_kind", () => {
    // Non-vacuity: a renamed tool or an empty manifest must fail HERE, not
    // silently pass every assertion below.
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.map((t) => t.name)).toContain("synap_define_kind");
  });

  it("synap_define_kind says re-calling with an existing slug adds fields", () => {
    const d = tools.find((t) => t.name === "synap_define_kind")?.description;
    expect(d, "synap_define_kind has no description").toBeTruthy();
    expect(d!).toMatch(/idempotent/i);
    expect(d!).toMatch(/existing/i);
    // The actionable half: that this is how a field is ADDED.
    expect(d!).toMatch(/add/i);
  });

  it("synap_define_kind names the field-spec keys an agent asked a human for", () => {
    const d = tools.find((t) => t.name === "synap_define_kind")!.description!;
    // Enum constraints and the workspace-overlay flag: the two things the
    // 09-22 agent told the user to configure in the browser.
    expect(d).toContain("constraints");
    expect(d).toContain("overlay");
  });
});
