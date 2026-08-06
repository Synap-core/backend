/**
 * openProcessChannel — pure/unit surface tests (no live DB).
 * Integration of ensureRunChannel + seed insert is covered by dogfood.
 */

import { describe, expect, it } from "vitest";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";
import { newProcessFlowId } from "./open-process-channel.js";

describe("open-process-channel helpers", () => {
  it("newProcessFlowId returns a UUID-shaped string", () => {
    const id = newProcessFlowId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("seed message ids are deterministic for the same channel+key", () => {
    const a = deterministicUuidFromKey(
      "open_process:ch-1:process-seed:capture:flow-1:0"
    );
    const b = deterministicUuidFromKey(
      "open_process:ch-1:process-seed:capture:flow-1:0"
    );
    const c = deterministicUuidFromKey(
      "open_process:ch-1:process-seed:capture:flow-1:1"
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
