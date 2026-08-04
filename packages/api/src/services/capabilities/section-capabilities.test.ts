import { describe, it, expect } from "vitest";
import { sectionCapabilities } from "./capability-registry.js";
import type { Capability, CapabilityVerbState } from "@synap/playbooks";

/**
 * `sectionCapabilities` is the agent-facing projection: it de-duplicates the
 * management read-model's repeated rows, nests verbs under their integration,
 * and never lists a provider's backing skill twice.
 *
 * Built-ins are SECTIONED, not dropped — a built-in is a brick, so it must stay
 * browsable even where it is not pickable; each row carries `runnableHere` so a
 * picker filters on a fact rather than on the section's name. Only teaching
 * prose is still folded out, and it is COUNTED: the point of `excluded` is that
 * the catalogue states what it does not show instead of hiding it silently.
 */

function verb(id: string, granted = false): CapabilityVerbState {
  return {
    id,
    name: id,
    kind: "action",
    granted,
    effectiveExecMode: "propose",
  } as unknown as CapabilityVerbState;
}

function cap(
  partial: Partial<Capability> & { kind: Capability["kind"]; name: string }
): Capability {
  return {
    id: partial.id ?? `id-${partial.name}`,
    inputSchema: {},
    executor: "is-agent",
    governance: "propose",
    ...partial,
  } as Capability;
}

describe("sectionCapabilities", () => {
  it("surfaces builtin-tool as rows and excludes only teaching-doc, counting it honestly", () => {
    const out = sectionCapabilities([
      cap({ kind: "builtin-tool", name: "create_entity", catalogOnly: true }),
      cap({ kind: "builtin-tool", name: "update_entity", catalogOnly: true }),
      cap({ kind: "teaching-doc", name: "how-to-x", governance: "none" }),
      cap({ kind: "command", name: "digest" }),
    ]);
    // Shown, not hidden — with the marker that keeps them out of a step picker.
    expect(out.builtins.map((b) => b.name)).toEqual([
      "create_entity",
      "update_entity",
    ]);
    expect(out.builtins.every((b) => b.runnableHere === false)).toBe(true);
    // Prose is still folded out — and still COUNTED, so the catalogue can say
    // "1 not shown here". Counting a VISIBLE built-in here would be the lie.
    expect(out.excluded).toEqual({ teachingDocs: 1 });
    expect(out.excluded).not.toHaveProperty("builtinTools");
    // A built-in is never smuggled into an actionable section.
    expect(out.integrations).toHaveLength(0);
    expect(out.skills).toHaveLength(0);
    expect(out.commands.map((c) => c.name)).toEqual(["digest"]);
  });

  it("dedups an integration installed multiple times: unions verbs + ORs connected", () => {
    const out = sectionCapabilities([
      cap({
        kind: "source-provider",
        name: "google",
        connection: { required: true, connected: false, provider: "google" },
        verbs: [verb("gmail_send"), verb("gmail_search")],
      }),
      cap({
        kind: "source-provider",
        name: "google",
        connection: { required: true, connected: true, provider: "google" },
        verbs: [verb("gmail_send", true), verb("calendar_list", true)],
      }),
    ]);
    expect(out.integrations).toHaveLength(1);
    const g = out.integrations[0]!;
    expect(g.connection?.connected).toBe(true); // ORed up from the connected row
    // union of verb ids across both rows
    expect(new Set(g.verbs.map((v) => v.id))).toEqual(
      new Set(["gmail_send", "gmail_search", "calendar_list"])
    );
    // the granted copy of gmail_send wins the merge
    expect(g.verbs.find((v) => v.id === "gmail_send")!.granted).toBe(true);
  });

  it("does not list a provider's backing skill twice (skill name === a verb id)", () => {
    const out = sectionCapabilities([
      cap({
        kind: "tool",
        name: "exa_api",
        verbs: [verb("exa_search"), verb("exa_find_similar")],
      }),
      // backing skills for the exa verbs — must NOT appear under `skills`
      cap({ kind: "skill", name: "exa_search", id: "s1" }),
      cap({ kind: "skill", name: "exa_find_similar", id: "s2" }),
      // a genuinely standalone skill — must appear
      cap({ kind: "skill", name: "ingest_message", id: "s3" }),
    ]);
    expect(out.integrations.map((i) => i.name)).toEqual(["exa_api"]);
    expect(out.skills.map((s) => s.name)).toEqual(["ingest_message"]);
  });

  it("dedups standalone skills by name and skips unlaunchable ones", () => {
    const out = sectionCapabilities([
      cap({ kind: "skill", name: "ingest_message", id: "a" }),
      cap({ kind: "skill", name: "ingest_message", id: "b" }),
      {
        ...cap({ kind: "skill", name: "broken", id: "c" }),
        runnable: false,
      } as Capability,
    ]);
    expect(out.skills.map((s) => s.name)).toEqual(["ingest_message"]);
  });

  /**
   * A brick must be able to state what it RETURNS, not only what it takes.
   * `responseShape` is projected onto declarative provider verbs by
   * `buildVerbStates`; the sectioned view is the door a catalogue reads, so it
   * must carry it through — including across the duplicate-integration merge,
   * where verbs are rebuilt into a Map.
   */
  it("carries a verb's responseShape through to the sectioned view", () => {
    const shaped = {
      ...verb("linear_list_issues", true),
      responseShape: {
        collectionPath: "data.issues",
        item: { title: "title" },
      },
    };
    const out = sectionCapabilities([
      cap({ kind: "tool", name: "linear", verbs: [shaped] }),
    ]);
    expect(out.integrations[0].verbs[0].responseShape).toEqual({
      collectionPath: "data.issues",
      item: { title: "title" },
    });
  });

  it("keeps responseShape when deduping the same integration installed twice", () => {
    const ungranted = verb("linear_list_issues", false);
    const grantedWithShape = {
      ...verb("linear_list_issues", true),
      responseShape: { collectionPath: "data.issues" },
    };
    const out = sectionCapabilities([
      cap({ kind: "tool", name: "linear", verbs: [ungranted] }),
      cap({ kind: "tool", name: "linear", verbs: [grantedWithShape] }),
    ]);
    // The granted copy wins the merge — and brings its output contract with it.
    expect(out.integrations[0].verbs).toHaveLength(1);
    expect(out.integrations[0].verbs[0].granted).toBe(true);
    expect(out.integrations[0].verbs[0].responseShape).toEqual({
      collectionPath: "data.issues",
    });
  });

  it("leaves responseShape undefined for a verb with no declared output contract", () => {
    const out = sectionCapabilities([
      cap({ kind: "tool", name: "linear", verbs: [verb("linear_ping")] }),
    ]);
    expect(out.integrations[0].verbs[0].responseShape).toBeUndefined();
  });

  // ── The built-ins section ───────────────────────────────────────────────
  // `sectionCapabilities` used to DROP every `builtin-tool` row and only report
  // `excluded.builtinTools`. A count cannot render a collapsed, browsable
  // section, so built-ins are real rows now — each carrying `runnableHere`, the
  // fact a flow-node picker filters on so a catalog-only brick can never be
  // offered as a step. (The "built-ins are rows, teaching docs stay excluded"
  // half is already covered by the first test in this file.)

  it("marks a catalogOnly built-in as NOT runnable through this door", () => {
    const out = sectionCapabilities([
      cap({ kind: "builtin-tool", name: "web_search", catalogOnly: true }),
    ]);
    expect(out.builtins[0]!.runnableHere).toBe(false);
  });

  it("derives runnableHere from the row, not from the kind", () => {
    // A `tools.kind='builtin'` row carries a verb catalog and NO catalogOnly
    // flag — hardcoding false for every built-in would assert a falsehood here.
    const out = sectionCapabilities([
      cap({
        kind: "builtin-tool",
        name: "synap_core",
        verbs: [verb("feed.post")],
      }),
    ]);
    expect(out.builtins[0]!.runnableHere).toBe(true);
    expect(out.builtins[0]!.verbs.map((v) => v.id)).toEqual(["feed.post"]);
  });

  it("dedups a built-in described twice: unions verbs, never downgrades runnableHere", () => {
    const out = sectionCapabilities([
      cap({
        kind: "builtin-tool",
        name: "synap_core",
        description: null,
        verbs: [verb("feed.post")],
      }),
      cap({
        kind: "builtin-tool",
        name: "synap_core",
        description: "Tier-0 builtin verbs",
        catalogOnly: true,
        verbs: [verb("channel.create")],
      }),
    ]);
    expect(out.builtins).toHaveLength(1);
    const core = out.builtins[0]!;
    expect(new Set(core.verbs.map((v) => v.id))).toEqual(
      new Set(["feed.post", "channel.create"])
    );
    expect(core.runnableHere).toBe(true); // the launchable copy wins
    expect(core.description).toBe("Tier-0 builtin verbs");
  });

  // ── Container reference ─────────────────────────────────────────────────
  // Without these fields the door could not answer "is this brick packaged?":
  // `integrations[]` carried neither an id nor a container, so a consumer had to
  // group by NAME (which mis-groups on any collision). `null` is a REAL answer —
  // it is what makes un-packaged bricks renderable as their own group.

  it("carries the integration's row id and container reference through", () => {
    const out = sectionCapabilities([
      {
        ...cap({ kind: "source-provider", name: "google", id: "tool-1" }),
        containerId: "cap-1",
        containerName: "Google Workspace",
      } as Capability,
    ]);
    expect(out.integrations[0].id).toBe("tool-1");
    expect(out.integrations[0].containerId).toBe("cap-1");
    expect(out.integrations[0].containerName).toBe("Google Workspace");
  });

  it("reports containerId null — never omitted — for an un-packaged brick", () => {
    const out = sectionCapabilities([
      cap({ kind: "tool", name: "exa_api", id: "tool-2" }),
      cap({ kind: "skill", name: "ingest_message", id: "skill-2" }),
    ]);
    expect(out.integrations[0]).toHaveProperty("containerId", null);
    expect(out.integrations[0]).toHaveProperty("containerName", null);
    expect(out.skills[0]).toHaveProperty("containerId", null);
    expect(out.skills[0]).toHaveProperty("containerName", null);
  });

  it("carries a standalone skill's container reference through", () => {
    const out = sectionCapabilities([
      {
        ...cap({ kind: "skill", name: "ingest_message", id: "skill-1" }),
        containerId: "cap-2",
        containerName: "Inbox",
      } as Capability,
    ]);
    expect(out.skills[0].containerId).toBe("cap-2");
    expect(out.skills[0].containerName).toBe("Inbox");
  });

  it("recovers the container from a duplicate row when the first carries none", () => {
    const out = sectionCapabilities([
      cap({ kind: "source-provider", name: "google", id: "tool-a" }),
      {
        ...cap({ kind: "source-provider", name: "google", id: "tool-b" }),
        containerId: "cap-1",
        containerName: "Google Workspace",
      } as Capability,
    ]);
    expect(out.integrations).toHaveLength(1);
    expect(out.integrations[0].id).toBe("tool-a"); // representative row
    expect(out.integrations[0].containerId).toBe("cap-1");
    expect(out.integrations[0].containerName).toBe("Google Workspace");
  });

  // ── The `limit` option — cap AFTER dedup, not before ─────────────────────
  // `listCapabilities` used to be the only place a query-narrowed result got
  // sliced, and it sliced the RAW (pre-dedup) flat list — before duplicate
  // rows (a provider installed twice, N backing-skill copies of one verb)
  // were folded into one. A genuine, distinct match could rank just past the
  // slice window and never reach `sectionCapabilities` at all, so the picker
  // rendered "no match" for a real capability. The fix: the caller now passes
  // the FULL unsliced list (`listCapabilities({ limit: null })`) and caps
  // HERE, over distinct rows, via this `limit` option.

  it("FAILS on the pre-dedup-slice bug: a distinct match ranked after duplicate rows of something else must still make the cut", () => {
    // Score-sorted input, as `listCapabilities` would hand it over: two RAW
    // rows for the same integration (occupying ranks 0 and 1), then one
    // genuinely distinct capability at rank 2.
    const caps = [
      cap({ kind: "source-provider", name: "google", id: "google-1" }),
      cap({ kind: "source-provider", name: "google", id: "google-2" }),
      cap({ kind: "tool", name: "exa_api", id: "exa-1" }),
    ];
    // A naive pre-dedup `caps.slice(0, 2)` would keep both "google" rows and
    // drop "exa_api" — a real capability, lost behind a duplicate. Capping
    // AFTER the fold must keep both DISTINCT rows instead.
    const out = sectionCapabilities(caps, { limit: 2 });
    expect(out.integrations.map((i) => i.name).sort()).toEqual([
      "exa_api",
      "google",
    ]);
  });

  it("caps DISTINCT rows across every section combined, preserving rank order", () => {
    const caps = [
      cap({ kind: "command", name: "digest", id: "cmd-1" }),
      {
        ...cap({ kind: "skill", name: "ingest_message", id: "skill-1" }),
        runnable: true,
      } as Capability,
      cap({ kind: "tool", name: "exa_api", id: "tool-1" }),
    ];
    const out = sectionCapabilities(caps, { limit: 2 });
    // Ranks 0 and 1 (command, skill) are kept; rank 2 (exa_api) is cut.
    expect(out.commands.map((c) => c.name)).toEqual(["digest"]);
    expect(out.skills.map((s) => s.name)).toEqual(["ingest_message"]);
    expect(out.integrations).toHaveLength(0);
  });

  it("omitting `limit` returns every distinct row, unbounded — the historic behaviour", () => {
    const caps = [
      cap({ kind: "command", name: "digest", id: "cmd-1" }),
      {
        ...cap({ kind: "skill", name: "ingest_message", id: "skill-1" }),
        runnable: true,
      } as Capability,
      cap({ kind: "tool", name: "exa_api", id: "tool-1" }),
    ];
    const out = sectionCapabilities(caps);
    expect(
      out.commands.length + out.skills.length + out.integrations.length
    ).toBe(3);
  });

  it("counts consistently: every input row lands in exactly one bucket", () => {
    const caps = [
      cap({ kind: "builtin-tool", name: "web_search", catalogOnly: true }),
      cap({ kind: "builtin-tool", name: "graph_traverse", catalogOnly: true }),
      cap({ kind: "teaching-doc", name: "how-to-x", governance: "none" }),
      cap({ kind: "tool", name: "exa_api", verbs: [verb("exa_search")] }),
      {
        ...cap({ kind: "skill", name: "ingest_message" }),
        runnable: true,
      } as Capability,
      cap({ kind: "command", name: "digest" }),
    ];
    const out = sectionCapabilities(caps);
    const shown =
      out.integrations.length +
      out.skills.length +
      out.commands.length +
      out.builtins.length;
    expect(shown + out.excluded.teachingDocs).toBe(caps.length);
  });
});
