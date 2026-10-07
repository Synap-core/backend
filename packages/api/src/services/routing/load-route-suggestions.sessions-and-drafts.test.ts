/**
 * Capture → process, the two joins added on 2026-10-08:
 *   - ENRICH a running session: OPEN sessions the entity belongs in are route
 *     candidates of kind "session", ranked by the ONE ranker. A session ABOUT
 *     the entity outranks one that merely runs a playbook for its kind.
 *   - DRAFT a process: when no playbook is BUILT for the entity's kind or
 *     roles and the kind has a lifecycle, ONE `draft_process` offer rides
 *     LAST. A kind-less playbook matched only by intent does not suppress it;
 *     a playbook built for the kind does; a kind with no lifecycle never gets
 *     it.
 * The matchers are injected (their SQL is the matcher modules' concern —
 * `match-sessions-for-entity.ts` is typecheck + NEEDS-DOGFOOD).
 */

import { describe, it, expect, vi } from "vitest";
import {
  loadRouteSuggestions,
  type RouteMatchers,
} from "./load-route-suggestions.js";
import { findLifecycleProperty } from "./kind-lifecycle.js";

const WS = "11111111-1111-4111-8111-111111111111";

function base(over: Partial<RouteMatchers> = {}): RouteMatchers {
  return {
    playbooks: vi.fn(async () => []),
    rules: vi.fn(async () => ({
      matches: [],
      proposedPlaybookIds: new Set<string>(),
    })),
    facets: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    lifecycle: vi.fn(async () => null),
    ...over,
  };
}

async function suggestionsFor(m: RouteMatchers, intentText?: string) {
  const res = await loadRouteSuggestions({
    ctx: {},
    workspaceId: WS,
    entities: [{ entityId: "track-1", profileSlug: "track" }],
    ...(intentText ? { intentText } : {}),
    matchers: m,
  });
  expect(res.status).toBe("ok");
  return (res as Extract<typeof res, { status: "ok" }>).entities[0]!
    .suggestions;
}

describe("session route candidates", () => {
  it("offers the open session ABOUT the entity first, then a kind-matched session", async () => {
    const sessions = vi.fn(async () => [
      {
        kind: "session" as const,
        id: "s-kind",
        name: "Weekly crate dig",
        text: ["Dig new tracks", "Crate dig"],
        subjectProfileSlug: "track",
      },
      {
        kind: "session" as const,
        id: "s-about",
        name: "Remix Midnight City",
        text: ["Remix it"],
        subjectProfileSlug: null,
        subjectEntityId: "track-1",
      },
    ]);
    const m = base({ sessions, facets: vi.fn(async () => ["favourite"]) });
    const got = await suggestionsFor(m);
    expect(sessions).toHaveBeenCalledWith({
      entityId: "track-1",
      profileSlug: "track",
      facetSlugs: ["favourite"],
    });
    expect(got.map((s) => s.candidate.id)).toEqual(["s-about", "s-kind"]);
    expect(got[0]!.signals[0]).toEqual({
      type: "subject",
      profileSlug: "track",
    });
    expect(got[0]!.reason).toMatch(/^Already open on this /);
    expect(got[1]!.signals.map((s) => s.type)).toEqual(["kind"]);
  });

  it("does not ask for sessions for a PROPOSED entity (no id yet)", async () => {
    const sessions = vi.fn(async () => []);
    const res = await loadRouteSuggestions({
      ctx: {},
      workspaceId: WS,
      entities: [{ profileSlug: "track" }],
      matchers: base({ sessions }),
    });
    expect(res.status).toBe("ok");
    expect(sessions).not.toHaveBeenCalled();
  });
});

describe("draft-process offer", () => {
  it("is offered LAST when no playbook is built for the kind and the kind has a lifecycle", async () => {
    const m = base({
      // A kind-less playbook matched by intent only — not built for tracks.
      playbooks: vi.fn(async () => [
        {
          id: "pb-any",
          name: "Weekly review",
          goalTemplate: "review the week",
          subjectProfileSlug: null,
        },
      ]),
      lifecycle: vi.fn(async () => "track-status"),
    });
    const got = await suggestionsFor(m, "review this track");
    expect(got.map((s) => s.candidate.kind)).toEqual([
      "playbook",
      "draft_process",
    ]);
    const draft = got.at(-1)!;
    expect(draft.candidate).toMatchObject({
      kind: "draft_process",
      subjectProfileSlug: "track",
      statusProperty: "track-status",
    });
    expect(draft.signals).toEqual([]);
    expect(draft.reason).toMatch(/No process is set up for/);
  });

  it("is NOT offered when a playbook is built for the kind", async () => {
    const lifecycle = vi.fn(async () => "track-status");
    const m = base({
      playbooks: vi.fn(async () => [
        {
          id: "pb-track",
          name: "Prepare track",
          goalTemplate: "prep",
          subjectProfileSlug: "track",
        },
      ]),
      lifecycle,
    });
    const got = await suggestionsFor(m);
    expect(got.map((s) => s.candidate.kind)).toEqual(["playbook"]);
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("is NOT offered for a kind with no lifecycle", async () => {
    const got = await suggestionsFor(base());
    expect(got).toEqual([]);
  });
});

describe("findLifecycleProperty", () => {
  it("finds a SELECT whose slug names a status or a stage — never free text", () => {
    expect(
      findLifecycleProperty([
        { slug: "status-note", valueType: "string" }, // free text
        { slug: "title", constraints: { enum: ["a"] } }, // not lifecycle
        {
          slug: "post-Status",
          constraints: { enum: ["idea", "draft"] },
          displayOrder: 2,
        },
        {
          slug: "dealStage",
          uiHints: { inputType: "select" },
          displayOrder: 1,
        },
      ])
    ).toBe("dealStage");
    expect(
      findLifecycleProperty([{ slug: "status", constraints: { enum: [] } }])
    ).toBeNull();
  });
});
