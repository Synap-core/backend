/**
 * `connector.sync.failed` dedupes per CONNECTION (W2 review): two accounts of
 * one provider failing are two things to fix; a pod-wide sync is keyed `pod`,
 * never the literal "null:" the old template produced.
 */
import { describe, it, expect } from "vitest";
import { connectorSyncFailedGroupKey } from "./connector-import-bridge.js";

describe("connectorSyncFailedGroupKey", () => {
  it("keys on the connection, not the provider", () => {
    expect(connectorSyncFailedGroupKey("ws-1", "u:1:gmail:a")).not.toBe(
      connectorSyncFailedGroupKey("ws-1", "u:1:gmail:b")
    );
  });
  it("pod-wide syncs are scoped `pod`, never `null:`", () => {
    for (const ws of [null, undefined]) {
      const key = connectorSyncFailedGroupKey(ws, "c-1");
      expect(key).toBe("pod:connector.sync.failed:c-1");
      expect(key.startsWith("null")).toBe(false);
      expect(key.startsWith("undefined")).toBe(false);
    }
  });
});
