import { describe, it, expect, vi } from "vitest";
import {
  applyCaptureUpdateOps,
  buildCaptureUpdatePatch,
  isCaptureUpdateOp,
} from "./capture-update-arm.js";

describe("isCaptureUpdateOp", () => {
  it("needs BOTH the flag and a target", () => {
    expect(
      isCaptureUpdateOp({ tempId: "t1", title: "A", updateExisting: true })
    ).toBe(false);
    expect(
      isCaptureUpdateOp({
        tempId: "t1",
        title: "A",
        existingEntityId: "e1",
      })
    ).toBe(false);
    expect(
      isCaptureUpdateOp({
        tempId: "t1",
        title: "A",
        existingEntityId: "e1",
        updateExisting: true,
      })
    ).toBe(true);
  });
});

describe("buildCaptureUpdatePatch", () => {
  const base = {
    tempId: "t1",
    title: "Ada Lovelace",
    existingEntityId: "e1",
    updateExisting: true as const,
  };

  it("drops empty-ish property values (same predicate as identity-enrich)", () => {
    const patch = buildCaptureUpdatePatch({
      ...base,
      properties: {
        email: "ada@acme.com",
        phone: "",
        role: null,
        x: undefined,
      },
    });
    expect(patch).toEqual({
      entityId: "e1",
      properties: { email: "ada@acme.com" },
    });
  });

  it("returns null when there is nothing to write (never files an empty proposal)", () => {
    expect(
      buildCaptureUpdatePatch({ ...base, properties: { a: "", b: null } })
    ).toBeNull();
    expect(buildCaptureUpdatePatch({ ...base })).toBeNull();
    expect(buildCaptureUpdatePatch({ ...base, description: "   " })).toBeNull();
  });

  it("NEVER patches the title — a passing mention must not rename the entity", () => {
    const patch = buildCaptureUpdatePatch({
      ...base,
      title: "Ada (from the conference)",
      properties: { email: "ada@acme.com" },
    });
    expect(patch).not.toHaveProperty("title");
  });

  it("is null for a plain link op — a link writes nothing by design", () => {
    expect(
      buildCaptureUpdatePatch({
        tempId: "t1",
        title: "A",
        existingEntityId: "e1",
        properties: { email: "ada@acme.com" },
      })
    ).toBeNull();
  });
});

describe("applyCaptureUpdateOps", () => {
  const updateOp = {
    tempId: "t1",
    title: "Ada Lovelace",
    existingEntityId: "e1",
    updateExisting: true as const,
    properties: { email: "ada@acme.com" },
  };

  it("gates through entities.update and reports an applied patch", async () => {
    const updateEntity = vi.fn().mockResolvedValue({ id: "e1" });
    const res = await applyCaptureUpdateOps({
      ops: [updateOp, { tempId: "t2", title: "New thing" }],
      updateEntity,
      forcePropose: false,
    });
    expect(updateEntity).toHaveBeenCalledTimes(1);
    expect(updateEntity.mock.calls[0][0]).toMatchObject({
      id: "e1",
      properties: { email: "ada@acme.com" },
      source: "user",
    });
    // No forcePropose when the create half granted.
    expect(updateEntity.mock.calls[0][0].forcePropose).toBeUndefined();
    expect(res).toEqual([{ tempId: "t1", entityId: "e1", status: "applied" }]);
  });

  it("forces a proposal when the create half was parked for review", async () => {
    const updateEntity = vi.fn().mockResolvedValue({
      status: "proposed",
      proposalId: "p1",
      reviewUrl: "https://pod/p/p1",
    });
    const res = await applyCaptureUpdateOps({
      ops: [updateOp],
      updateEntity,
      forcePropose: true,
    });
    expect(updateEntity.mock.calls[0][0].forcePropose).toBe(true);
    expect(res[0]).toEqual({
      tempId: "t1",
      entityId: "e1",
      status: "proposed",
      proposalId: "p1",
      reviewUrl: "https://pod/p/p1",
    });
  });

  it("reports a failed patch instead of losing the rest of the capture", async () => {
    const updateEntity = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad property"))
      .mockResolvedValueOnce({ id: "e2" });
    const onError = vi.fn();
    const res = await applyCaptureUpdateOps({
      ops: [updateOp, { ...updateOp, tempId: "t2", existingEntityId: "e2" }],
      updateEntity,
      forcePropose: false,
      onError,
    });
    expect(res[0]).toMatchObject({ status: "failed", reason: "bad property" });
    expect(res[1]).toMatchObject({ status: "applied", entityId: "e2" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("skips update ops that carry no new facts (no empty proposal)", async () => {
    const updateEntity = vi.fn();
    const res = await applyCaptureUpdateOps({
      ops: [{ ...updateOp, properties: {} }],
      updateEntity,
      forcePropose: false,
    });
    expect(updateEntity).not.toHaveBeenCalled();
    expect(res).toEqual([]);
  });
});
