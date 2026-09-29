/**
 * A `playbook/update` proposal names its template.
 *
 * `playbooks.update` files the WHOLE patch but carries `name` only when it
 * renames, so a steps/settings edit reached `buildProposalSummary` with no
 * target name and was stored as "Update Template". `resolveProposalTargetName`
 * now reads the playbook's own name by id — the same seam the entity and
 * session branches use — and the summary goes through the ONE title door
 * (`buildObjectActionTitle`, inside `buildProposalSummary`).
 *
 * `@synap/database` is partially stubbed: only `db.select(...)` answers, with
 * the playbook row keyed by the table it was asked about.
 */
import { describe, expect, it, vi } from "vitest";

const PLAYBOOK_ID = "0b8f5d2e-4c1a-4f7e-9a3b-2d6c8e1f0a55";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () =>
              table === schema.playbooks
                ? [{ name: "Business Model (GRP)" }]
                : [],
          }),
        }),
      }),
    },
  };
});

import {
  buildProposalSummary,
  resolveProposalTargetName,
} from "./permission-check.js";

describe("playbook update proposals name the playbook", () => {
  it("resolves the name from the playbook row when the patch carries none", async () => {
    const targetName = await resolveProposalTargetName(
      "playbook",
      PLAYBOOK_ID,
      { id: PLAYBOOK_ID, steps: [] }
    );
    expect(targetName).toBe("Business Model (GRP)");
    expect(
      buildProposalSummary("playbook", "update", {
        id: PLAYBOOK_ID,
        steps: [],
        targetName,
      })
    ).toBe('Update Template "Business Model (GRP)"');
  });

  it("a rename still titles with the name the patch carries", async () => {
    await expect(
      resolveProposalTargetName("playbook", PLAYBOOK_ID, {
        id: PLAYBOOK_ID,
        name: "GRP v2",
      })
    ).resolves.toBe("GRP v2");
  });
});
