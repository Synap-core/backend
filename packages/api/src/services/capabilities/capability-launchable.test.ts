/**
 * X2 — a pack card says `run` ONLY when the execute door can launch one of its
 * verbs, judged by the SAME runnable projection `GET /capabilities/actions`
 * serves (`projectRunnableActions`), never a second rule.
 *
 * Live defects (2026-09-14, Builder workspace):
 *  - a `ready` card (every verb enabled) mapped straight to `{kind:"run"}`
 *    without asking the projection;
 *  - the projection emitted all 33 Synap Core verbs with NO `verbId`, so no
 *    door could match them to the catalog by name;
 *  - backing skills of tool verbs were ALSO emitted as standalone skill rows —
 *    15 duplicates, 5 of them Google verbs advertised runnable with the Google
 *    connection missing.
 *
 * These tests drive the real projection → `runnableVerbIdsByContainer` → the
 * real `capabilityNextAction`. Nothing downstream is hand-built. Fixture rows
 * are chosen where the old and new rules DISAGREE.
 */
import { describe, expect, it } from "vitest";
import type { Capability } from "@synap/playbooks";
import {
  projectRunnableActions,
  runnableVerbIdsByContainer,
} from "./action-projection.js";
import { capabilityNextAction } from "./capability-enable-link.js";

type Row = Capability & { containerId?: string | null; runnable?: boolean };

function skill(
  id: string,
  containerId: string | null,
  over: Partial<Row> = {}
): Row {
  return {
    kind: "skill",
    id: `sk-${id}`,
    name: id,
    description: null,
    inputSchema: {},
    executor: "is-agent",
    governance: "auto",
    containerId,
    runnable: true,
    ...over,
  } as Row;
}

function tool(
  id: string,
  containerId: string,
  verb: { id: string; backingSkillExecutable: boolean },
  over: Partial<Row> = {}
): Row {
  return {
    kind: "tool",
    id,
    name: id,
    description: null,
    inputSchema: {},
    executor: "provider",
    governance: "auto",
    containerId,
    verbs: [
      {
        id: verb.id,
        label: verb.id,
        kind: "read",
        granted: true,
        govDefault: "auto",
        effectiveExecMode: "auto",
        backingSkillExecutable: verb.backingSkillExecutable,
      } as NonNullable<Capability["verbs"]>[number],
    ],
    ...over,
  } as Row;
}

/** What the catalog does: launchable = some verb of the pack projected. */
const nextFor = (rows: Row[], containerId: string) =>
  capabilityNextAction(
    "ready",
    "Pack",
    undefined,
    containerId,
    (runnableVerbIdsByContainer(rows).get(containerId)?.size ?? 0) > 0
  );

describe("the projection carries a verbId for every runnable row", () => {
  it("a standalone skill row carries verbId = skill name AND its skillId", () => {
    const [row] = projectRunnableActions([skill("channel.create", "core")]);
    expect(row).toMatchObject({
      verbId: "channel.create",
      skillId: "sk-channel.create",
    });
  });

  it("a backing skill is governed by its tool verb: no duplicate row, and no row at all while the connection is missing", () => {
    const backing = skill("gmail_send", "google");
    const disconnected = tool(
      "google",
      "google",
      { id: "gmail_send", backingSkillExecutable: true },
      {
        kind: "source-provider",
        connection: { required: true, connected: false, provider: "google" },
      }
    );
    expect(projectRunnableActions([disconnected, backing])).toEqual([]);

    const connected = tool(
      "google",
      "google",
      { id: "gmail_send", backingSkillExecutable: true },
      {
        kind: "source-provider",
        connection: { required: true, connected: true, provider: "google" },
      }
    );
    const rows = projectRunnableActions([connected, backing]);
    expect(rows.map((r) => [r.verbId, r.tool])).toEqual([
      ["gmail_send", "google"],
    ]);
  });
});

describe("ready card nextAction is judged by the runnable projection", () => {
  it("a ready pack WITH a projected action row says run", () => {
    expect(nextFor([skill("channel.create", "core")], "core").kind).toBe("run");
  });

  it("a ready pack whose skills are unapproved (governance propose) has no row → none, not run", () => {
    const next = nextFor([skill("s1", "p1", { governance: "propose" })], "p1");
    expect(next.kind).toBe("none");
    expect(next.hint).toContain("none can be launched");
    // Still links to the card — the place a human can look into it.
    expect(next.url).toBeDefined();
  });

  it("a ready pack whose tool verb has no executable backing skill → none; flipping ONLY that field → run", () => {
    expect(
      nextFor(
        [tool("t1", "p2", { id: "v1", backingSkillExecutable: false })],
        "p2"
      ).kind
    ).toBe("none");
    expect(
      nextFor(
        [tool("t1", "p2", { id: "v1", backingSkillExecutable: true })],
        "p2"
      ).kind
    ).toBe("run");
  });

  it("an inactive skill (runnable:false) and a catalog-only brick do not make a pack launchable", () => {
    const rows = [
      skill("s-inactive", "p3", { runnable: false }),
      skill("s-catalog", "p3", { catalogOnly: true }),
    ];
    expect(nextFor(rows, "p3").kind).toBe("none");
  });

  it("rows are attributed per container — another pack's runnable row never lends run", () => {
    const rows = [
      skill("good", "other"),
      skill("bad", "p4", { governance: "propose" }),
    ];
    expect([...runnableVerbIdsByContainer(rows).keys()]).toEqual(["other"]);
    expect(nextFor(rows, "p4").kind).toBe("none");
  });

  it("unmeasured launchability (undefined) keeps the status mapping — never guessed false", () => {
    expect(capabilityNextAction("ready", "Pack", undefined, "c").kind).toBe(
      "run"
    );
  });

  it("only `ready` is gated — partial/draft still ask to enable", () => {
    expect(
      capabilityNextAction("partial", "Pack", undefined, "c", false).kind
    ).toBe("enable");
  });
});
