/**
 * PARITY TRIPWIRE — the automation-health predicate's mirrored vocabularies vs
 * the real drizzle columns.
 *
 * `automation-health-predicate.ts` is deliberately import-free, so it MIRRORS
 * the `automations.status` and `automations.trigger_type` enums instead of
 * importing them. A mirror is a fork the moment nothing pins it: a new status
 * would silently land outside `AUTOMATION_STATUSES`, and — because the
 * predicate's own enumerated tests iterate that constant — would never be
 * exercised on either side of the FIRING_STATUSES line. This file closes that,
 * by reading the enum straight off the schema column.
 *
 * DB-FREE: it imports the SCHEMA MODULE, not the client. `enumValues` is static
 * column metadata; no pool is opened and no connection is made.
 */

import { describe, it, expect } from "vitest";
import { automations } from "../../../../database/src/schema/automations.js";
import {
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGER_TYPES,
  FIRING_STATUSES,
  PRODUCER_BACKED_TRIGGERS,
} from "./automation-health-predicate.js";

describe("automation-health predicate vocabulary parity", () => {
  it("AUTOMATION_STATUSES matches automations.status.enumValues exactly", () => {
    expect([...AUTOMATION_STATUSES].sort()).toEqual(
      [...automations.status.enumValues].sort()
    );
  });

  it("AUTOMATION_TRIGGER_TYPES matches automations.triggerType.enumValues exactly", () => {
    expect([...AUTOMATION_TRIGGER_TYPES].sort()).toEqual(
      [...automations.triggerType.enumValues].sort()
    );
  });

  it("every FIRING_STATUS is a real status — 'enabled' can never be a literal the column does not have", () => {
    for (const s of FIRING_STATUSES) {
      expect(automations.status.enumValues).toContain(s);
    }
  });

  it("every PRODUCER_BACKED_TRIGGER is a real trigger type", () => {
    for (const t of PRODUCER_BACKED_TRIGGERS) {
      expect(automations.triggerType.enumValues).toContain(t);
    }
  });
});
