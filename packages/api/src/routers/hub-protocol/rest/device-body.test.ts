/**
 * `POST /setup/device` (0395): today's CLI keeps working — every new field is
 * optional — and a newer CLI's seat, job rows and held key ids are read, and
 * refused when malformed (a colon in a seat would forge an `unnamed:` one).
 */
import { describe, expect, it } from "vitest";
import { DeviceCreateBody } from "./device-body.js";

describe("the device request body", () => {
  it("today's CLI: hostname + agents only still parses", () => {
    const parsed = DeviceCreateBody.safeParse({
      clientName: "synap-cli",
      hostname: "devbox",
      platform: "linux",
      agents: ["claude-code"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      clientName: "synap-cli",
      hostname: "devbox",
      platform: "linux",
      agents: ["claude-code"],
    });
  });

  it("a newer CLI: seat, seatId, rows with a job, held key ids", () => {
    const parsed = DeviceCreateBody.safeParse({
      clientName: "synap-cli",
      hostname: "devbox",
      agents: ["claude-code"],
      seat: "agent",
      seatId: "3f1a9c0d5b7e4a2f8c6d1e0b9a7f5c3d",
      rows: [
        {
          agentType: "claude-code",
          role: "crm-worker",
          roleLabel: "CRM worker",
        },
      ],
      held: [{ keyId: "11111111-1111-4111-8111-111111111111" }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.rows?.[0]).toEqual({
      agentType: "claude-code",
      role: "crm-worker",
      roleLabel: "CRM worker",
    });
  });

  it("refuses a seat with a colon, a job that is not a slug, a held key that is not an id", () => {
    const base = { clientName: "synap-cli", hostname: "devbox" };
    expect(
      DeviceCreateBody.safeParse({ ...base, seat: "unnamed:1234abcd" }).success
    ).toBe(false);
    expect(
      DeviceCreateBody.safeParse({
        ...base,
        rows: [{ agentType: "claude-code", role: "CRM Worker" }],
      }).success
    ).toBe(false);
    expect(
      DeviceCreateBody.safeParse({ ...base, held: [{ keyId: "sk-secret" }] })
        .success
    ).toBe(false);
  });

  it("an agent type is shaped here, not listed: a template's engine parses, a non-slug does not", () => {
    const base = { clientName: "synap-cli", hostname: "ct112" };
    expect(
      DeviceCreateBody.safeParse({ ...base, agents: ["hermes"] }).success
    ).toBe(true);
    expect(
      DeviceCreateBody.safeParse({ ...base, agents: ["Hermes Agent"] }).success
    ).toBe(false);
  });
});
