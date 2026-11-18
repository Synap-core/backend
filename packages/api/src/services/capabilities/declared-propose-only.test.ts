/**
 * The AUTHORED propose-only declaration (`skills.metadata.proposeOnly`,
 * ticket 231020d4): a pack marks a verb that no auto grant and no auto rule
 * may run on its own (`hcloud_delete_server`). Same path as `readOnly`.
 *
 * WHAT THESE PIN, each against a plausible regression:
 *  - the applier projects the key and the drift comparator reads it: a
 *    proposeOnly-only difference is drift, and one apply converges it. Drop
 *    the key from `declaredMetadataKeys` and no installed pod ever receives
 *    the flag.
 *  - `proposeOnlyLoosened` fires on the loosening direction only, by value:
 *    adding the flag tightens and keeps the approval.
 *  - a verb declaring both `readOnly` and `proposeOnly` is not run as a read:
 *    the read-only short-circuit at the gate would otherwise skip the floor.
 *
 * NOT COVERED here: the gate itself (`capability-gate`'s
 * `declared-propose-only.test.ts`) and the reconcile hold
 * (`create-from-definition.reapply-keeps-approval.pglite.test.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  capabilityDefinitionDrift,
  projectSkillMetadata,
} from "./capability-drift.js";
import { proposeOnlyLoosened } from "./skill-exec-fields.js";
import { verbDeclaresReadOnly } from "./execute-capability.js";

describe("metadata.proposeOnly reaches installed pods", () => {
  const def = {
    name: "hcloud_delete_server",
    metadata: { proposeOnly: true },
  };
  const live = { name: "hcloud_delete_server", metadata: { runCount: 2 } };

  it("a proposeOnly-only difference is drift", () => {
    expect(capabilityDefinitionDrift([live], { skills: [def] }).drifted).toEqual(
      ["hcloud_delete_server"]
    );
  });

  it("the applier writes it, keeps DB-owned keys, and one apply converges", () => {
    const converged = projectSkillMetadata(live.metadata, def.metadata);
    expect(converged).toEqual({ runCount: 2, proposeOnly: true });
    expect(
      capabilityDefinitionDrift([{ ...live, metadata: converged }], {
        skills: [def],
      }).drifted
    ).toEqual([]);
  });

  it("a non-boolean declaration is never persisted", () => {
    expect(projectSkillMetadata(null, { proposeOnly: "true" })).toBeUndefined();
  });
});

describe("proposeOnlyLoosened — approval demotion, one direction, by value", () => {
  it("true → false DEMOTES (the verb could now run on its own)", () => {
    expect(
      proposeOnlyLoosened({ proposeOnly: false }, { proposeOnly: true })
    ).toBe(true);
  });

  it("absent/false → true does NOT demote: it tightens", () => {
    expect(proposeOnlyLoosened({ proposeOnly: true }, {})).toBe(false);
    expect(
      proposeOnlyLoosened({ proposeOnly: true }, { proposeOnly: false })
    ).toBe(false);
  });

  it("an unchanged re-send, or a patch without the key, is inert", () => {
    expect(
      proposeOnlyLoosened({ proposeOnly: true }, { proposeOnly: true })
    ).toBe(false);
    expect(proposeOnlyLoosened({ readOnly: false }, { proposeOnly: true })).toBe(
      false
    );
    expect(proposeOnlyLoosened(undefined, { proposeOnly: true })).toBe(false);
  });
});

describe("propose-only outranks a read-only declaration", () => {
  it("a verb declaring both is not run as a read", () => {
    expect(verbDeclaresReadOnly({ metadata: { readOnly: true } })).toBe(true);
    expect(
      verbDeclaresReadOnly({ metadata: { readOnly: true, proposeOnly: true } })
    ).toBe(false);
  });
});
