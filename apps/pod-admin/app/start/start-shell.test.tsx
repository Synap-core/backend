/**
 * The `/start` shell (onboarding B1): the root gate, the resume, and S1.
 *
 * The gate and the resume are proven through the REAL server pages (`/` and
 * `/start`) with the pod caller and Next's redirect mocked: what is asserted is
 * where a person lands and whether the pod was even asked. S1 is rendered
 * (react-dom/server) from the defaults `intentModel` derives, so the copy and
 * the cloud states are read off the markup a person sees.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pod, requestHeaders, Redirect } = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(readonly href: string) {
      super(`NEXT_REDIRECT ${href}`);
    }
  }
  return {
    Redirect,
    pod: {
      calls: [] as string[],
      answers: new Map<string, unknown>(),
    },
    requestHeaders: { value: new Headers() },
  };
});

vi.mock("next/headers", () => ({ headers: async () => requestHeaders.value }));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Redirect(href);
  },
  useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
}));
vi.mock("../../lib/pod-trpc", () => ({
  callPodQuery: async (procedure: string) => {
    pod.calls.push(procedure);
    return (
      pod.answers.get(procedure) ?? {
        ok: false,
        status: 500,
        message: "no answer mocked",
      }
    );
  },
}));

import RootPage from "../page";
import StartPage from "./page";
import { StartIntentForm } from "./StartIntentForm";
import {
  intentModel,
  intentPatch,
  startStepHref,
  type CloudState,
  type StartCard,
  type StartState,
} from "./_lib/start-model";

const STARTS: StartCard[] = [
  {
    slug: "crm",
    icon: "handshake",
    order: 3,
    label: "Sales",
    promise: "Leads and deals, each with a dated next step.",
  },
  {
    slug: "builder",
    icon: "wrench",
    order: 1,
    label: "Product and dev",
    promise: "Features, tasks and releases, each with its owner.",
  },
  {
    slug: "content-os",
    icon: "pen-tool",
    order: 2,
    label: "Content",
    promise: "Ideas to published posts, one pipeline per platform.",
  },
];

const state = (over: Partial<StartState> = {}): StartState => ({
  due: true,
  journey: null,
  next: "start:intent",
  cloud: { status: "not-linked" },
  starts: STARTS,
  ...over,
});

const answer = (procedure: string, data: unknown) =>
  pod.answers.set(procedure, { ok: true, data });
const fail = (procedure: string) =>
  pod.answers.set(procedure, {
    ok: false,
    status: 500,
    message: "Pod returned 500.",
  });

/** Where a server page sent the request (it throws, as Next's redirect does). */
async function landing(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirect) return err.href;
    throw err;
  }
  return "(rendered)";
}

function asRole(role: "admin" | "member" | null) {
  const h = new Headers({ host: "admin.atelier-nord.synap.live" });
  if (role) h.set("x-pod-console-role", role);
  h.set("x-pod-admin-email", "marie@atelier-nord.com");
  requestHeaders.value = h;
}

beforeEach(() => {
  pod.calls.length = 0;
  pod.answers.clear();
  asRole("admin");
});

// ── The root gate (`/`) ─────────────────────────────────────────────────────

describe("the root gate", () => {
  it("never sends a member to onboarding, and never asks the pod about it", async () => {
    asRole("member");
    answer("onboarding.startState", state({ due: true }));
    expect(await landing(() => RootPage())).toBe("/home");
    expect(pod.calls).toEqual([]);
  });

  it("an unresolved role is not an admin", async () => {
    asRole(null);
    answer("onboarding.startState", state({ due: true }));
    expect(await landing(() => RootPage())).toBe("/home");
    expect(pod.calls).toEqual([]);
  });

  it("an admin on a fresh pod goes to /start", async () => {
    answer("onboarding.startState", state({ due: true }));
    expect(await landing(() => RootPage())).toBe("/start");
  });

  it("an existing pod with spaces opens Home: no journey row is not enough", async () => {
    // The pod's rule: no journey row AND spaces → not due.
    answer("onboarding.startState", state({ due: false, journey: null }));
    expect(await landing(() => RootPage())).toBe("/home");
  });

  it("a FAILED read opens Home with the failure shown, never /start", async () => {
    fail("onboarding.startState");
    expect(await landing(() => RootPage())).toBe("/home?start=unavailable");
  });
});

// ── /start: resume ──────────────────────────────────────────────────────────

describe("/start reopens the step the person is at", () => {
  it.each([
    ["start:views", "/start/views"],
    ["start:path", "/start/path"],
    ["start:setup", "/start/setup"],
    ["start:agent", "/start/agent"],
    ["start:first-work", "/start/first-work"],
    ["start:done", "/start/done"],
  ] as const)("next %s → %s", async (next, href) => {
    answer("onboarding.startState", state({ next, starts: undefined }));
    expect(
      await landing(() => StartPage({ searchParams: Promise.resolve({}) }))
    ).toBe(href);
    expect(startStepHref(next)).toBe(href);
  });

  it("a finished journey goes Home", async () => {
    answer("onboarding.startState", state({ next: null, due: false }));
    expect(
      await landing(() => StartPage({ searchParams: Promise.resolve({}) }))
    ).toBe("/home");
  });

  it("a FAILED read goes Home with the failure, never a guessed step", async () => {
    fail("onboarding.startState");
    expect(
      await landing(() => StartPage({ searchParams: Promise.resolve({}) }))
    ).toBe("/home?start=unavailable");
  });

  it("Back (?step=intent) reopens S1 with the recorded start selected", async () => {
    answer(
      "onboarding.startState",
      state({
        next: "start:path",
        cloud: null,
        starts: undefined,
        journey: {
          status: "active",
          progress: {
            values: {
              start: {
                v: 1,
                intent: { slug: "content-os", source: "here", at: "x" },
              },
            },
          },
        },
      })
    );
    answer("onboarding.listStarts", STARTS);
    const page = await StartPage({
      searchParams: Promise.resolve({ step: "intent" }),
    });
    const html = renderToStaticMarkup(page as ReactElement);
    expect(pod.calls).toEqual([
      "onboarding.startState",
      "onboarding.listStarts",
    ]);
    expect(html).toMatch(/value="content-os" checked=""/);
    expect(html).toContain("Step 1 of 7");
  });

  it("the intent step renders S1 in the Island frame", async () => {
    answer("onboarding.startState", state());
    const page = await StartPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page as ReactElement);
    expect(html).toContain("What should Synap run first?");
    expect(html).toContain("Step 1 of 7");
    expect(html).toContain("Signed in as");
    expect(html).toContain("Everything stays on your pod ·");
  });
});

// ── S1 defaults ─────────────────────────────────────────────────────────────

const cloudOk = (start?: string, workingOn?: string): CloudState => ({
  status: "ok",
  answers: { start, workingOn },
});

describe("S1 defaults", () => {
  it("cloud: the synap.live pick is selected and marked; the sentence is quoted", () => {
    const m = intentModel({
      starts: STARTS,
      cloud: cloudOk("crm", "I'm chasing five deals."),
      recorded: undefined,
    });
    expect(m.cards.map((c) => c.slug)).toEqual([
      "builder",
      "content-os",
      "crm",
    ]);
    expect(m.selected).toBe("crm");
    expect(m.fromCloud).toBe("crm");
    expect(m.said).toBe("I'm chasing five deals.");
    expect(intentPatch("crm", m)).toEqual({ slug: "crm", source: "cloud" });
    expect(intentPatch("builder", m)).toEqual({
      slug: "builder",
      source: "here",
    });
  });

  it.each([
    ["self-hosted", { status: "not-linked" } as CloudState],
    ["no cloud answer", { status: "empty" } as CloudState],
    ["a pick this pod does not list", cloudOk("life-os")],
  ])("%s: the first card in order is selected, no mark", (_, cloud) => {
    const m = intentModel({ starts: STARTS, cloud, recorded: undefined });
    expect(m.selected).toBe("builder");
    expect(m.fromCloud).toBeNull();
    expect(m.cloudFailed).toBe(false);
  });

  it("a FAILED cloud read selects nothing and says so", () => {
    const m = intentModel({
      starts: STARTS,
      cloud: { status: "failed", reason: "unreachable" },
      recorded: undefined,
    });
    expect(m.selected).toBeNull();
    expect(m.cloudFailed).toBe(true);
  });
});

// ── S1 as rendered ──────────────────────────────────────────────────────────

const render = (cloud: CloudState, starts: StartCard[] = STARTS) =>
  renderToStaticMarkup(
    createElement(StartIntentForm, {
      model: intentModel({ starts, cloud, recorded: undefined }),
    })
  );

describe("S1 as rendered", () => {
  it("draws the canvas copy and every card", () => {
    const html = render({ status: "not-linked" });
    expect(html).toContain("What should Synap run first?");
    expect(html).toContain(
      "Pick one. Synap prepares its space, and you approve it before anything is created."
    );
    for (const card of STARTS) {
      expect(html).toContain(card.label);
      expect(html).toContain(card.promise);
    }
    expect(html).toContain("Continue");
    expect(html).toContain("Skip setup for now");
    expect(html).not.toContain("From synap.live");
  });

  it("cloud: one 'From synap.live' mark, on the checked card, and 'You said:'", () => {
    const html = render(cloudOk("crm", "We sell branding retainers."));
    expect(html.split("From synap.live").length - 1).toBe(1);
    expect(html).toMatch(/value="crm" checked=""/);
    expect(html).toContain("You said:");
    expect(html).toContain("We sell branding retainers.");
  });

  it("a failed cloud read shows the warning over cards that stay usable", () => {
    const html = render({ status: "failed", reason: "unreachable" });
    expect(html).toContain("Couldn&#x27;t read your answer from synap.live.");
    expect(html).toContain("Try again");
    for (const card of STARTS) {
      expect(html).toContain(`value="${card.slug}"`);
    }
    expect(html).not.toMatch(/type="radio"[^>]*disabled/);
    expect(html).not.toMatch(/checked=""/);
  });

  it("no starts: EXPLAIN with a door to Marketplace, no Continue", () => {
    const html = render({ status: "not-linked" }, []);
    expect(html).toContain("No starting points yet");
    expect(html).toContain(
      "This pod has no starting points yet. Update the pod, or pick a template in Marketplace."
    );
    expect(html).toContain('href="/marketplace"');
    expect(html).not.toContain(">Continue<");
  });
});
