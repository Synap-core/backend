/**
 * The abstract-intent ROUTING axis (Wave 1 of the Intent Spine).
 *
 * Covers the three seams the axis can silently break at: the closed vocabulary
 * at the WRITE boundary, backward compatibility of a legacy catalog entry, and
 * the reverse index's delegation of the visibility floor.
 */
import { describe, expect, it, vi } from "vitest";
import type { CapabilitySkillDef } from "@synap/playbooks";
import {
  ABSTRACT_VERBS,
  isAbstractVerb,
  type ToolVerbCatalogEntry,
} from "@synap/database/schema";
import { deriveToolVerbs } from "./create-from-definition.js";
import { foldVerbsByIntent } from "./capability-intent-index.js";
import type { RegistryCapability } from "./capability-registry.js";

function verbSkill(
  name: string,
  extra: Partial<CapabilitySkillDef> = {}
): CapabilitySkillDef {
  return { name, kind: "code", requires: ["the_tool"], ...extra };
}

describe("the closed intent vocabulary", () => {
  it("has exactly the 13 pinned values", () => {
    expect([...ABSTRACT_VERBS]).toEqual([
      "search_external",
      "find_people",
      "enrich_entity",
      "fetch_record",
      "list_records",
      "send_message",
      "request_connection",
      "schedule_event",
      "manage_file",
      "generate_media",
      "capture_into_pod",
      "run_external_job",
      "connect_account",
    ]);
  });

  it("rejects a value outside the vocabulary", () => {
    expect(isAbstractVerb("send_message")).toBe(true);
    expect(isAbstractVerb("send_mesage")).toBe(false);
    expect(isAbstractVerb("post_tweet")).toBe(false);
    expect(isAbstractVerb(undefined)).toBe(false);
  });
});

describe("deriveToolVerbs — the ONE write boundary", () => {
  it("carries a declared intent onto the catalog entry", () => {
    const [verb] = deriveToolVerbs(
      "the_tool",
      [verbSkill("gmail_send", { intent: "send_message" })],
      "propose"
    );
    expect(verb?.intent).toBe("send_message");
    // The vendor-keyed id is UNTOUCHED — it is persisted in
    // capability_run_receipts.verb_id and in stored automation flows.
    expect(verb?.id).toBe("gmail_send");
  });

  it("THROWS on an unknown intent rather than silently storing it", () => {
    expect(() =>
      deriveToolVerbs(
        "the_tool",
        [verbSkill("weird_verb", { intent: "post_tweet" as never })],
        "propose"
      )
    ).toThrow(/unknown intent/i);
  });

  it("omits the field entirely when no intent is declared (legacy shape)", () => {
    const [verb] = deriveToolVerbs(
      "the_tool",
      [verbSkill("legacy")],
      "propose"
    );
    expect(verb).toBeDefined();
    expect("intent" in (verb as object)).toBe(false);
  });

  it("derives no verb at all for a teaching (instruction) skill", () => {
    // Prose requires no tool, so it never becomes a callable verb — and so can
    // never carry an intent.
    const verbs = deriveToolVerbs(
      "the_tool",
      [
        { name: "draft-outreach", kind: "instruction", code: "…prose…" },
        verbSkill("gmail_send", { intent: "send_message" }),
      ],
      "propose"
    );
    expect(verbs.map((v) => v.id)).toEqual(["gmail_send"]);
  });
});

// ── The reverse index ────────────────────────────────────────────────────────

function cap(
  id: string,
  name: string,
  verbs: Array<Partial<ToolVerbCatalogEntry> & { id: string }>,
  extra: Partial<RegistryCapability> = {}
): RegistryCapability {
  return {
    id,
    name,
    kind: "tool",
    governance: "propose",
    verbs: verbs.map((v) => ({
      label: v.id,
      kind: "action" as const,
      govDefault: "propose" as const,
      granted: false,
      effectiveExecMode: "propose" as const,
      backingSkillExecutable: true,
      ...v,
    })),
    ...extra,
  } as RegistryCapability;
}

describe("foldVerbsByIntent", () => {
  it("returns every visible verb declaring an intent, across vendors", () => {
    const index = foldVerbsByIntent([
      cap("t1", "google", [
        { id: "gmail_send", intent: "send_message" },
        { id: "gmail_search", intent: "search_external" },
      ]),
      cap("t2", "unipile", [
        { id: "unipile_send_message", intent: "send_message" },
      ]),
    ]);
    expect(
      index
        .get("send_message")
        ?.map((m) => m.verbId)
        .sort()
    ).toEqual(["gmail_send", "unipile_send_message"]);
    expect(index.get("search_external")?.[0]?.capabilityName).toBe("google");
  });

  it("ignores a legacy verb with no intent (never guesses a bucket)", () => {
    const index = foldVerbsByIntent([
      cap("t1", "legacy", [{ id: "old_verb" }]),
    ]);
    expect(index.size).toBe(0);
  });

  it("dedupes a duplicate integration row, preferring the granted copy", () => {
    const index = foldVerbsByIntent([
      cap("t1", "google", [{ id: "gmail_send", intent: "send_message" }]),
      cap("t2", "google", [
        { id: "gmail_send", intent: "send_message", granted: true } as never,
      ]),
    ]);
    const matches = index.get("send_message") ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.granted).toBe(true);
  });
});

describe("capabilitiesByIntent — the visibility floor", () => {
  it("delegates scoping to listCapabilities verbatim (no second predicate)", async () => {
    vi.resetModules();
    const listCapabilities = vi
      .fn()
      .mockResolvedValue([
        cap("t1", "google", [{ id: "gmail_send", intent: "send_message" }]),
      ]);
    // PARTIAL mock (importOriginal), never a total `() => ({})` replacement —
    // a total mock silently kills the module the moment a new import lands.
    vi.doMock("./capability-registry.js", async () => ({
      ...(await vi.importActual<typeof import("./capability-registry.js")>(
        "./capability-registry.js"
      )),
      listCapabilities,
    }));
    const { capabilitiesByIntent } =
      await import("./capability-intent-index.js");

    const ctx = { workspaceId: "ws-1", userId: "user-1" };
    const matches = await capabilitiesByIntent(ctx, "send_message");

    expect(matches.map((m) => m.verbId)).toEqual(["gmail_send"]);
    // The caller's lens reaches the registry unchanged — the ONE scoped read.
    expect(listCapabilities).toHaveBeenCalledWith(ctx, { limit: null });
    vi.doUnmock("./capability-registry.js");
  });

  it("returns [] for an intent nothing declares (a real answer)", async () => {
    vi.resetModules();
    vi.doMock("./capability-registry.js", async () => ({
      ...(await vi.importActual<typeof import("./capability-registry.js")>(
        "./capability-registry.js"
      )),
      listCapabilities: vi
        .fn()
        .mockResolvedValue([cap("t1", "legacy", [{ id: "old_verb" }])]),
    }));
    const { capabilitiesByIntent } =
      await import("./capability-intent-index.js");
    await expect(
      capabilitiesByIntent({ workspaceId: null, userId: "u" }, "generate_media")
    ).resolves.toEqual([]);
    vi.doUnmock("./capability-registry.js");
  });
});
