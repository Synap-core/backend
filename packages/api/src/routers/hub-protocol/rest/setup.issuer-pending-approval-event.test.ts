/**
 * S3 — `system.issuer_pending_approval` promotion.
 *
 * The `/setup/agent` route is a large Hono handler registered inline (no
 * exported unit under test), so — same idiom as
 * `capability-drift.projection-parity.tripwire.test.ts` — this pins the
 * promotion against the route's own source rather than driving Hono end to
 * end. It fails by name if the event-append is ever removed, or if it stops
 * using the shared mapping table / the same `issuer.id` subject the
 * per-admin notification already carries.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "setup.ts"), "utf8");

describe("setup.ts /setup/agent — issuer-pending-approval event promotion", () => {
  it("appends an event via the shared eventRepository door, not a raw insert", () => {
    const notifyBlockStart = src.indexOf(
      'type: "system.issuer_pending_approval"'
    );
    expect(
      notifyBlockStart,
      "notification call site not found"
    ).toBeGreaterThan(-1);
    const after = src.slice(notifyBlockStart, notifyBlockStart + 2000);

    expect(after).toContain("eventRepository.append(");
    expect(after).not.toMatch(/insert\(events\)/);
  });

  it("resolves its event type from NOTIFICATION_EVENT_TYPE_MAP, never a hand-typed literal", () => {
    const notifyBlockStart = src.indexOf(
      'type: "system.issuer_pending_approval"'
    );
    const after = src.slice(notifyBlockStart, notifyBlockStart + 2000);

    expect(after.replace(/\s+/g, "")).toContain(
      'NOTIFICATION_EVENT_TYPE_MAP["system.issuer_pending_approval"]'
    );
  });

  it("carries the SAME subject (issuer.id) the per-admin notification uses as sourceId", () => {
    const notifyBlockStart = src.indexOf(
      'type: "system.issuer_pending_approval"'
    );
    const after = src.slice(notifyBlockStart, notifyBlockStart + 2000);

    expect(after).toMatch(/sourceId:\s*issuer\.id/);
    expect(after).toMatch(/subjectId:\s*issuer\.id/);
  });
});
