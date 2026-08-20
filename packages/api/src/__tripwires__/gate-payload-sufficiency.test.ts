/**
 * TRIPWIRE — a governed door's proposal must carry enough to be APPLIED.
 *
 * `governed-writes-have-approval-half.test.ts` answers a different question:
 * is an executor REGISTERED for this door. It cannot see whether the payload
 * that executor receives is sufficient, and its own header records the case
 * that proves the distinction — `playbook_run/update` had an executor while
 * storing only `{id}`, and that tripwire called the door wired.
 *
 * That blind spot is not theoretical. Ten doors were found storing a payload
 * too thin to ever replay:
 *   · `role/create` dropped `permissions` (required, non-defaultable) — an
 *     approved role granted nothing.
 *   · `widget/register` stored `rendererSourceLength`: the CHARACTER COUNT of
 *     agent-authored render code, never the code. A reviewer was asked to
 *     approve something they could not read, and approval could not have
 *     registered a widget even if they did.
 *   · six more stored a bare `{id}`.
 *
 * Widening them moved a number no gate could observe, which is precisely how
 * they would silently narrow again. This file is that observation: for each
 * door, the fields the direct-path writer consumes must appear inside the
 * `data: { … }` block of its own `checkPermissionOrPropose` call.
 *
 * Source-level static analysis, matching the style of the other tripwires here
 * (these call sites sit inside tRPC procedures with DB and auth context, so
 * reaching them at runtime would mean standing up the whole stack to assert a
 * property that is plainly visible in the text).
 *
 * If this fails: a payload was narrowed. Restore the field — do NOT relax the
 * expectation. If a field genuinely stopped being needed, delete its row here
 * and say why in the commit.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

interface DoorPin {
  /** Path under src/. */
  file: string;
  subjectType: string;
  action: string;
  /** Field names that must appear in the gate's `data: { … }` block. */
  fields: string[];
}

const DOORS: DoorPin[] = [
  {
    file: "routers/roles.ts",
    subjectType: "role",
    action: "create",
    // `permissions` is the load-bearing one — the whole point of a role.
    fields: ["name", "description", "workspaceId", "permissions", "filters"],
  },
  {
    file: "routers/roles.ts",
    subjectType: "role",
    action: "update",
    fields: ["name", "description", "permissions", "filters"],
  },
  {
    file: "routers/tools.ts",
    subjectType: "tool",
    action: "update",
    fields: ["name", "description", "config", "executor", "inputSchema"],
  },
  {
    file: "routers/relations.ts",
    subjectType: "relation",
    action: "update",
    // The only two fields `relationRepo.update` reads.
    fields: ["type", "metadata"],
  },
  {
    file: "routers/capability-containers.ts",
    subjectType: "capability",
    action: "create",
    // Losing `workspaceId` produced the documented "empty shell" capability.
    fields: ["description", "workspaceId"],
  },
  {
    file: "routers/hub-protocol/widget-definitions.ts",
    subjectType: "widget",
    action: "register",
    // `rendererSource` is THE field: the code itself, not its length.
    fields: ["rendererSource", "configSchema", "defaultConfig", "workspaceId"],
  },
  {
    file: "routers/hub-protocol/rest/artifacts.ts",
    subjectType: "artifact",
    action: "create",
    // `props` IS the artifact's content — without it approval creates an empty shell.
    fields: ["props", "cellKey", "workspaceId"],
  },
  {
    file: "routers/hub-protocol/rest/cell-instances.ts",
    subjectType: "cell",
    action: "update",
    fields: ["config", "workspaceId"],
  },
  {
    file: "routers/hub-protocol/rest/runs.ts",
    subjectType: "playbook_run",
    action: "update",
    fields: ["error", "producedEntityIds"],
  },
];

/**
 * The `data: { … }` block belonging to the `checkPermissionOrPropose` call that
 * declares this subjectType/action. Brace-matched rather than sliced to a fixed
 * character count — a magic length silently drifts past the call it pins as the
 * file grows, which has already produced one stale tripwire in this repo.
 */
function gatePayloadBlock(src: string, door: DoorPin): string | null {
  const actionAnchor = new RegExp(
    `subjectType:\\s*"${door.subjectType}"[\\s\\S]{0,400}?action:\\s*"${door.action}"`
  );
  const m = actionAnchor.exec(src);
  if (!m) return null;

  const dataIdx = src.indexOf("data: {", m.index);
  if (dataIdx === -1) return null;

  let depth = 0;
  const open = src.indexOf("{", dataIdx);
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null; // unbalanced — treat as not found, fail loudly below
}

describe("governed doors carry a payload sufficient to apply", () => {
  it(`is non-vacuous: pins ${DOORS.length} doors`, () => {
    expect(DOORS.length).toBeGreaterThanOrEqual(9);
  });

  for (const door of DOORS) {
    const key = `${door.subjectType}/${door.action}`;

    it(`${key} — gate payload is findable`, () => {
      const full = join(SRC, door.file);
      expect(existsSync(full), `${door.file} moved or was deleted`).toBe(true);
      const block = gatePayloadBlock(readFileSync(full, "utf8"), door);
      expect(
        block,
        `Could not locate the data: { … } block for ${key} in ${door.file}. ` +
          `Either the gate moved, or this pin's anchor is stale — fix the anchor, ` +
          `never delete the assertion.`
      ).not.toBeNull();
    });

    for (const field of door.fields) {
      it(`${key} — carries \`${field}\``, () => {
        const block = gatePayloadBlock(
          readFileSync(join(SRC, door.file), "utf8"),
          door
        )!;
        expect(
          block.includes(field),
          `${key} no longer stores \`${field}\`, so approving it cannot replay ` +
            `the write. Restore the field rather than relaxing this test.`
        ).toBe(true);
      });
    }
  }
});

/**
 * `widget/register` earns its own assertion: the ORIGINAL bug was not an absent
 * field but a MISLEADING one. `rendererSourceLength` looks like provenance and
 * reads like diligence, and it is the reason the thinness survived review.
 */
describe("widget/register never regresses to storing a length", () => {
  it("stores the renderer source, not its character count", () => {
    const src = readFileSync(
      join(SRC, "routers/hub-protocol/widget-definitions.ts"),
      "utf8"
    );
    const block = gatePayloadBlock(src, {
      file: "routers/hub-protocol/widget-definitions.ts",
      subjectType: "widget",
      action: "register",
      fields: [],
    })!;
    expect(block, "gate payload not found").toBeTruthy();
    expect(
      block.includes("rendererSourceLength"),
      "the gate is storing the LENGTH of the renderer code again — a reviewer " +
        "cannot approve code they cannot read, and approval cannot register a widget"
    ).toBe(false);
    expect(block.includes("rendererSource")).toBe(true);
  });
});
