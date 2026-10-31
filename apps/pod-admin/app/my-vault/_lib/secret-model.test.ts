import { describe, expect, it } from "vitest";
import { createT } from "@synap-core/types/i18n";
import type { SecretGrantView, SecretUsage } from "@synap-core/types/vault";
import { SECRET_CATALOGS } from "./copy";
import {
  activityLine,
  grantState,
  granteeWords,
  listRowFor,
  secretStatus,
  splitGrants,
  usageTarget,
} from "./secret-model";

const t = createT("en", SECRET_CATALOGS);
const NOW = Date.parse("2026-10-31T12:00:00Z");

function grant(over: Partial<SecretGrantView> = {}): SecretGrantView {
  return {
    grantId: "g1",
    grantedTo: "11111111-2222-3333-4444-555555555555",
    scope: "use",
    active: true,
    ...over,
  };
}

describe("grantState", () => {
  it("is active only when nothing ended it", () => {
    expect(grantState(grant(), NOW)).toBe("active");
  });
  it("names why a grant ended", () => {
    expect(
      grantState(
        grant({ revokedAt: "2026-10-01T00:00:00Z", active: false }),
        NOW
      )
    ).toBe("revoked");
    expect(grantState(grant({ usesRemaining: 0, active: false }), NOW)).toBe(
      "exhausted"
    );
    expect(
      grantState(
        grant({ expiresAt: "2026-10-30T00:00:00Z", active: false }),
        NOW
      )
    ).toBe("expired");
  });
  it("an expiry in the past ends a grant the flag still calls active", () => {
    expect(grantState(grant({ expiresAt: "2026-10-30T00:00:00Z" }), NOW)).toBe(
      "expired"
    );
  });
});

describe("splitGrants", () => {
  it("keeps live grants apart from ended ones", () => {
    const { active, ended } = splitGrants([
      grant({ grantId: "a" }),
      grant({ grantId: "b", revokedAt: "2026-10-01T00:00:00Z", active: false }),
    ]);
    expect(active.map((g) => g.grantId)).toEqual(["a"]);
    expect(ended.map((g) => g.grantId)).toEqual(["b"]);
  });
});

describe("granteeWords", () => {
  const ID = "11111111-2222-3333-4444-555555555555";
  const WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";
  it("names an agent and a person from the owner's grants list", () => {
    const g = grant();
    expect(
      granteeWords(
        g,
        {
          grants: [
            { grantId: "g1", granteeLabel: "Scout", granteeType: "agent" },
          ],
        },
        t
      )
    ).toBe("Scout (agent)");
    expect(
      granteeWords(
        g,
        {
          grants: [{ grantId: "g1", granteeLabel: "Lea", granteeType: "user" }],
        },
        t
      )
    ).toBe("Lea");
  });
  it("a label that is only the raw id is not a name", () => {
    expect(
      granteeWords(
        grant(),
        { grants: [{ grantId: "g1", granteeLabel: ID, granteeType: "agent" }] },
        t
      )
    ).toBe("An agent (111111…5555)");
  });
  it("when the read failed, says the kind of holder it can and a short id, never 'Unknown'", () => {
    const words = granteeWords(grant(), {}, t);
    expect(words).toBe("An agent or a person (111111…5555)");
    expect(words).not.toMatch(/unknown/i);
    expect(words).not.toContain(ID);
  });
  it("a space-wide grant is named from the viewer's spaces, else by short id", () => {
    const g = grant({ grantedTo: "", workspaceId: WS });
    expect(granteeWords(g, { spaces: [{ id: WS, name: "Builder" }] }, t)).toBe(
      "Space Builder"
    );
    expect(granteeWords(g, {}, t)).toBe("A space (808939…c54e)");
  });
});

describe("secretStatus", () => {
  const none = { grants: [] };
  it("compromised outranks a live grant", () => {
    const s = secretStatus({ grants: [grant()] }, true, t);
    expect(s.kind).toBe("down");
    expect(s.label).toBe("Marked compromised");
  });
  it("a list that did not answer is not read as 'not compromised'", () => {
    expect(secretStatus(none, null, t).kind).toBe("unknown");
  });
  it("counts live grants only", () => {
    const s = secretStatus(
      {
        grants: [
          grant(),
          grant({
            grantId: "x",
            revokedAt: "2026-10-01T00:00:00Z",
            active: false,
          }),
        ],
      },
      false,
      t
    );
    expect(s.sentence).toBe(
      "1 grant lets an agent or a space use this secret."
    );
    expect(secretStatus(none, false, t).label).toBe("Only you");
  });
});

describe("listRowFor", () => {
  it("is null when the list is missing or lacks the secret", () => {
    expect(listRowFor(undefined, "a")).toBeNull();
    expect(listRowFor([], "a")).toBeNull();
    const row = { id: "a", isCompromised: false, lastAccessedAt: null };
    expect(listRowFor([row], "a")).toBe(row);
  });
});

describe("usageTarget", () => {
  const usage = (consumerType: SecretUsage["consumerType"]): SecretUsage => ({
    id: "u",
    secretId: "s",
    consumerType,
    consumerId: "c1",
    consumerLabel: "X",
  });
  it("links the kinds the console hosts and only those", () => {
    expect(usageTarget(usage("automation"))).toEqual({
      kind: "object",
      objectKind: "automation",
      id: "c1",
    });
    expect(usageTarget(usage("capability"))?.kind).toBe("object");
    expect(usageTarget(usage("connection"))).toBeNull();
    expect(usageTarget(usage("url"))).toBeNull();
  });
});

describe("activityLine", () => {
  it("says what happened and who did it, marking an agent", () => {
    expect(
      activityLine(
        {
          id: "e",
          action: "revealed",
          actorType: "agent",
          actorLabel: "Scout",
          createdAt: "2026-10-31T00:00:00Z",
        },
        t
      )
    ).toBe("Revealed by Scout (agent)");
    expect(
      activityLine(
        {
          id: "e",
          action: "created",
          actorType: "user",
          actorLabel: "Lea",
          createdAt: "2026-10-31T00:00:00Z",
        },
        t
      )
    ).toBe("Created by Lea");
  });
});
