import { describe, it, expect } from "vitest";
import { sectionCapabilities } from "./capability-registry.js";
import type { Capability, CapabilityVerbState } from "@synap/playbooks";

/**
 * `sectionCapabilities` is the agent-facing projection: it drops the two
 * non-actionable kinds (built-in MCP tools + teaching prose), de-duplicates the
 * management read-model's repeated rows, nests verbs under their integration,
 * and never lists a provider's backing skill twice.
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
  it("excludes builtin-tool and teaching-doc, counting them honestly", () => {
    const out = sectionCapabilities([
      cap({ kind: "builtin-tool", name: "create_entity", catalogOnly: true }),
      cap({ kind: "builtin-tool", name: "update_entity", catalogOnly: true }),
      cap({ kind: "teaching-doc", name: "how-to-x", governance: "none" }),
      cap({ kind: "command", name: "digest" }),
    ]);
    expect(out.excluded).toEqual({ builtinTools: 2, teachingDocs: 1 });
    expect(out.integrations).toHaveLength(0);
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
});
