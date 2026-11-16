/**
 * The words a need and an intent wear (0426): one table each in the
 * vocabulary door, pinned to the needs vocabulary and the intent list, in
 * English and French; and the process read's need entries are named, never
 * shown as their raw token (`need:code-host/fetch_record`).
 */
import { describe, expect, it } from "vitest";
import { NEEDS, NEED_SLUGS } from "../needs/index.js";
import { CAPABILITY_INTENTS } from "../capability-intents/index.js";
import {
  INTENT_LABELS,
  NEED_LABELS,
  resolveIntentLabel,
  resolveNeedLabel,
  resolveProcessNeedLabels,
} from "./index.js";

describe("need and intent labels: one table each, pinned", () => {
  it("every need has its word, equal to the needs vocabulary's label", () => {
    expect(Object.keys(NEED_LABELS).sort()).toEqual([...NEED_SLUGS].sort());
    for (const n of NEEDS) {
      expect(NEED_LABELS[n.slug as keyof typeof NEED_LABELS]).toBe(n.label);
    }
  });

  it("every intent has a short name", () => {
    expect(Object.keys(INTENT_LABELS).sort()).toEqual(
      [...CAPABILITY_INTENTS].sort()
    );
  });

  it("aliases read as their need; unknown slugs humanize; none is empty", () => {
    expect(resolveNeedLabel("ci", { locale: "en" })).toBe("Gate");
    expect(resolveNeedLabel("git-host", { locale: "fr" })).toBe(
      "Hébergement du code"
    );
    expect(resolveNeedLabel("crystal-ball", { locale: "en" })).toBe(
      "Crystal ball"
    );
    expect(resolveNeedLabel(null)).toBe("");
    expect(resolveIntentLabel("fetch_record", { locale: "fr" })).toBe(
      "Récupérer une fiche"
    );
    expect(resolveIntentLabel("teleport_thing", { locale: "en" })).toBe(
      "Teleport thing"
    );
  });
});

describe("a process read's need entry is named, never its token", () => {
  const entry = {
    slug: "need:code-host/fetch_record",
    kind: "need" as const,
  };

  it("a need: slug with an intent, in English and French", () => {
    expect(resolveProcessNeedLabels(entry, { locale: "en" })).toEqual({
      label: "Code host",
      intentLabel: "Fetch a record",
    });
    expect(resolveProcessNeedLabels(entry, { locale: "fr" })).toEqual({
      label: "Hébergement du code",
      intentLabel: "Récupérer une fiche",
    });
  });

  it("a need: slug alone, an alias, an intent entry, a capability entry", () => {
    expect(
      resolveProcessNeedLabels({ slug: "need:ci", kind: "need" }, { locale: "en" })
    ).toEqual({ label: "Gate", intentLabel: null });
    expect(
      resolveProcessNeedLabels(
        { slug: "send_message", kind: "intent" },
        { locale: "en" }
      )
    ).toEqual({ label: "Send a message", intentLabel: null });
    expect(
      resolveProcessNeedLabels(
        {
          slug: "0b6f…-cap-id",
          kind: "capability",
          providers: [
            { capabilityId: "c1", capabilityName: "GitHub", verbId: null },
          ],
        },
        { locale: "en" }
      )
    ).toEqual({ label: "GitHub", intentLabel: null });
    expect(
      resolveProcessNeedLabels(
        { slug: "0b6f…-cap-id", kind: "capability", providers: [] },
        { locale: "en" }
      )
    ).toEqual({ label: null, intentLabel: null });
  });
});
