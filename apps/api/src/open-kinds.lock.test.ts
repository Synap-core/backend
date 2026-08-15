import { describe, expect, it } from "vitest";
import { TYPED_OPEN_KINDS } from "./open-dispatch.js";

// Frozen copy of pod-admin HOST_TYPES ∪ BOUNCE_TYPES (open-params.ts).
// Do not import that file from apps/api — tsc rootDir cannot leave src/.
// If you change either list, update both this snapshot and open-params.ts.
const POD_ADMIN_HOST_TYPES = ["entity", "view"] as const;
const POD_ADMIN_BOUNCE_TYPES = [
  "proposal",
  "document",
  "cell",
  "channel",
  "session",
  "project",
  "workspace",
] as const;

describe("open kinds lock", () => {
  it("pod-admin HOST ∪ BOUNCE equals TYPED_OPEN_KINDS", () => {
    const fromPodAdmin = [
      ...POD_ADMIN_HOST_TYPES,
      ...POD_ADMIN_BOUNCE_TYPES,
    ].sort();
    const fromApi = [...TYPED_OPEN_KINDS].sort();
    expect(fromPodAdmin).toEqual(fromApi);
  });
});
