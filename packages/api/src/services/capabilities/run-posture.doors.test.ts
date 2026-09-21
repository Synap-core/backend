import { describe, expect, it } from "vitest";
import type { CapabilityVerbState } from "@synap/playbooks";

import {
  projectRunnableActions,
  runPostureByContainer,
  type ProjectableCapability,
} from "./action-projection.js";
import { sectionCapabilities } from "./capability-registry.js";
import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";
import { capabilityRowPosture, catalogVerbPosture } from "./run-posture.js";

/**
 * `governance` on every capability door — the flat registry rows, the MCP
 * synap_list_capabilities sections, GET /capabilities/actions, the pack catalog
 * card — is the RUN POSTURE an agent meets at the gate, equal to the gate's
 * verdict; `enabled` is the approval gate. Live 2026-09-14 the actions door
 * labeled all 42 actions `auto` (entity.delete and messaging.send included)
 * because it projected approval.
 *
 * Every fixture row sets `governance: "none"` on purpose: no projection may read
 * a row's label to decide anything — approval comes from `enabled`.
 */

type Kind = "read" | "write" | "action";
type Mode = "auto" | "propose" | "dry-run";

function builtinSkill(
  name: string,
  containerId?: string,
  enabled = true
): ProjectableCapability {
  return {
    kind: "skill",
    id: `skill-${name}`,
    name,
    inputSchema: {},
    executor: "is-agent",
    governance: "none",
    enabled,
    skillKind: "builtin",
    skillMetadata: null,
    ...(containerId ? { containerId } : {}),
  } as ProjectableCapability;
}

function toolVerb(
  id: string,
  kind: Kind,
  granted: boolean,
  execMode: Mode
): CapabilityVerbState {
  return {
    id,
    label: id,
    kind,
    // An UNGRANTED verb's effective mode falls back to govDefault (`auto` here)
    // — exactly the value that used to read as "runs now".
    govDefault: "auto",
    granted,
    effectiveExecMode: granted ? execMode : "auto",
    backingSkillExecutable: true,
  } as CapabilityVerbState;
}

function toolRow(
  kind: "source-provider" | "builtin-tool",
  name: string,
  verbs: CapabilityVerbState[],
  containerId: string
): ProjectableCapability {
  return {
    kind,
    id: `tool-${name}`,
    name,
    inputSchema: {},
    executor: kind === "builtin-tool" ? "builtin" : "provider",
    governance: "none",
    enabled: true,
    verbs,
    ...(kind === "source-provider"
      ? { connection: { required: true, connected: true, provider: "gmail" } }
      : {}),
    containerId,
  } as unknown as ProjectableCapability;
}

/**
 * The ORACLE — transcribed from the gate source, NOT from `runPosture`, for an
 * agent caller past the approval gate:
 *   - `execute-capability.ts` sets `readOnly` iff the skill is builtin AND in
 *     READ_ONLY_BUILTIN_VERBS; `gateCapabilityExecution` returns `run` for it
 *     before any grant rung;
 *   - otherwise no active grant → the no-grant rung proposes; a grant → policy
 *     rung 2.7: mode `auto` executes (a write included), anything else proposes
 *     (`dry-run` short-circuits to a preview, never "runs now").
 * It proves the doors agree with THIS model; it cannot see a gate rung added
 * later — a sameness proof, not correctness.
 */
function gateVerdict(v: {
  builtin: boolean;
  verbId: string;
  granted?: boolean;
  execMode?: string;
}): "auto" | "propose" {
  if (v.builtin && READ_ONLY_BUILTIN_VERBS.has(v.verbId)) return "auto";
  if (v.granted !== true) return "propose";
  return v.execMode === "auto" ? "auto" : "propose";
}

describe("run posture — behavioural, every door", () => {
  const registry = [
    builtinSkill("entity.query"),
    builtinSkill("entity.delete"),
    builtinSkill("entity.update", undefined, false), // disabled: never an action
    toolRow(
      "source-provider",
      "Mail",
      [
        toolVerb("mail_search", "read", true, "auto"),
        toolVerb("mail_list_ungranted", "read", false, "auto"),
        toolVerb("mail_read_propose", "read", true, "propose"),
        // The discriminating rows: a write/action under an ACTIVE auto grant RUNS.
        toolVerb("mail_create_draft", "write", true, "auto"),
        toolVerb("mail_send", "action", true, "auto"),
        toolVerb("mail_send_ungranted", "action", false, "auto"),
      ],
      "container-mail"
    ),
  ];

  it("actions door: builtin read auto+kind read, builtin write propose+kind write, tool postures equal the grant", () => {
    const byVerb = new Map(
      projectRunnableActions(registry).map((a) => [a.verbId, a])
    );
    expect(byVerb.get("entity.query")).toMatchObject({
      governance: "auto",
      enabled: true,
      kind: "read",
    });
    expect(byVerb.get("entity.delete")).toMatchObject({
      governance: "propose",
      enabled: true,
      kind: "write",
    });
    expect(byVerb.has("entity.update")).toBe(false);
    expect(byVerb.get("mail_search")?.governance).toBe("auto");
    expect(byVerb.get("mail_list_ungranted")?.governance).toBe("propose");
    expect(byVerb.get("mail_read_propose")?.governance).toBe("propose");
    expect(byVerb.get("mail_create_draft")?.governance).toBe("auto");
    expect(byVerb.get("mail_send")?.governance).toBe("auto");
    expect(byVerb.get("mail_send_ungranted")?.governance).toBe("propose");
  });

  it("MCP sections: skill rows carry posture + a separate enabled; verbs carry their own posture", () => {
    const s = sectionCapabilities(registry as never);
    const skill = new Map(s.skills.map((r) => [r.name, r]));
    expect(skill.get("entity.query")).toMatchObject({
      governance: "auto",
      enabled: true,
    });
    expect(skill.get("entity.delete")).toMatchObject({
      governance: "propose",
      enabled: true,
    });
    expect(skill.get("entity.update")?.enabled).toBe(false);
    const [mail] = s.integrations;
    expect(mail.enabled).toBe(true);
    expect(mail.governance).toBe("propose"); // not every verb runs now
    expect(
      Object.fromEntries(mail.verbs.map((v) => [v.id, v.governance]))
    ).toEqual({
      mail_search: "auto",
      mail_list_ungranted: "propose",
      mail_read_propose: "propose",
      mail_create_draft: "auto",
      mail_send: "auto",
      mail_send_ungranted: "propose",
    });
  });

  it("flat registry row: skill rows by the builtin set, a tool row auto only when every verb is, none for nothing runnable", () => {
    expect(capabilityRowPosture(registry[0])).toBe("auto");
    expect(capabilityRowPosture(registry[1])).toBe("propose");
    expect(capabilityRowPosture(registry[3])).toBe("propose");
    expect(
      capabilityRowPosture(
        toolRow(
          "source-provider",
          "Granted",
          [toolVerb("g_send", "action", true, "auto")],
          "c"
        )
      )
    ).toBe("auto");
    expect(capabilityRowPosture({ kind: "teaching-doc", name: "x" })).toBe(
      "none"
    );
    expect(
      capabilityRowPosture({
        kind: "builtin-tool",
        name: "x",
        catalogOnly: true,
      })
    ).toBe("none");
    expect(capabilityRowPosture({ kind: "tool", name: "x", verbs: [] })).toBe(
      "none"
    );
    expect(capabilityRowPosture({ kind: "command", name: "x" })).toBe(
      "propose"
    );
  });

  it("catalog card: under a lens the card label is the projection's", () => {
    const postures = runPostureByContainer(registry).get("container-mail");
    const label = (name: string) =>
      catalogVerbPosture({ name, kind: "declarative" }, postures?.get(name));
    expect(label("mail_search")).toBe("auto");
    expect(label("mail_list_ungranted")).toBe("propose");
    expect(label("mail_read_propose")).toBe("propose");
    expect(label("mail_send")).toBe("auto");
    // No lens / not launchable: the grant is unmeasured → never `auto` for a
    // non-builtin, still exact for a builtin.
    expect(
      catalogVerbPosture({ name: "exa_search", kind: "declarative" }, undefined)
    ).toBe("propose");
    expect(
      catalogVerbPosture({ name: "entity.query", kind: "builtin" }, undefined)
    ).toBe("auto");
    expect(
      catalogVerbPosture({ name: "entity.delete", kind: "builtin" }, undefined)
    ).toBe("propose");
  });
});

describe("tripwire — every door's label equals the gate verdict over a derived verb set", () => {
  // DERIVED: every builtin the pod registers (a new builtin joins by existing),
  // once as a skill-only row and once as a builtin-tool verb under each grant
  // shape, plus the full tool-verb matrix kind × granted × exec mode.
  const allBuiltins = Object.keys(BUILTIN_VERBS);
  const kinds: Kind[] = ["read", "write", "action"];
  const modes: Mode[] = ["auto", "propose", "dry-run"];
  const toolCases = kinds.flatMap((kind) =>
    [true, false].flatMap((granted) =>
      modes.map((mode) => ({
        verbId: `t_${kind}_${granted ? "granted" : "ungranted"}_${mode}`,
        kind,
        granted,
        mode,
      }))
    )
  );
  const coreGrants = [
    { tag: "g_auto", granted: true, mode: "auto" as Mode },
    { tag: "g_propose", granted: true, mode: "propose" as Mode },
    { tag: "ungranted", granted: false, mode: "auto" as Mode },
  ];
  const registry: ProjectableCapability[] = [
    ...allBuiltins.map((n) => builtinSkill(n, "container-core")),
    toolRow(
      "source-provider",
      "Mail",
      toolCases.map((c) => toolVerb(c.verbId, c.kind, c.granted, c.mode)),
      "container-mail"
    ),
    ...coreGrants.map((g) =>
      toolRow(
        "builtin-tool",
        `core-${g.tag}`,
        allBuiltins.map((n) => toolVerb(n, "write", g.granted, g.mode)),
        `container-core-${g.tag}`
      )
    ),
  ];
  const toolExpect = new Map(
    toolCases.map((c) => [
      c.verbId,
      gateVerdict({
        builtin: false,
        verbId: c.verbId,
        granted: c.granted,
        execMode: c.granted ? c.mode : "auto",
      }),
    ])
  );
  const skillExpect = (verbId: string) =>
    gateVerdict({ builtin: true, verbId });
  const coreExpect = (verbId: string, g: (typeof coreGrants)[number]) =>
    gateVerdict({
      builtin: true,
      verbId,
      granted: g.granted,
      execMode: g.granted ? g.mode : "auto",
    });

  it("non-vacuity: real reads + writes, every tool case, both verdicts, and the discriminating rows", () => {
    const reads = allBuiltins.filter((v) => READ_ONLY_BUILTIN_VERBS.has(v));
    const writes = allBuiltins.filter((v) => !READ_ONLY_BUILTIN_VERBS.has(v));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    expect(writes.length).toBeGreaterThanOrEqual(10);
    expect(writes).toEqual(
      expect.arrayContaining(["entity.delete", "messaging.send"])
    );
    expect(reads).toContain("entity.query");
    expect(toolCases).toHaveLength(18);
    // The rows the pass-1 rule (write → propose) got wrong, and the unsafe
    // pass-0 rule (govDefault auto → auto) got wrong. Both must be present.
    expect(toolExpect.get("t_write_granted_auto")).toBe("auto");
    expect(toolExpect.get("t_action_granted_auto")).toBe("auto");
    expect(toolExpect.get("t_read_ungranted_auto")).toBe("propose");
    expect(coreExpect("messaging.send", coreGrants[0])).toBe("auto");
    expect(new Set(toolExpect.values())).toEqual(new Set(["auto", "propose"]));
  });

  it("actions door", () => {
    const actions = projectRunnableActions(registry);
    // skill-only builtins are shadowed by the builtin-tool verbs of the same id
    // (a backing skill never doubles as an action) — so: tool cases + 3 grant
    // shapes × every builtin.
    expect(actions).toHaveLength(toolCases.length + 3 * allBuiltins.length);
    const wrong: string[] = [];
    for (const a of actions) {
      const g = coreGrants.find((c) => a.tool === `core-${c.tag}`);
      const want = g ? coreExpect(a.verbId!, g) : toolExpect.get(a.verbId!)!;
      if (a.governance !== want)
        wrong.push(`${a.tool}:${a.verbId}:${a.governance}`);
    }
    expect(wrong).toEqual([]);
  });

  it("MCP sections (skill rows + integration verbs + builtin verbs)", () => {
    const s = sectionCapabilities(registry as never);
    const wrong: string[] = [];
    let seen = 0;
    for (const r of s.skills) {
      seen++;
      if (r.governance !== skillExpect(r.name)) wrong.push(`skill:${r.name}`);
    }
    for (const i of s.integrations)
      for (const v of i.verbs) {
        seen++;
        if (v.governance !== toolExpect.get(v.id)) wrong.push(`int:${v.id}`);
      }
    for (const b of s.builtins) {
      const g = coreGrants.find((c) => b.name === `core-${c.tag}`)!;
      for (const v of b.verbs) {
        seen++;
        if (v.governance !== coreExpect(v.id, g))
          wrong.push(`${b.name}:${v.id}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(
      toolCases.length + 3 * allBuiltins.length
    );
    expect(wrong).toEqual([]);
  });

  it("flat registry rows — the seam that stamps them (assembleRegistryRows) — fold the per-verb verdicts", async () => {
    const { assembleRegistryRows } = await import("./capability-registry.js");
    const rows = assembleRegistryRows({
      builtinCaps: [],
      toolCaps: registry.filter((r) => r.kind !== "skill"),
      skillCaps: registry.filter((r) => r.kind === "skill"),
      commandCaps: [],
    });
    const wrong: string[] = [];
    for (const row of rows) {
      const want =
        row.kind === "skill"
          ? skillExpect(row.name)
          : (row.verbs ?? []).every((v) => {
                const g = coreGrants.find((c) => row.name === `core-${c.tag}`);
                return (
                  (g ? coreExpect(v.id, g) : toolExpect.get(v.id)) === "auto"
                );
              })
            ? "auto"
            : "propose";
      if (row.governance !== want) wrong.push(row.name);
    }
    expect(rows.length).toBe(allBuiltins.length + 4);
    expect(wrong).toEqual([]);

    // Kinds with no approval column: the gate's approval step never refuses
    // them, and nothing (IS-native) or no known grant (command) runs now.
    // Order is builtin → tool → skill → command.
    const [isNative, doc, command] = assembleRegistryRows({
      builtinCaps: [
        {
          kind: "builtin-tool",
          id: "is-native:web_search",
          name: "web_search",
          inputSchema: {},
          executor: "is-agent",
          governance: "none",
          catalogOnly: true,
        },
      ],
      toolCaps: [],
      skillCaps: [
        {
          kind: "teaching-doc",
          id: "doc",
          name: "how-to",
          inputSchema: {},
          executor: "is-agent",
          governance: "none",
          enabled: true,
        },
      ],
      commandCaps: [
        {
          kind: "command",
          id: "cmd",
          name: "digest",
          inputSchema: {},
          executor: "is-agent",
          governance: "none",
        },
      ],
    });
    expect(isNative).toMatchObject({ enabled: true, governance: "none" });
    expect(doc).toMatchObject({ governance: "none" });
    expect(command).toMatchObject({ enabled: true, governance: "propose" });
  });

  it("pack catalog card (lens posture through catalogVerbPosture)", () => {
    const byContainer = runPostureByContainer(registry);
    const wrong: string[] = [];
    for (const c of toolCases) {
      const got = catalogVerbPosture(
        { name: c.verbId, kind: "declarative" },
        byContainer.get("container-mail")?.get(c.verbId)
      );
      if (got !== toolExpect.get(c.verbId)) wrong.push(c.verbId);
    }
    for (const g of coreGrants)
      for (const n of allBuiltins) {
        const got = catalogVerbPosture(
          { name: n, kind: "builtin" },
          byContainer.get(`container-core-${g.tag}`)?.get(n)
        );
        if (got !== coreExpect(n, g)) wrong.push(`${g.tag}:${n}`);
      }
    expect(byContainer.get("container-mail")?.size).toBe(toolCases.length);
    expect(wrong).toEqual([]);
  });
});

/**
 * THE AUTHORED READ-ONLY DECLARATION REACHES EVERY DOOR.
 *
 * THE DEFECT THIS PINS, observed LIVE on 2026-09-21. The capability gate was
 * taught to short-circuit to `run` for any verb whose backing skill declares
 * `metadata.readOnly` — but this module, whose own docblock says it is
 * "transcribed from `gateCapabilityExecution`", was not. So `exa_search` kept
 * reporting `governance: "propose"` on `synap_list_capabilities` while the gate
 * would have RUN it. A door that says one thing while the gate does another is
 * the exact drift this file exists to prevent; it was the THIRD stale
 * transcription from the same change.
 *
 * WHAT THIS DOES NOT COVER, measured: these drive the three PURE posture
 * functions and the actions projection. They do NOT prove `listCapabilities`
 * populates `declaredReadOnly` from the `skills.metadata` column — that join
 * needs a DB and is covered by the projection-parity tripwire plus the fact
 * that removing the map from `buildVerbStates` fails typecheck at the call site.
 */
describe("the authored readOnly declaration is honoured by every door", () => {
  const declaringVerb = (declaredReadOnly?: boolean) =>
    ({
      id: "exa_search",
      label: "Search",
      kind: "read",
      granted: false, // no grant: the ONLY thing that can flip this is the declaration
      effectiveExecMode: "propose",
      backingSkillExecutable: true,
      ...(declaredReadOnly === undefined ? {} : { declaredReadOnly }),
    }) as unknown as CapabilityVerbState;

  const exaTool = (declaredReadOnly?: boolean) =>
    ({
      kind: "tool",
      id: "tool-exa",
      name: "exa",
      inputSchema: {},
      executor: "is-agent",
      governance: "none",
      enabled: true,
      verbs: [declaringVerb(declaredReadOnly)],
    }) as unknown as ProjectableCapability;

  it("NON-VACUITY: without the declaration this verb proposes", () => {
    // If this ever reads `auto`, every assertion below is satisfied by
    // something other than the declaration and proves nothing.
    expect(projectRunnableActions([exaTool(undefined)])[0]?.governance).toBe(
      "propose"
    );
    expect(capabilityRowPosture(exaTool(undefined) as never)).toBe("propose");
  });

  it("GET /capabilities/actions labels a declared read `auto`", () => {
    const actions = projectRunnableActions([exaTool(true)]);
    expect(actions).toHaveLength(1);
    expect(
      actions[0]?.governance,
      "the actions door still proposes a verb the gate will run"
    ).toBe("auto");
  });

  it("the flat registry row labels a declared read `auto`", () => {
    expect(capabilityRowPosture(exaTool(true) as never)).toBe("auto");
  });

  it("a declared `false` is NOT a declaration of auto", () => {
    // The value gates auto-execution: only an explicit `true` may widen it.
    expect(projectRunnableActions([exaTool(false)])[0]?.governance).toBe(
      "propose"
    );
  });

  it("a skill-only row reads the declaration off its own metadata bag", () => {
    const skillRow = (metadata: Record<string, unknown> | null) =>
      ({
        kind: "skill",
        id: "skill-exa_search",
        name: "exa_search",
        inputSchema: {},
        executor: "is-agent",
        governance: "none",
        enabled: true,
        skillKind: "code",
        skillMetadata: metadata,
      }) as unknown as ProjectableCapability;

    expect(capabilityRowPosture(skillRow(null) as never)).toBe("propose");
    expect(capabilityRowPosture(skillRow({ readOnly: true }) as never)).toBe(
      "auto"
    );
    // A truthy STRING must not widen it — same contract as `declaredReadOnly`.
    expect(capabilityRowPosture(skillRow({ readOnly: "false" }) as never)).toBe(
      "propose"
    );
    expect(
      projectRunnableActions([skillRow({ readOnly: true })])[0]?.governance
    ).toBe("auto");
  });

  it("sectionCapabilities (MCP synap_list_capabilities) honours it too", () => {
    const sectioned = sectionCapabilities([
      {
        kind: "skill",
        id: "skill-exa_search",
        name: "exa_search",
        inputSchema: {},
        executor: "is-agent",
        governance: "none",
        enabled: true,
        runnable: true,
        skillKind: "code",
        skillMetadata: { readOnly: true },
      },
    ] as never);
    const skill = sectioned.skills?.find((s) => s.name === "exa_search");
    expect(
      skill,
      "the MCP section dropped the row — the scan is broken"
    ).toBeDefined();
    expect(skill?.governance).toBe("auto");
  });
});
