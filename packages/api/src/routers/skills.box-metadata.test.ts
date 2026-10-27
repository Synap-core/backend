import { describe, it, expect } from "vitest";

/**
 * A box skill is never `readOnly`: the gate auto-runs a declared reader once
 * approved, and "read-only" means nothing for a script with packages and
 * network. `boxSkillMetadata` (create) and `assertBoxNotReadOnly` (update)
 * refuse it in words; a non-box skill keeps its declaration.
 */

import { assertBoxNotReadOnly, boxSkillMetadata } from "./skills.js";

const box = { language: "python", packages: [], hosts: [] };

describe("a box skill cannot be read-only", () => {
  it("create refuses readOnly: true on a box skill", () => {
    expect(() =>
      boxSkillMetadata({
        executionMode: "box",
        kind: "code",
        metadata: { box, readOnly: true },
      })
    ).toThrow(/cannot be read-only/);
  });

  it("an explicit readOnly: false is fine, and the declaration is normalised", () => {
    const out = boxSkillMetadata({
      executionMode: "box",
      kind: "code",
      metadata: { box, readOnly: false },
    });
    expect(out).toMatchObject({
      readOnly: false,
      box: { entrypoint: "main.py" },
    });
  });

  it("a non-box skill keeps its readOnly declaration", () => {
    expect(
      boxSkillMetadata({
        executionMode: "sync",
        kind: "code",
        metadata: { readOnly: true },
      })
    ).toEqual({ readOnly: true });
  });

  it("an update patch making a box skill read-only is refused", () => {
    expect(() => assertBoxNotReadOnly({ readOnly: true })).toThrow(
      /cannot be read-only/
    );
    expect(() => assertBoxNotReadOnly(undefined)).not.toThrow();
    expect(() => assertBoxNotReadOnly({ description: "x" })).not.toThrow();
  });
});
