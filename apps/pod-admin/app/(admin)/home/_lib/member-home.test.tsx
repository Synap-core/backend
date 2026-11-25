import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogProblems, type Locale } from "@synap-core/types/i18n";

import { routeAccess } from "../../../../lib/route-policy";
import { MAX_FRAMED_ENTITY_CARDS } from "../../../_lib/object/content/embed-view";
import type {
  HistoryProposal,
  HistoryRow,
} from "../../history/_lib/history-rows";
import { en, fr } from "./copy";
import {
  DoneForYouCardView,
  MadeForYouCardView,
  MyAccessCardView,
} from "./member-cards";
import {
  ARTIFACTS_CAP,
  artifactRows,
  cardState,
  computerRow,
  keyRow,
  RECEIPTS_ALL_HREF,
  RECEIPTS_CAP,
  RECEIPTS_INPUT,
  receiptRows,
  spaceRows,
  type ArtifactFacts,
  type ArtifactRow,
  type CardState,
} from "./member-home-model";

// The console's language comes from `users.me` through a provider that reads
// the pod; here the test sets it. Every card's words go through `useT`.
const locale = vi.hoisted(() => ({ current: "en" as Locale }));
vi.mock("../../../../lib/i18n/locale-provider", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const i18n = await import("@synap-core/types/i18n");
  return {
    ...actual,
    useConsoleLocale: () => locale.current,
    useT: (catalogs: Parameters<typeof i18n.createT>[1]) =>
      i18n.createT(locale.current, catalogs),
  };
});
afterEach(() => {
  locale.current = "en";
});

// The renderer host reads the pod; here it only says what it was asked to
// frame, and draws the fallback it was given.
vi.mock("../../../_lib/object/content/rendered-object", () => ({
  RenderedObject: ({
    subject,
    fallback,
  }: {
    subject: { entityId: string; slot: string };
    fallback: ReactNode;
  }) => (
    <div data-framed={subject.entityId} data-slot={subject.slot}>
      {fallback}
    </div>
  ),
}));

const ME = "user-me";
const OTHER = "user-other";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function artifact(over: Partial<ArtifactFacts> & { n: number }): ArtifactFacts {
  const { n, ...rest } = over;
  return {
    id: `a${n}`,
    kind: "entity",
    refId: uuid(n),
    title: `Thing ${n}`,
    workspaceId: "ws-1",
    userId: ME,
    originKind: "agent",
    state: "kept",
    entityProfile: { slug: "decision", displayName: "Decision", icon: null },
    ...rest,
  };
}

function proposal(n: number, status = "approved"): HistoryProposal {
  return {
    id: uuid(100 + n),
    status,
    proposalType: "create",
    targetType: "note",
    targetName: `Note ${n}`,
    reviewedAt: new Date(Date.UTC(2026, 10, 20, 10, n)),
    agentActorName: "Scout",
  };
}

/** The path a door opens, without its query. */
const pathOf = (href: string) => href.split(/[?#]/)[0]!;

describe("cardState: five facts, never folded", () => {
  const project = (d: number[]) => (d.length ? d : null);

  it("is loading while the first read is in flight", () => {
    expect(
      cardState(
        { isError: false, data: undefined, fetchStatus: "fetching" },
        project
      )
    ).toEqual({ kind: "loading" });
  });

  it("is offline when the read waits for the network", () => {
    expect(
      cardState(
        { isError: false, data: undefined, fetchStatus: "paused" },
        project
      )
    ).toEqual({ kind: "offline" });
  });

  it("is failed when the read failed, even over an older answer", () => {
    expect(cardState({ isError: true, data: undefined }, project)).toEqual({
      kind: "failed",
    });
    expect(cardState({ isError: true, data: [1] }, project)).toEqual({
      kind: "failed",
    });
  });

  it("is empty only when the pod answered nothing", () => {
    expect(cardState({ isError: false, data: [] }, project)).toEqual({
      kind: "empty",
    });
  });

  it("keeps an answer held from before going offline", () => {
    expect(
      cardState({ isError: false, data: [2], fetchStatus: "paused" }, project)
    ).toEqual({ kind: "ready", value: [2] });
  });
});

describe("My access", () => {
  it("lists each space with the viewer's role in words and its own page", () => {
    const rows = spaceRows([
      { id: uuid(1), name: "Sales", role: "editor" },
      { id: uuid(2), name: "Ops", role: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ name: "Sales", role: "Editor" }),
      expect.objectContaining({ name: "Ops", role: null }),
    ]);
    expect(rows![0]!.href).toContain(uuid(1));
    expect(spaceRows([])).toBeNull();
  });

  it("counts only the keys still in use", () => {
    expect(
      keyRow([
        { id: "k1", isActive: true, revokedAt: null },
        { id: "k2", isActive: false, revokedAt: null },
        { id: "k3", isActive: true, revokedAt: "2026-11-01T00:00:00Z" },
      ]).count
    ).toBe(1);
  });

  it("draws zero computers as an answer with its door, never as empty", () => {
    expect(computerRow([])).toEqual({ count: 0, href: "/my-computers" });
  });
});

describe("Made for you: what an AI made for this viewer", () => {
  it("keeps only rows an agent produced for the viewer", () => {
    const rows = artifactRows(
      [
        artifact({ n: 1 }),
        artifact({ n: 2, userId: OTHER }),
        artifact({ n: 3, originKind: "user" }),
        artifact({ n: 4, state: "swept" }),
        artifact({ n: 5, entityProfile: undefined }),
        artifact({ n: 6, refId: "not-a-uuid" }),
        artifact({ n: 7, kind: "document", entityProfile: undefined }),
      ],
      ME
    );
    expect(rows?.map((r) => r.id)).toEqual(["a1", "a7"]);
    expect(rows![0]!.card).toEqual({
      entityId: uuid(1),
      profileSlug: "decision",
      icon: null,
    });
    expect(rows![0]!.noun).toBe("Decision");
    expect(rows![1]!.card).toBeNull();
  });

  it("draws one object once, however many sessions recorded it", () => {
    const rows = artifactRows(
      [artifact({ n: 1 }), { ...artifact({ n: 1 }), id: "again" }],
      ME
    );
    expect(rows).toHaveLength(1);
  });

  it("is empty when nothing was made for the viewer", () => {
    expect(artifactRows([artifact({ n: 1, userId: OTHER })], ME)).toBeNull();
  });
});

describe("Done for you: History's rows, AI only", () => {
  it("asks History's read narrowed to agents, bookkeeping left out", () => {
    expect(RECEIPTS_INPUT).toMatchObject({
      status: "all",
      agentOnly: true,
      excludeBookkeeping: true,
    });
  });

  it("drops pending requests and caps the rest", () => {
    const rows = receiptRows([
      proposal(0, "pending"),
      ...Array.from({ length: RECEIPTS_CAP + 3 }, (_, i) => proposal(i + 1)),
    ]);
    expect(rows).toHaveLength(RECEIPTS_CAP);
    expect(rows!.every((r) => r.status !== "pending")).toBe(true);
    expect(receiptRows([proposal(0, "pending")])).toBeNull();
  });
});

describe("every door the member cards offer opens for a member", () => {
  it("leads only to signed-in pages (never an admin page a member is 403'd on)", () => {
    const hrefs = [
      ...(spaceRows([{ id: uuid(1), name: "Sales" }]) ?? []).map((r) => r.href),
      computerRow([]).href,
      keyRow([]).href,
      ...(
        artifactRows(
          [
            artifact({ n: 1 }),
            artifact({ n: 2, kind: "document", entityProfile: undefined }),
            artifact({ n: 3, kind: "view", entityProfile: undefined }),
          ],
          ME
        ) ?? []
      ).map((r) => r.href),
      ...(receiptRows([proposal(1)]) ?? []).map((r) => r.href),
      RECEIPTS_ALL_HREF,
    ];
    // Non-vacuity: each population produced its doors.
    expect(hrefs).toHaveLength(8);
    const refused = hrefs.filter((h) => routeAccess(pathOf(h)) !== "signed-in");
    expect(refused).toEqual([]);
  });
});

describe("the cards draw every state apart", () => {
  const ready = <T,>(value: T): CardState<T> => ({ kind: "ready", value });
  const noop = () => {};
  const access = (state: CardState<never>, skeleton = false) =>
    renderToStaticMarkup(
      <MyAccessCardView
        spaces={state}
        computers={state}
        keys={state}
        skeleton={skeleton}
        onRetry={{ spaces: noop, computers: noop, keys: noop }}
        onOpen={noop}
      />
    );

  it("draws no skeleton before 300 ms, then the rows' shape", () => {
    expect(access({ kind: "loading" })).not.toContain("shimmer-pulse");
    expect(access({ kind: "loading" }, true)).toContain("shimmer-pulse");
  });

  it("says a failed read failed, with Retry, never the empty words", () => {
    const out = access({ kind: "failed" });
    expect(out).toContain(en["access.spaces.failed"]);
    expect(out).toContain(en["access.computers.failed"]);
    expect(out).toContain("Retry");
    expect(out).not.toContain(en["access.spaces.empty"]);
  });

  it("says offline apart from failed and empty", () => {
    const out = access({ kind: "offline" });
    expect(out).toContain(en.offline);
    expect(out).not.toContain(en["access.spaces.failed"]);
    expect(out).not.toContain(en["access.spaces.empty"]);
  });

  it("explains an empty space list", () => {
    expect(access({ kind: "empty" })).toContain(en["access.spaces.empty"]);
  });

  it("shows the first spaces, then Show all", () => {
    const spaces = ready(
      spaceRows(
        Array.from({ length: 5 }, (_, i) => ({ id: uuid(i), name: `S${i}` }))
      )!
    );
    const out = renderToStaticMarkup(
      <MyAccessCardView
        spaces={spaces}
        computers={ready(computerRow([]))}
        keys={ready(keyRow([]))}
        skeleton={false}
        onRetry={{ spaces: noop, computers: noop, keys: noop }}
        onOpen={noop}
      />
    );
    expect(out).toContain("S2");
    expect(out).not.toContain("S3");
    expect(out).toContain("Show all 5 spaces");
    expect(out).toContain("None connected yet");
    expect(out).toContain("No key in use");
  });

  const made = (state: CardState<ArtifactRow[]>) =>
    renderToStaticMarkup(
      <MadeForYouCardView state={state} skeleton={false} onRetry={noop} />
    );

  it("frames at most the first record; every other row is its identity card", () => {
    const rows = artifactRows(
      [
        artifact({ n: 1 }),
        artifact({ n: 2, kind: "document", entityProfile: undefined }),
        artifact({ n: 3 }),
        ...Array.from({ length: ARTIFACTS_CAP }, (_, i) =>
          artifact({ n: 10 + i })
        ),
      ],
      ME
    )!;
    const out = made(ready(rows));
    const frames = out.match(/data-framed="/g) ?? [];
    expect(frames).toHaveLength(MAX_FRAMED_ENTITY_CARDS);
    expect(out).toContain(`data-framed="${uuid(1)}"`);
    expect(out).toContain('data-slot="entity-card"');
    // Every shown row is a door to its own page, framed or not.
    for (const r of rows.slice(0, ARTIFACTS_CAP)) expect(out).toContain(r.href);
    expect(out).not.toContain(rows[ARTIFACTS_CAP]!.title);
    expect(out).toContain(`Show all ${rows.length}`);
  });

  it("says why Made for you is empty, and a failure apart", () => {
    expect(made({ kind: "empty" })).toContain(en["artifacts.empty"]);
    const failed = made({ kind: "failed" });
    expect(failed).toContain(en["artifacts.failed"]);
    expect(failed).not.toContain(en["artifacts.empty"]);
  });

  const done = (state: CardState<HistoryRow[]>) =>
    renderToStaticMarkup(
      <DoneForYouCardView
        state={state}
        skeleton={false}
        onRetry={noop}
        onOpen={noop}
      />
    );

  it("lists receipts in History's words, with History as its one door", () => {
    const out = done(ready(receiptRows([proposal(1), proposal(2)])!));
    expect(out).toContain("Note 1");
    expect(out).toContain(`href="${RECEIPTS_ALL_HREF}"`);
  });

  it("says why Done for you is empty, and a failure apart", () => {
    expect(done({ kind: "empty" })).toContain(en["receipts.empty"]);
    expect(done({ kind: "failed" })).toContain(en["receipts.failed"]);
    expect(done({ kind: "offline" })).toContain(en.offline);
  });
});

describe("the cards speak French to a French reader", () => {
  it("says Retry and a count in French", () => {
    locale.current = "fr";
    const noop = () => {};
    const failed = renderToStaticMarkup(
      <MyAccessCardView
        spaces={{ kind: "failed" }}
        computers={{ kind: "failed" }}
        keys={{ kind: "failed" }}
        skeleton={false}
        onRetry={{ spaces: noop, computers: noop, keys: noop }}
        onOpen={noop}
      />
    );
    expect(failed).toContain("Réessayer");
    expect(failed).toContain(fr["access.spaces.failed"]);
    expect(failed).not.toContain("Retry");
    const counted = renderToStaticMarkup(
      <MyAccessCardView
        spaces={{ kind: "empty" }}
        computers={{
          kind: "ready",
          value: { count: 3, href: "/my-computers" },
        }}
        keys={{ kind: "ready", value: { count: 1, href: "/my-connections" } }}
        skeleton={false}
        onRetry={{ spaces: noop, computers: noop, keys: noop }}
        onOpen={noop}
      />
    );
    expect(counted).toContain("3 connectés");
    expect(counted).toContain("1 clé en service");
  });
});

describe("Home's catalogs", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});
