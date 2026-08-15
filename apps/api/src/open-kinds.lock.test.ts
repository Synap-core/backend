import { describe, expect, it } from "vitest";
import { TYPED_OPEN_KINDS } from "./open-dispatch.js";
import {
  BOUNCE_TYPES,
  HOST_TYPES,
} from "../../pod-admin/app/open/open-params.ts";

describe("open kinds lock", () => {
  it("HOST_TYPES ∪ BOUNCE_TYPES equals TYPED_OPEN_KINDS", () => {
    const fromPodAdmin = [...HOST_TYPES, ...BOUNCE_TYPES].sort();
    const fromApi = [...TYPED_OPEN_KINDS].sort();
    expect(fromPodAdmin).toEqual(fromApi);
  });
});
