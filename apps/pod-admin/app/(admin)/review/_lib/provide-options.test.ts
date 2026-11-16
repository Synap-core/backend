import { describe, expect, it } from "vitest";
import { ASK_COPY } from "@synap-core/types/ask";
import {
  connectedReceipt,
  provideReceipt,
  provideSheet,
  secretCard,
  secretUseView,
  type ProvideOptions,
} from "./provide-options";

const base = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  expectedLabel: "Stripe key",
  askFingerprint: "fp",
};

function secret(
  rows: Array<{ ref: string; name: string; type: string }>,
  grant: Extract<ProvideOptions, { kind: "secret" }>["secret"]["grant"]
): ProvideOptions {
  return {
    ...base,
    kind: "secret",
    secret: { name: "Stripe key", rows, grant },
  };
}

function connection(
  over: Partial<Extract<ProvideOptions, { kind: "connection" }>["connection"]>
): ProvideOptions {
  return {
    ...base,
    kind: "connection",
    connection: {
      service: "stripe",
      serviceName: "Stripe",
      providerId: "stripe",
      connectable: true,
      unavailable: null,
      rows: [],
      confirmAccount: false,
      ...over,
    },
  };
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: "Stripe",
  accountHint: null as string | null,
  podWide: false,
  isDefault: false,
  needsReauth: false,
  ...over,
});

describe("provideSheet · secret: the person's existing secrets only", () => {
  it("lists the person's secrets, pre-picks the one named as asked, and says who may read it", () => {
    const sheet = provideSheet(
      secret(
        [
          { ref: "vault://a", name: "Stripe key", type: "api_key" },
          { ref: "vault://b", name: "GitHub token", type: "token" },
        ],
        {
          status: "will_grant",
          agentUserId: "agent-scout",
          agentName: "Scout",
          minutes: 60,
        }
      )
    );
    expect(sheet).toEqual({
      kind: "secret",
      name: "Stripe key",
      choices: [
        {
          ref: "vault://a",
          name: "Stripe key",
          type: "api key",
          standingGrant: null,
        },
        {
          ref: "vault://b",
          name: "GitHub token",
          type: "token",
          standingGrant: null,
        },
      ],
      initialRef: "vault://a",
      grantNote: ASK_COPY.provideGrantNote("Scout", 60),
      // Sent back on the answer: the read goes to Scout or to no one.
      expectedGranteeId: "agent-scout",
      grant: {
        status: "will_grant",
        agentUserId: "agent-scout",
        agentName: "Scout",
        minutes: 60,
      },
      agentName: "Scout",
      // An ask posed before purposes existed: said, never inferred.
      purpose: null,
      // The card's default: this session only.
      uses: "session",
    });
  });

  it("no pre-pick when no name or several names match; no agent known → no read yet", () => {
    const sheet = provideSheet(
      secret(
        [
          { ref: "vault://a", name: "stripe key", type: "api_key" },
          { ref: "vault://b", name: "Stripe Key", type: "api_key" },
        ],
        { status: "no_grant", reason: "agent_unknown" }
      )
    );
    expect(sheet).toMatchObject({
      initialRef: null,
      grantNote: ASK_COPY.provideNoGrantNote,
      expectedGranteeId: null,
    });
  });
});

describe("provideSheet · connection", () => {
  it("one account: pre-picked, its account named, no confirm", () => {
    const sheet = provideSheet(
      connection({ rows: [row("c1", { accountHint: "ops@acme.io" })] })
    );
    expect(sheet).toEqual({
      kind: "connection",
      serviceName: "Stripe",
      choices: [
        {
          id: "c1",
          label: "ops@acme.io",
          detail: "Stripe",
          podWide: false,
          usable: true,
        },
      ],
      confirmAccount: false,
      initialId: "c1",
      connectProviderId: "stripe",
      unavailable: null,
    });
  });

  it("several accounts: the person confirms which — nothing is pre-picked", () => {
    const sheet = provideSheet(
      connection({
        rows: [row("c1"), row("c2", { podWide: true, needsReauth: true })],
        confirmAccount: true,
      })
    );
    expect(sheet).toMatchObject({ confirmAccount: true, initialId: null });
    expect(sheet.kind === "connection" && sheet.choices[1]).toEqual({
      id: "c2",
      label: "Stripe",
      detail: "Shared with the pod · Needs signing in again",
      podWide: true,
      usable: false,
    });
  });

  it("one signed-out account: shown, never pre-picked", () => {
    const sheet = provideSheet(
      connection({ rows: [row("c1", { needsReauth: true })] })
    );
    expect(sheet).toMatchObject({ confirmAccount: false, initialId: null });
    expect(sheet.kind === "connection" && sheet.choices[0]?.usable).toBe(false);
  });

  it("a new connection can't start here: no connect, the reason in words", () => {
    for (const [unavailable, words] of [
      [
        "no_broker",
        "This pod can't connect accounts yet. A pod admin sets that up.",
      ],
      [
        "not_offered",
        "This pod does not offer a Stripe connection yet. A pod admin can add it.",
      ],
      [
        "unreadable",
        "Couldn't check which connections this pod offers. Try again in a moment.",
      ],
    ] as const) {
      expect(
        provideSheet(
          connection({ connectable: false, providerId: null, unavailable })
        )
      ).toMatchObject({ connectProviderId: null, unavailable: words });
    }
  });
});

describe("provideSheet · file", () => {
  it("ready: where it lands, the project it is filed into, the asked types", () => {
    const sheet = provideSheet({
      ...base,
      kind: "file",
      file: {
        accept: [".pdf"],
        landing: {
          status: "ready",
          workspaceId: "w1",
          workspaceName: "Finance",
          projectId: "p1",
          via: "project_home",
        },
      },
    });
    expect(sheet).toEqual({
      kind: "file",
      accept: [".pdf"],
      landing: {
        ok: true,
        workspaceId: "w1",
        projectId: "p1",
        landsIn: ASK_COPY.provideLandsIn("Finance"),
        keptIfRefused: ASK_COPY.provideUploadKept("Finance"),
      },
    });
  });

  it("refused: the pod's words, plainly; an empty accept is no constraint", () => {
    const message =
      "This session has no space and its project has no home space.";
    expect(
      provideSheet({
        ...base,
        kind: "file",
        file: { accept: [], landing: { status: "refused", message } },
      })
    ).toEqual({ kind: "file", accept: null, landing: { ok: false, message } });
  });
});

describe("provideReceipt", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  it("a secret: who can read it now, in the pod's line", () => {
    expect(
      provideReceipt(
        "secret",
        {
          secretGrant: {
            status: "granted",
            agentUserId: "a1",
            agentName: "Scout",
            expiresAt: "2026-10-19T13:00:00Z",
          },
        },
        now
      )
    ).toEqual({
      title: "Secret handed over",
      description: "Scout can read it for 60 minutes, in this session",
    });
    for (const secretGrant of [
      { status: "refused", reason: "agent_unknown" } as const,
      { status: "failed" } as const,
      undefined,
    ]) {
      expect(provideReceipt("secret", { secretGrant }, now).description).toBe(
        "No agent can read it yet"
      );
    }
  });

  it("a secret whose asking agent changed: nobody can read it, said plainly", () => {
    expect(
      provideReceipt(
        "secret",
        { secretGrant: { status: "refused", reason: "agent_changed" } },
        now
      )
    ).toEqual({
      title: ASK_COPY.provideAgentChangedTitle,
      description: ASK_COPY.provideAgentChangedBody,
      color: "warning",
    });
  });

  it("a connection, a file, a connect the pod answered", () => {
    expect(provideReceipt("connection", {}, now)).toEqual({
      title: "Connection handed over",
    });
    expect(provideReceipt("file", {}, now)).toEqual({
      title: "File handed over",
    });
    expect(connectedReceipt("Stripe").title).toBe("Stripe connected");
  });
});

describe("secretCard · the honest secret card (plan d717d6ac §4)", () => {
  const grant = {
    status: "will_grant" as const,
    agentUserId: "a1",
    agentName: "Claude Code",
    minutes: 60,
    uses: "session" as const,
  };
  const withPurpose = (
    purpose: unknown,
    rows = [{ ref: "vault://s1", name: "GITHUB_TOKEN", type: "api_key" }]
  ) =>
    provideSheet({
      ...base,
      kind: "secret",
      secret: { name: "GITHUB_TOKEN", rows, grant, purpose },
    } as unknown as ProvideOptions);

  it("says what the agent declared: for, used by, on, and this session only by default", () => {
    const sheet = withPurpose({
      for: "Merging the delivery PR",
      tool: "GitHub tool",
      action: "merge",
      on: "Synap-core/backend",
    });
    if (sheet.kind !== "secret") throw new Error("secret sheet");
    const card = secretCard(sheet, "vault://s1", sheet.uses);
    expect(card.purpose).toEqual({
      for: "Merging the delivery PR",
      tool: "GitHub tool",
      action: "merge",
      on: "Synap-core/backend",
    });
    expect(card.usedBy).toBe("Claude Code");
    expect(card.until).toBe("session");
    expect(card.canPickUses).toBe(true);
    expect(card.note).toBe(ASK_COPY.provideGrantNote("Claude Code", 60));
  });

  it("no purpose: nothing inferred, the card says the agent did not say", () => {
    const sheet = withPurpose(null);
    if (sheet.kind !== "secret") throw new Error("secret sheet");
    expect(secretCard(sheet, "vault://s1", "session").purpose).toBeNull();
  });

  it("one read, when the person picks it", () => {
    const sheet = withPurpose(null);
    if (sheet.kind !== "secret") throw new Error("secret sheet");
    const card = secretCard(sheet, "vault://s1", "once");
    expect(card.until).toBe("once");
    expect(card.note).toBe(ASK_COPY.provideGrantOnceNote("Claude Code", 15));
  });

  it("a standing grant on the picked secret is said as such, never as an hour", () => {
    const sheet = withPurpose(null, [
      {
        ref: "vault://s1",
        name: "GITHUB_TOKEN",
        type: "api_key",
        standingGrant: { grantId: "g1", useCount: 3 },
      } as never,
    ]);
    if (sheet.kind !== "secret") throw new Error("secret sheet");
    const card = secretCard(sheet, "vault://s1", "session");
    expect(card.until).toBe("standing");
    expect(card.canPickUses).toBe(false);
    expect(card.note).toBe(ASK_COPY.provideStandingGrantNote("Claude Code"));
  });
});

describe("secretUseView · what became of a handed-over secret", () => {
  const use = {
    secretName: "GITHUB_TOKEN",
    agentName: "Claude Code",
    uses: "session" as const,
    expiresAt: "2026-11-16T15:00:00.000Z",
    active: true,
    useCount: 2,
    lastUsedAt: "2026-11-16T14:02:00.000Z",
    takeBack: { door: "secretsVault.revokeGrant", grantId: "g1" },
  };
  it("reads how often, when last, until when, and offers Take back", () => {
    expect(secretUseView(use)).toEqual({
      secretName: "GITHUB_TOKEN",
      agentName: "Claude Code",
      useCount: 2,
      lastUsedAt: "2026-11-16T14:02:00.000Z",
      until: "session",
      takeBack: { grantId: "g1" },
    });
  });
  it("nothing left to take back once it ended", () => {
    expect(secretUseView({ ...use, active: false }).takeBack).toBeNull();
  });
});
