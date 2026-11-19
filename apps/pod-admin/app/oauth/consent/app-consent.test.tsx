/**
 * A pod app's consent as design A draws it, rendered (react-dom/server;
 * pod-admin's vitest runs in node), one test per state of the design: first
 * connect, re-consent, asks for something you can't give, Allow failed,
 * loading, read failed; and the content of each line's sheet ("It can",
 * "In" with and without projects, "It changes things in"). The sheets are
 * overlays (closed at rest), so their content is rendered on its own.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ComponentProps, ReactElement } from "react";
import { Card } from "@heroui/react";

// CreateSpace (no space to give) reads its mutation; nothing is sent here.
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    workspaces: {
      ensureTemplate: {
        useMutation: () => ({ mutate: () => {}, isPending: false }),
      },
    },
  },
}));

import {
  AppConsent,
  ConsentSkeleton,
  ReadFailed,
  type Step,
} from "./ConsentForm";
import { CanChoices, InChoices, WriteChoices } from "./AccessChoices";
import {
  canRows,
  draftBlockedReason,
  firstDraft,
  heldAccessOf,
  offerOf,
  reconsentDraft,
  setReadSpacesMode,
  toggleReadSpace,
  type ConsentDraft,
} from "./consent-access";

type App = ComponentProps<typeof AppConsent>["app"];

const BUILDER = {
  workspaceId: "w-builder",
  workspaceName: "Builder",
  templateSlug: null,
};
const CONTENT = {
  workspaceId: "w-content",
  workspaceName: "Content OS",
  templateSlug: "content-os",
};
const ECO = {
  workspaceId: "w-eco",
  workspaceName: "Ecosystem",
  templateSlug: "ecosystem",
};
const FINANCE = {
  workspaceId: "w-finance",
  workspaceName: "Finance",
  templateSlug: null,
};

const KINDS = ["task", "person", "deal"];
const GROUP = { permission: "entity.read", kinds: KINDS };

const base = {
  verified: true,
  actsAs: { kind: "person" as const, note: "It acts as you." },
  homepage: null,
  approved: [],
  podWideKinds: ["person"],
  ignoredScopes: [],
  ask: null,
};

/** synap-chat: kinds read pod-wide in one request, sessions edited, no templates. */
const CHAT = {
  ...base,
  domain: "chat.synap.live",
  permissions: [
    {
      permission: "session.update",
      workspaces: [BUILDER, CONTENT],
      reason: "To answer a run, as you.",
    },
    {
      permission: "track.read",
      workspaces: [BUILDER, CONTENT, FINANCE],
      reason: null,
    },
    {
      permission: "proposal.approve",
      workspaces: [BUILDER, CONTENT],
      reason: null,
    },
  ],
  podWide: [
    ...KINDS.map((k) => ({
      permission: `entity.${k}.read`,
      reason: "To show records.",
      kindGroup: GROUP,
    })),
    { permission: "session.read", reason: null, kindGroup: null },
  ],
  templates: [],
} as unknown as App;

/** Content Studio: template spaces, posts edited. */
const STUDIO = {
  ...base,
  domain: "studio.synap.live",
  permissions: [
    {
      permission: "entity.post.read",
      workspaces: [BUILDER, CONTENT, ECO],
      reason: null,
    },
    {
      permission: "entity.post.create",
      workspaces: [BUILDER, CONTENT, ECO],
      reason: "To draft your posts.",
    },
    {
      permission: "document.read",
      workspaces: [BUILDER, CONTENT, ECO],
      reason: null,
    },
  ],
  podWide: [],
  templates: ["content-os", "ecosystem"],
} as unknown as App;

const html = (el: ReactElement) => render(<Card>{el}</Card>);

function consent(
  app: App,
  draft?: ConsentDraft,
  step: Step = { kind: "idle" }
) {
  const offer = offerOf(app);
  const d = draft ?? reconsentDraft(heldAccessOf(app.approved), offer);
  return html(
    <AppConsent
      app={app}
      appName={
        app.domain === "chat.synap.live" ? "Synap Chat" : "Content Studio"
      }
      registeredAt={new Date("2026-10-01T00:00:00Z")}
      redirectHost={app.domain}
      draft={d}
      onDraft={() => {}}
      onSpaceCreated={() => {}}
      busy={false}
      step={step}
      blockedReason={draftBlockedReason(
        d,
        offer,
        canRows(offer, app.actsAs.kind)
      )}
      onDecide={() => {}}
    />
  );
}

/** The Allow button's markup. */
function allow(out: string): string {
  const at = out.search(/>(Allow|Confirm|Try again)</);
  expect(at).toBeGreaterThan(-1);
  const open = out.lastIndexOf("<button", at);
  return out.slice(open, out.indexOf(">", open) + 1);
}

describe("first connect (design A)", () => {
  it("three lines with one door each; the headline is live; the matrix and the pod-wide section are gone", () => {
    const out = consent(CHAT);
    expect(out.match(/data-line="(can|in|write)"/g)).toEqual([
      'data-line="can"',
      'data-line="in"',
      'data-line="write"',
    ]);
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain(">Review<");
    expect(out.match(/aria-haspopup="dialog"/g)).toHaveLength(3);
    expect(out).toContain(
      "Every space and every project, including ones you create later"
    );
    expect(out).toMatch(/View<\/span> records \(3 kinds\)/);
    expect(out).not.toContain("Customize");
    expect(out).not.toContain("Everywhere in your pod</p>");
  });

  it("no template: nothing is picked for its changes, the line asks with a dot, and Allow says why", () => {
    const out = consent(CHAT);
    expect(out).toContain("Pick where");
    expect(out).toContain("Synap Chat declared no space for its changes.");
    expect(out).toContain(">Pick<");
    const button = allow(out);
    expect(button).toContain("disabled");
    expect(button).toMatch(/aria-describedby="[^"]+-blocked"/);
    expect(out).toContain(
      "Pick where it can make changes, or set Jobs to View."
    );
  });

  it("templates: its template spaces are picked; Allow may be pressed", () => {
    const out = consent(STUDIO);
    expect(out).toContain("Content OS and Ecosystem");
    expect(allow(out)).not.toContain("disabled");
    expect(out).toContain(">Allow<");
    expect(out).toContain(">Decline<");
    expect(out).not.toContain("data-reconsent");
  });

  it("the trust facts stay: who it acts as, where it sends you back, when it was first seen; revoking is said once", () => {
    const out = consent(STUDIO);
    expect(out).toContain("It acts as you.");
    expect(out).toContain("Sends you back to");
    expect(out).toContain("First seen");
    expect(out.match(/Revoking there stops it in every browser/g)).toHaveLength(
      1
    );
  });
});

describe("re-consent", () => {
  const current = [
    { permission: "entity.post.read", workspaceId: "w-content" },
    { permission: "document.read", workspaceId: "w-eco" },
  ];
  const app = { ...STUDIO, approved: current } as unknown as App;

  it("says what changes first, each with now / was and one narrowing door; Confirm / Not now; lines marked Changed", () => {
    const out = consent(app);
    expect(out).toContain("data-reconsent");
    expect(out).toMatch(/changes? to confirm/);
    expect(out).toContain("was in Content OS");
    expect(out).toMatch(/>Turn [a-z]+ off</);
    expect(out).toContain("Everything else stays as you allowed it.");
    expect(out).toContain(">Confirm<");
    expect(out).toContain(">Not now<");
    expect(out.match(/>Changed</g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("what it newly asks is listed with its reason, and its switch starts off", () => {
    const out = consent(app);
    expect(out).toMatch(/new requests? since you last allowed/);
    expect(out).toContain("Create posts");
    expect(out).toContain("To draft your posts.");
    expect(out).toMatch(/Allow the new ones/);
    expect(out).not.toMatch(/<input[^>]*role="switch"[^>]*checked/);
  });
});

describe("asks for something you can't give", () => {
  it("folds them with a count, each with its reason and a Not given mark, never a disabled toggle", () => {
    const app = {
      ...STUDIO,
      ignoredScopes: ["*"],
      permissions: [
        ...(STUDIO.permissions as unknown[]),
        { permission: "agent.read", workspaces: [], reason: null },
      ],
    } as unknown as App;
    const out = consent(app);
    expect(out).toContain("It also asked for 2 things you can’t give");
  });
});

describe("Allow failed", () => {
  it("a danger alert above the buttons, the choices kept, Allow becomes Try again", () => {
    const out = consent(STUDIO, undefined, {
      kind: "error",
      message: "Pod did not answer",
    });
    expect(out).toContain('role="alert"');
    expect(out).toContain("Couldn’t connect Content Studio");
    expect(out).toContain("Nothing was given. Your choices are kept.");
    expect(out).toContain(">Try again<");
    expect(out).toContain('data-line="in"');
  });
});

describe("loading and read failed", () => {
  it("loading draws the shape of the real lines, busy, with a status for screen readers", () => {
    const out = html(<ConsentSkeleton />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Loading what this app asks for");
  });

  it("read failed: the retry inside the failure, saying nothing was given", () => {
    const out = html(
      <ReadFailed
        onRetry={() => {}}
        retrying={false}
        onDecline={() => {}}
        busy={false}
      />
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain("Couldn’t read what this app asks for");
    expect(out).toContain("Nothing was given.");
    expect(out).toContain(">Try again<");
    expect(out).toContain("Decline and go back");
  });
});

describe("the sheets' choices", () => {
  it("It can: the kinds as ONE row with its count and level; each other row its level; reasons and raw permissions", () => {
    const offer = offerOf(CHAT);
    const rows = canRows(offer, "person");
    const out = html(
      <CanChoices
        rows={rows}
        draft={firstDraft(offer)}
        actsAs="person"
        appName="Synap Chat"
        podWideKinds={["person"]}
        onChange={() => {}}
      />
    );
    expect(out).toContain('data-object="records"');
    expect(out).toContain("3 kinds");
    expect(out).toContain("All 3 kinds it asked for");
    expect(out).toContain("Records: access");
    expect(out).toContain("To answer a run, as you.");
    expect(out).toContain("session.update");
    expect(out).toContain("Turn off anything you don’t want.");
    // The decision row is its own, Off.
    expect(out).toContain("Let it decide for you");
  });

  it("In: All spaces with its hint, and every project included under All", () => {
    const offer = offerOf({
      ...CHAT,
      permissions: (
        CHAT.permissions as unknown as Array<Record<string, unknown>>
      ).map((p) => ({
        ...p,
        projects: [
          {
            projectId: "p-launch",
            projectName: "Launch v1",
            workspaceId: "w-builder",
          },
        ],
      })),
    } as unknown as App);
    const rows = canRows(offer, "person");
    const all = html(
      <InChoices
        draft={firstDraft(offer)}
        offer={offer}
        rows={rows}
        onChange={() => {}}
      />
    );
    expect(all).toContain("All spaces");
    expect(all).toContain("Includes spaces you create later.");
    expect(all).toContain("Only the spaces I pick");
    expect(all).toContain("Every project is included");
    // A read with no pod-wide form is named, never dropped silently.
    expect(all).toContain("With all spaces it still cannot see goals");

    const picked = toggleReadSpace(
      setReadSpacesMode(firstDraft(offer), offer, "pick"),
      "w-builder"
    );
    const pick = html(
      <InChoices draft={picked} offer={offer} rows={rows} onChange={() => {}} />
    );
    expect(pick).toContain("Builder");
    expect(pick).toContain("Finance");
    expect(pick).toContain("All projects");
    expect(pick).toContain("Only the projects I pick");
    expect(pick).toContain("No projects");
  });

  it("In, person has no projects: All (none yet, includes later) and No projects; never a disabled pick", () => {
    const offer = offerOf({
      ...STUDIO,
      permissions: (
        STUDIO.permissions as unknown as Array<Record<string, unknown>>
      ).map((p) => ({ ...p, projects: [] })),
    } as unknown as App);
    const out = html(
      <InChoices
        draft={firstDraft(offer)}
        offer={offer}
        rows={canRows(offer, "person")}
        onChange={() => {}}
      />
    );
    expect(out).toContain(
      "You have no projects yet. This includes the ones you create later."
    );
    expect(out).toContain("No projects");
    expect(out).not.toContain("Only the projects I pick");
  });

  it("In, before the server offers projects: the Projects choice is omitted, not guessed", () => {
    const offer = offerOf(STUDIO);
    const out = html(
      <InChoices
        draft={firstDraft(offer)}
        offer={offer}
        rows={canRows(offer, "person")}
        onChange={() => {}}
      />
    );
    expect(out).not.toContain("All projects");
  });

  it("It changes things in: only places it may change; view-only spaces named once; no everywhere", () => {
    const offer = offerOf(CHAT);
    const out = html(
      <WriteChoices
        draft={firstDraft(offer)}
        offer={offer}
        onChange={() => {}}
      />
    );
    expect(out).toContain("Builder");
    expect(out).toContain("Content OS");
    expect(out).toContain("Finance isn’t listed: you can only view it.");
    expect(out).toContain("There is no “everywhere” for changes.");
  });
});
