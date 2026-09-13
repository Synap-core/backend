import { describe, it, expect } from "vitest";
import {
  deriveBrokerTrustState,
  readBrokerTrustEnvelope,
  type BrokerTrustReport,
} from "./broker-trust";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");

const trusted: BrokerTrustReport = {
  cpIssuer: { present: true, status: "approved", hasSourceConfigWrite: true },
  ownerIdentityLink: { present: true },
  relayCredential: { present: true, validUntil: "2026-10-01T00:00:00.000Z" },
  broker: { kind: "control-plane", reason: null },
};

const with_ = (over: Partial<BrokerTrustReport>): BrokerTrustReport => ({
  ...trusted,
  ...over,
});

describe("deriveBrokerTrustState", () => {
  it("a fully trusted pod is ok and keeps its expiry", () => {
    expect(deriveBrokerTrustState(trusted, NOW)).toEqual({
      kind: "ok",
      validUntil: "2026-10-01T00:00:00.000Z",
    });
  });

  it("a locally brokered pod has no control plane trust to show", () => {
    expect(
      deriveBrokerTrustState(
        with_({ broker: { kind: "local", reason: null } }),
        NOW
      ).kind
    ).toBe("not-managed");
  });

  // Each row breaks exactly one fact and keeps every later fact broken too, so
  // the derivation must name the EARLIEST blocker in delivery order.
  it.each([
    [
      "issuer-missing",
      with_({
        cpIssuer: { present: false, status: null, hasSourceConfigWrite: false },
        ownerIdentityLink: { present: false },
        relayCredential: { present: false, validUntil: null },
      }),
    ],
    [
      "issuer-pending",
      with_({
        cpIssuer: {
          present: true,
          status: "pending",
          hasSourceConfigWrite: false,
        },
        ownerIdentityLink: { present: false },
      }),
    ],
    [
      "issuer-closed",
      with_({
        cpIssuer: {
          present: true,
          status: "revoked",
          hasSourceConfigWrite: true,
        },
        ownerIdentityLink: { present: false },
      }),
    ],
    [
      "issuer-scope-missing",
      with_({
        cpIssuer: {
          present: true,
          status: "approved",
          hasSourceConfigWrite: false,
        },
        ownerIdentityLink: { present: false },
      }),
    ],
    [
      "owner-link-missing",
      with_({
        ownerIdentityLink: { present: false },
        relayCredential: { present: false, validUntil: null },
      }),
    ],
    [
      "credential-missing",
      with_({
        relayCredential: { present: false, validUntil: null },
        broker: { kind: "control-plane", reason: "broker-credential-missing" },
      }),
    ],
    [
      "credential-expired",
      with_({
        relayCredential: {
          present: true,
          validUntil: "2026-09-01T00:00:00.000Z",
        },
        broker: { kind: "control-plane", reason: "broker-credential-missing" },
      }),
    ],
    [
      "broker-fault",
      with_({ broker: { kind: "control-plane", reason: "db-unavailable" } }),
    ],
  ])("→ %s", (kind, report) => {
    expect(deriveBrokerTrustState(report, NOW).kind).toBe(kind);
  });
});

describe("readBrokerTrustEnvelope", () => {
  it("unwraps a SuperJSON query result", () => {
    expect(
      readBrokerTrustEnvelope(200, { result: { data: { json: trusted } } })
    ).toEqual({ ok: true, report: trusted });
  });

  it("a tRPC error is an error, with the pod's message", () => {
    expect(
      readBrokerTrustEnvelope(403, {
        error: { json: { message: "Pod admin access required" } },
      })
    ).toEqual({ ok: false, message: "Pod admin access required" });
  });

  it("an empty or malformed result is an error, never an empty report", () => {
    expect(readBrokerTrustEnvelope(200, { result: { data: {} } }).ok).toBe(
      false
    );
    expect(readBrokerTrustEnvelope(200, null).ok).toBe(false);
    expect(
      readBrokerTrustEnvelope(200, {
        result: { data: { json: { cpIssuer: {} } } },
      }).ok
    ).toBe(false);
  });
});
