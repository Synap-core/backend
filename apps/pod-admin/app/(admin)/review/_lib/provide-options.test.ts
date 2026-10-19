import { describe, expect, it } from "vitest";
import { ASK_COPY } from "@synap-core/types/ask";
import {
  connectedReceipt,
  provideReceipt,
  provideSheet,
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

describe("provideSheet · secret (P1: existing secrets only)", () => {
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
        { ref: "vault://a", name: "Stripe key", type: "api key" },
        { ref: "vault://b", name: "GitHub token", type: "token" },
      ],
      initialRef: "vault://a",
      grantNote: ASK_COPY.provideGrantNote("Scout", 60),
      // Sent back on the answer: the read goes to Scout or to no one.
      expectedGranteeId: "agent-scout",
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

describe("provideSheet · connection (P4)", () => {
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
          title: "ops@acme.io",
          detail: "Stripe",
          needsReauth: false,
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
      title: "Stripe",
      detail: "Shared with the pod · Needs signing in again",
      needsReauth: true,
    });
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

describe("provideSheet · file (P3)", () => {
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

describe("provideReceipt (P2)", () => {
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
