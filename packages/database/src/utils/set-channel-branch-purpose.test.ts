import { describe, it, expect, beforeEach, vi } from "vitest";

const { findFirstMock, whereMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  whereMock: vi.fn(async () => undefined),
}));

vi.mock("../client-pg.js", () => ({
  db: {
    query: { channels: { findFirst: findFirstMock } },
    update: () => ({ set: () => ({ where: whereMock }) }),
  },
}));
vi.mock("../schema/channels.js", () => ({ channels: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import {
  setChannelBranchPurpose,
  ChannelFirewallImmutableError,
} from "./set-channel-branch-purpose.js";

const call = (branchPurpose: string | null) =>
  setChannelBranchPurpose({ channelId: "c1", branchPurpose });

beforeEach(() => {
  findFirstMock.mockReset();
  whereMock.mockClear();
});

describe("setChannelBranchPurpose — firewall immutability", () => {
  it.each([
    ["null", "client-comms"],
    ["team", "client-comms"],
    ["client-comms", "client-comms"],
    ["team", "team"],
    ["team", null],
    ["null", "team"],
  ])("allows %s -> %s", async (from, to) => {
    findFirstMock.mockResolvedValue({
      branchPurpose: from === "null" ? null : from,
    });
    await expect(call(to as string | null)).resolves.toBeUndefined();
    expect(whereMock).toHaveBeenCalledTimes(1); // the UPDATE ran
  });

  it.each([
    ["client-comms", "team"],
    ["client-comms", null],
  ])("REFUSES %s -> %s (client-comms is immutable)", async (_from, to) => {
    findFirstMock.mockResolvedValue({ branchPurpose: "client-comms" });
    await expect(call(to as string | null)).rejects.toBeInstanceOf(
      ChannelFirewallImmutableError
    );
    expect(whereMock).not.toHaveBeenCalled(); // no write happened
  });
});
