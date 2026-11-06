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
  DEFAULT_PRESENCE_SENSITIVITY,
  normalizePresenceSensitivity,
  PRESENCE_LAST_PASSKEY,
  PRESENCE_REQUEST_KINDS,
  presenceSensitivityId,
  presenceSensitivityRows,
  SENSITIVE_ACTIONS,
  SENSITIVE_APPROVALS,
  SENSITIVE_PROPOSAL_TYPE_PREFIXES,
  sensitivityLoosens,
  PRESENCE_WORDS,
  SENSITIVE_ACTION_TOKENS,
  sensitiveActionTitle,
  type SensitiveActionPath,
} from "./index.js";
import { catalogProblems } from "../i18n/index.js";
import { ACTION_VERBS } from "../vocabulary/index.js";

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

describe("what asks for your passkey (W5): the pod's choice", () => {
  const deletion = { targetType: "entity", proposalType: "delete" };
  const connect = { targetType: "agent", proposalType: "connect" };

  it("the default is today's lists, every row on", () => {
    const rows = presenceSensitivityRows();
    expect(
      rows.filter((r) => r.kind === "approval" && !r.prefix).map((r) => r.key)
    ).toEqual(Object.keys(SENSITIVE_APPROVALS));
    expect(rows.filter((r) => r.prefix).map((r) => r.key)).toEqual(
      Object.keys(SENSITIVE_PROPOSAL_TYPE_PREFIXES)
    );
    expect(rows.filter((r) => r.kind === "action").map((r) => r.key)).toEqual(
      Object.keys(SENSITIVE_ACTIONS)
    );
    for (const choice of [undefined, null, DEFAULT_PRESENCE_SENSITIVITY]) {
      for (const key of Object.keys(SENSITIVE_APPROVALS)) {
        const [targetType, proposalType] = key.includes("/")
          ? (key.split("/") as [string, string])
          : ["any", key];
        expect(
          sensitiveApprovalReason({ targetType, proposalType }, choice),
          key
        ).toBe(SENSITIVE_APPROVALS[key]);
      }
      for (const [path, reason] of Object.entries(SENSITIVE_ACTIONS)) {
        expect(sensitiveActionReason(path, choice), path).toBe(reason);
      }
    }
  });

  it("a row switched off is not sensitive; the rows left on still are", () => {
    const choice = normalizePresenceSensitivity({
      approvalsOff: ["entity/delete", "governance."],
      actionsOff: ["apiKeys.create"],
    });
    expect(sensitiveApprovalReason(deletion, choice)).toBeNull();
    expect(sensitiveApprovalReason(connect, choice)).toBe("setup");
    expect(
      sensitiveApprovalReason(
        {
          targetType: "governance_rule",
          proposalType: "governance.rule_create",
        },
        choice
      )
    ).toBeNull();
    expect(sensitiveActionReason("apiKeys.create", choice)).toBeNull();
    expect(sensitiveActionReason("apiKeys.rotate", choice)).toBe("setup");
    expect(sensitiveActionReason("shares.share", choice)).toBeNull();
  });

  it("a stored choice keeps only known rows, each once, sorted", () => {
    expect(
      normalizePresenceSensitivity({
        approvalsOff: [
          "workspace/delete",
          "nope/never",
          "entity/delete",
          "entity/delete",
        ],
        actionsOff: ["shares.share", "govConfig.set"],
      })
    ).toEqual({
      approvalsOff: ["entity/delete", "workspace/delete"],
      actionsOff: ["govConfig.set"],
    });
    expect(normalizePresenceSensitivity(null)).toEqual(
      DEFAULT_PRESENCE_SENSITIVITY
    );
  });

  it("switching a row off loosens; switching one back on does not", () => {
    const none = DEFAULT_PRESENCE_SENSITIVITY;
    const one = { approvalsOff: ["entity/delete"], actionsOff: [] };
    expect(sensitivityLoosens(none, one)).toBe(true);
    expect(sensitivityLoosens(one, none)).toBe(false);
    expect(sensitivityLoosens(one, one)).toBe(false);
    expect(
      sensitivityLoosens(one, {
        approvalsOff: [],
        actionsOff: ["govConfig.set"],
      })
    ).toBe(true);
  });

  it("the proof names exactly the new choice, whatever its order", async () => {
    const a = await presenceSensitivityId({
      approvalsOff: ["workspace/delete", "entity/delete"],
      actionsOff: [],
    });
    const b = await presenceSensitivityId({
      approvalsOff: ["entity/delete", "workspace/delete"],
      actionsOff: [],
    });
    const c = await presenceSensitivityId({
      approvalsOff: ["entity/delete"],
      actionsOff: [],
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(PRESENCE_REQUEST_KINDS.presence_sensitivity).toBe("governance");
    expect(isPresenceCode(PRESENCE_LAST_PASSKEY)).toBe(false);
describe("the one wording of proof of presence", () => {
  const paths = Object.keys(SENSITIVE_ACTIONS) as SensitiveActionPath[];

  it("names every sensitive action through the title door, never a raw token", () => {
    expect(paths.length).toBeGreaterThan(20);
    expect(Object.keys(SENSITIVE_ACTION_TOKENS).sort()).toEqual(
      [...paths].sort()
    );
    for (const path of paths) {
      const { action, objectKind } = SENSITIVE_ACTION_TOKENS[path];
      // A curated verb and noun: never the humanized fallback of a token.
      expect(ACTION_VERBS, path).toHaveProperty([action]);
      const en = sensitiveActionTitle(path, { locale: "en" });
      const fr = sensitiveActionTitle(path, { locale: "fr" });
      expect(en, path).not.toMatch(/[._]/);
      // French has its own noun for each: the fallback reads "l’élément X".
      expect(fr, path).not.toMatch(/élément/);
      expect(fr, path).not.toBe(en);
    }
  });

  it("reads what confirming does, in either mood", () => {
    expect(sensitiveActionTitle("apiKeys.create", { locale: "en" })).toBe(
      "Create API key"
    );
    expect(sensitiveActionTitle("apiKeys.create", { locale: "fr" })).toBe(
      "Créer la clé API"
    );
    expect(sensitiveActionTitle("secretsVault.reveal", { locale: "fr" })).toBe(
      "Voir le secret"
    );
    expect(
      sensitiveActionTitle("intelligenceRegistry.register", { locale: "en" })
    ).toBe("Connect AI service");
    expect(
      sensitiveActionTitle("apiKeys.rotate", { locale: "en", mood: "past" })
    ).toBe("Replaced API key");
  });

  it("holds every shared word in French, with the same parameters", () => {
    expect(Object.keys(PRESENCE_WORDS.en).length).toBeGreaterThan(5);
    expect(catalogProblems(PRESENCE_WORDS)).toEqual([]);
  });

  it("names the three places a person can approve, and one word for off", () => {
    const where = PRESENCE_WORDS.en["presence.where"];
    for (const place of ["pod admin", "Relay", "desktop app"]) {
      expect(where).toContain(place);
    }
    expect(PRESENCE_WORDS.en["presence.off"]).toBe("Off");
  });
});
