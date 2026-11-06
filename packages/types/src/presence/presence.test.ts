import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  isPresenceCode,
  presenceActionDigest,
  presenceActionSubject,
  sensitiveActionReason,
  oauthConsentId,
  PRESENCE_REFUSAL_CODES,
  presenceRequestSubject,
  enrollmentSubject,
  presenceActorLabel,
  presenceMessage,
  presenceProofSchema,
  sensitiveApprovalReason,
} from "./index.js";

describe("proof of presence vocabulary", () => {
  it("isPresenceCode tells the four presence refusals from any other code", () => {
    expect(PRESENCE_REFUSAL_CODES).toEqual([
      "PRESENCE_REQUIRED",
      "PRESENCE_INVALID",
      "PRESENCE_EXPIRED",
      "PRESENCE_USED",
    ]);
    for (const code of PRESENCE_REFUSAL_CODES)
      expect(isPresenceCode(code)).toBe(true);
    for (const other of ["REVIEW_ON_ITS_PAGE", "FORBIDDEN", "", null, 1])
      expect(isPresenceCode(other)).toBe(false);
  });

  it("the sensitive set: setup, governance, deploys, deletions; everyday approvals are not in it", () => {
    expect(
      sensitiveApprovalReason({ targetType: "agent", proposalType: "connect" })
    ).toBe("setup");
    expect(
      sensitiveApprovalReason({
        targetType: "governance_rule",
        proposalType: "governance.rule_create",
      })
    ).toBe("governance");
    expect(
      sensitiveApprovalReason({
        targetType: "config",
        proposalType: "settings.update",
      })
    ).toBe("governance");
    expect(
      sensitiveApprovalReason({
        targetType: "focus_session",
        proposalType: "dev.deploy_approval",
      })
    ).toBe("deploy");
    expect(
      sensitiveApprovalReason({ targetType: "entity", proposalType: "delete" })
    ).toBe("deletion");
    // Founder, 4 Nov: turning a skill or tool ON is sensitive.
    expect(
      sensitiveApprovalReason({ targetType: "skill", proposalType: "create" })
    ).toBe("setup");
    for (const [targetType, proposalType] of [
      ["entity", "create"],
      ["entity", "update"],
      ["document", "create"],
      ["focus_session", "dev.plan_approval"],
      ["relation", "update"],
    ]) {
      expect(
        sensitiveApprovalReason({
          targetType: targetType!,
          proposalType: proposalType!,
        }),
        `${targetType}/${proposalType}`
      ).toBeNull();
    }
  });

  it("the signed message names the pod, the challenge and the subject, in order", () => {
    expect(
      presenceMessage({
        podOrigin: "https://p.test",
        challengeId: "c1",
        subject: "prop-1",
        nonce: "n",
      })
    ).toBe("synap-presence-v1\nhttps://p.test\nc1\nprop-1\nn");
    expect(enrollmentSubject("c1")).toBe("enroll:c1");
  });

  it("the audit names how the person approved and where it was asked", () => {
    expect(
      presenceActorLabel({
        person: "Antoine",
        method: "passkey",
        requestedFrom: "MacBook-Pro",
      })
    ).toBe("Antoine (approved with a passkey, requested from MacBook-Pro)");
  });

  it("the wire shape refuses a proof that is not base64url or names no challenge", () => {
    expect(
      presenceProofSchema.safeParse({
        kind: "device_key",
        challengeId: "x",
        keyId: "y",
        signature: "a",
      }).success
    ).toBe(false);
    expect(
      presenceProofSchema.safeParse({
        kind: "device_key",
        challengeId: "0aaaaaaa-0000-4000-8000-000000000001",
        keyId: "0aaaaaaa-0000-4000-8000-000000000002",
        signature: "not base64url!",
      }).success
    ).toBe(false);
  });

  it("a request subject and an OAuth consent id are stable and distinct", async () => {
    expect(presenceRequestSubject("key_request", "r1")).toBe("key_request:r1");
    const a = await oauthConsentId({
      clientId: "c",
      redirectUri: "https://x/cb",
      codeChallenge: "k",
      state: "s",
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await oauthConsentId({
        clientId: "c",
        redirectUri: "https://x/cb",
        codeChallenge: "k",
        state: "s",
      })
    ).toBe(a);
    expect(
      await oauthConsentId({
        clientId: "c",
        redirectUri: "https://x/cb",
        codeChallenge: "k2",
        state: "s",
      })
    ).not.toBe(a);
  });
});

describe("sensitive actions (slice 3, founder decision 1)", () => {
  it("names the key, governance and machine-default doors; an everyday door is not one", () => {
    expect(sensitiveActionReason("apiKeys.create")).toBe("setup");
    expect(sensitiveActionReason("governanceRules.widenCell")).toBe(
      "governance"
    );
    expect(sensitiveActionReason("shares.share")).toBeNull();
    expect(sensitiveActionReason("governanceRules.revoke")).toBeNull();
  });

  it("canonical JSON sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}'
    );
  });

  it("the digest binds the path and the input, whatever the key order, never the proof", async () => {
    const a = await presenceActionDigest("apiKeys.create", {
      keyName: "ci",
      expiresInDays: 30,
    });
    expect(
      await presenceActionDigest("apiKeys.create", {
        expiresInDays: 30,
        keyName: "ci",
        presence: { kind: "device_key" },
      })
    ).toBe(a);
    expect(
      await presenceActionDigest("apiKeys.create", {
        keyName: "ci",
        expiresInDays: 31,
      })
    ).not.toBe(a);
    expect(
      await presenceActionDigest("apiKeys.rotate", {
        keyName: "ci",
        expiresInDays: 30,
      })
    ).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(presenceActionSubject("apiKeys.create", a)).toBe(
      `action:apiKeys.create:${a}`
    );
  });
});
