/**
 * automation-catalog — pure assembler unit tests.
 *
 * Exercises `assembleAutomationCards`, the DB-free core of the automation
 * catalog: installed workspace automations become `installed` cards, available
 * catalog packages become `available` cards, name-match de-dups an available
 * package against an installed automation, and every card carries the
 * `kind:"automation"` discriminator (a SEPARATE kind, never a CapabilityCard).
 */

import { describe, it, expect } from "vitest";
import {
  assembleAutomationCards,
  type AvailableAutomationInput,
  type InstalledAutomationInput,
} from "./automation-catalog.js";

const pkg = (
  slug: string,
  name: string,
  description: string | null = null
): AvailableAutomationInput => ({ slug, name, description });

const installedRow = (
  id: string,
  name: string,
  status: InstalledAutomationInput["status"] = "active",
  triggerType: InstalledAutomationInput["triggerType"] = "cron"
): InstalledAutomationInput => ({
  id,
  name,
  description: null,
  status,
  triggerType,
});

describe("assembleAutomationCards", () => {
  it("surfaces available packages as available cards, tagged kind:automation", () => {
    const cards = assembleAutomationCards(
      [pkg("daily-digest", "Daily Digest", "A morning summary")],
      []
    );
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card.kind).toBe("automation");
    expect(card.source).toBe("available");
    expect(card.status).toBe("available");
    expect(card.id).toBeNull();
    expect(card.key).toBe("daily-digest");
    expect(card.name).toBe("Daily Digest");
    expect(card.description).toBe("A morning summary");
    expect(card.nextAction.kind).toBe("add");
  });

  it("surfaces installed automations as installed cards with lifecycle + trigger", () => {
    const cards = assembleAutomationCards(
      [],
      [installedRow("auto-1", "Lead Router", "paused", "event")]
    );
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card.kind).toBe("automation");
    expect(card.source).toBe("installed");
    expect(card.status).toBe("installed");
    expect(card.id).toBe("auto-1");
    expect(card.key).toBe("auto-1");
    expect(card.lifecycle).toBe("paused");
    expect(card.triggerType).toBe("event");
    expect(card.nextAction.kind).toBe("run");
  });

  it("de-dups an available package whose name matches an installed automation (case-insensitive)", () => {
    const cards = assembleAutomationCards(
      [pkg("daily-digest", "Daily Digest"), pkg("lead-router", "Lead Router")],
      [installedRow("auto-1", "daily digest")]
    );
    // The installed "daily digest" collapses the available "Daily Digest";
    // "Lead Router" (only available) stays available.
    const byName = new Map(cards.map((c) => [c.name.toLowerCase(), c]));
    expect(cards).toHaveLength(2);
    expect(byName.get("daily digest")?.source).toBe("installed");
    expect(byName.get("lead router")?.source).toBe("available");
  });

  it("returns an empty list when there is nothing installed or available", () => {
    expect(assembleAutomationCards([], [])).toEqual([]);
  });
});
