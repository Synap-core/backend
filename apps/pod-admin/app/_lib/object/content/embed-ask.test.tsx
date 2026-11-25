/**
 * `:::synap-ask`, RENDERED (react-dom/server; pod-admin's vitest runs in node)
 * through the real markdown walker and the real shared answer card, against a
 * tRPC client that records which door each answer is sent to.
 *
 *   • the open ask draws the shared answer card; answering goes out through
 *     `focusSessions.answerOutput`, the one door (never a door of this embed)
 *   • loading, failed, hidden, closed, answered and "no host" each say what
 *     they are: a failed read is never drawn as "no question"
 *   • an answered or closed ask offers no control
 *   • the author's prose fallback stays wherever the card does not stand
 *     for the question
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { askFingerprint, type Ask } from "@synap-core/types/ask";

const { calls, buttons, toasts, mutations, SESSION } = vi.hoisted(() => ({
  SESSION: "6f1c2c1e-0000-4000-8000-000000000001",
  toasts: [] as unknown[],
  mutations: [] as Array<{
    door: string;
    onSuccess?: (data: unknown, call: unknown) => void;
  }>,
  calls: [] as Array<[string, unknown]>,
  buttons: [] as Array<{ children?: unknown; onPress?: () => void }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => `/open/document/x`,
  useRouter: () => ({ replace() {}, push() {} }),
}));

// The real controls, with Button swapped for one that hands its press
// handler to the test: node has no DOM to click in.
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    addToast: (toast: unknown) => toasts.push(toast),
    Button: (props: { children?: unknown; onPress?: () => void }) => {
      buttons.push(props);
      return createElement(
        "button",
        { type: "button" },
        props.children as never
      );
    },
  };
});

vi.mock("../../../../lib/trpc", () => {
  const door = (name: string) => ({
    useMutation: (opts?: {
      onSuccess?: (data: unknown, call: unknown) => void;
    }) => {
      mutations.push({ door: name, onSuccess: opts?.onSuccess });
      return {
        mutate: (input: unknown) => {
          calls.push([name, input]);
        },
        isPending: false,
        error: null,
      };
    },
  });
  return {
    POD_URL: "https://pod.example.test",
    trpc: {
      // Every `utils.<router>.<proc>.invalidate()` is a no-op here.
      useUtils: () => {
        const deep: unknown = new Proxy(() => deep, {
          get: () => deep,
          apply: () => Promise.resolve(),
        });
        return deep;
      },
      focusSessions: {
        answerOutput: door("focusSessions.answerOutput"),
        attestOutput: door("focusSessions.attestOutput"),
        unblockOutput: door("focusSessions.unblockOutput"),
        askAboutSlot: door("focusSessions.askAboutSlot"),
        provideOptions: {
          useQuery: () => ({ data: undefined, isLoading: true, error: null }),
        },
      },
    },
  };
});

import MarkdownView from "./markdown-view";
import { EmbedHostContext } from "./embed-context";
import { AskAnswer } from "../../../(admin)/review/_lib/ask-answer";
import {
  askEmbedRead,
  type AskReceipt,
  type EmbedAskRead,
} from "./ask-embed-model";
import { AskFrame } from "./embed-ask";

const ASK = { mode: "confirm", prompt: "Ship the change today?" } as const;
const PROSE = "Which do you prefer, A or B? Say so in the session.";
const SOURCE = [
  `:::synap-ask{sessionId="${SESSION}" slot="ship-it"}`,
  PROSE,
  ":::",
].join("\n");

const openRead = (): EmbedAskRead =>
  askEmbedRead(
    {
      isLoading: false,
      error: null,
      data: {
        title: "Launch plan",
        status: "active",
        viewerRole: "owner",
        expectedOutputs: [
          {
            kind: "decision",
            label: "Ship it?",
            key: "ship-it",
            owner: "human",
            status: "pending",
            owedSince: "2026-11-16T09:00:00.000Z",
            ask: ASK,
          },
        ],
      },
      dataUpdatedAt: 5,
    },
    { sessionId: SESSION, slot: "ship-it" }
  );

function draw(read: EmbedAskRead | null, source = SOURCE) {
  calls.length = 0;
  buttons.length = 0;
  const asked: Array<[string, string]> = [];
  const node = <MarkdownView source={source} measure="wide" />;
  const html = renderToStaticMarkup(
    read ? (
      <EmbedHostContext.Provider
        value={{
          useEntity: () => ({ state: "unresolved" }),
          useAsk: (sessionId, slot) => {
            asked.push([sessionId, slot]);
            return read;
          },
        }}
      >
        {node}
      </EmbedHostContext.Provider>
    ) : (
      node
    )
  );
  return { html, asked };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("an open ask", () => {
  it("asks for the session's slot and draws the question with Yes / No, not the prose", () => {
    const { html, asked } = draw(openRead());
    expect(asked).toEqual([[SESSION, "ship-it"]]);
    expect(html).toContain('data-ask-state="open"');
    expect(text(html)).toContain("Ship the change today?");
    expect(buttons.map((b) => b.children)).toEqual(
      expect.arrayContaining(["Yes", "No"])
    );
    // The card IS the question: the prose fallback is not drawn twice.
    expect(text(html)).not.toContain(PROSE);
  });

  it("names the work the question comes from, above the card, as a door with its status", () => {
    const { html } = draw(openRead());
    expect(text(html)).toContain("Question from Launch plan");
    expect(html).toContain(`href="/open/session/${SESSION}"`);
    expect(text(html)).toMatch(/Question from Launch plan\s+·\s+\S/);
  });

  it("is a labelled, polite region and drops 'Message the agent' (the session page keeps it)", () => {
    const { html } = draw(openRead());
    expect(html).toContain('aria-label="Question waiting for your answer"');
    expect(html).toContain('aria-live="polite"');
    expect(text(html)).not.toContain("Message the agent");
    expect(text(html)).toContain("Your answer");
  });

  it("answering goes through focusSessions.answerOutput (the shared door) with the slot KEY and the ask seen", () => {
    draw(openRead());
    const yes = buttons.find((b) => b.children === "Yes");
    expect(yes?.onPress).toBeTypeOf("function");
    calls.length = 0;
    yes!.onPress!();
    expect(calls).toEqual([
      [
        "focusSessions.answerOutput",
        {
          sessionId: SESSION,
          expectedLabel: "ship-it",
          value: { type: "confirm", confirmed: true },
          askFingerprint: askFingerprint(ASK as unknown as Ask),
        },
      ],
    ]);
    // Exactly one door was called: the embed has no answer path of its own.
    expect(new Set(calls.map(([door]) => door))).toEqual(
      new Set(["focusSessions.answerOutput"])
    );
  });

  it("a quiet receipt: an answer toasts nothing from the embed, but still toasts from the default card", () => {
    const answered = () => {
      buttons.find((b) => b.children === "Yes")!.onPress!();
      toasts.length = 0;
      mutations.find((m) => m.door === "focusSessions.answerOutput")!
        .onSuccess!({}, { value: { type: "confirm", confirmed: true } });
      return toasts.length;
    };
    draw(openRead());
    expect(answered()).toBe(0);

    // The same card, the new prop left at its default: the session page's
    // behaviour is unchanged (this also proves the toast path is live).
    const { slot } = openRead() as Extract<EmbedAskRead, { state: "open" }>;
    mutations.length = 0;
    buttons.length = 0;
    const html = renderToStaticMarkup(
      <AskAnswer
        slot={slot}
        live={slot}
        onSettled={() => {}}
        onClose={() => {}}
      />
    );
    expect(answered()).toBe(1);
    expect(text(html)).toContain("Message the agent");
  });

  it("each way the shared card settles passes its kind (attest, hand-back, refusal, answer)", () => {
    const { slot } = openRead() as Extract<EmbedAskRead, { state: "open" }>;
    const settled: string[] = [];
    mutations.length = 0;
    renderToStaticMarkup(
      <AskAnswer
        slot={slot}
        live={slot}
        quietReceipt
        onSettled={(kind) => settled.push(kind)}
        onClose={() => {}}
      />
    );
    const on = (door: string, call: unknown) =>
      mutations.find((m) => m.door === door)!.onSuccess!({}, call);
    on("focusSessions.attestOutput", {});
    on("focusSessions.unblockOutput", {});
    on("focusSessions.answerOutput", {
      value: { type: "declined", reason: "no" },
    });
    on("focusSessions.answerOutput", {
      value: { type: "confirm", confirmed: true },
    });
    expect(settled).toEqual(["attested", "handed-back", "refused", "answered"]);
  });

  it("a member (not the owner) reads the question and gets no controls", () => {
    const read = openRead();
    const { html } = draw({ ...(read as object), canAnswer: false } as never);
    expect(html).toContain('data-ask-state="member"');
    expect(text(html)).toContain("Ship the change today?");
    expect(buttons).toHaveLength(0);
  });
});

describe("the receipt and the live region", () => {
  const url = `/open/session/${SESSION}`;
  const frame = (receipt: AskReceipt | null, read: EmbedAskRead) => {
    buttons.length = 0;
    return renderToStaticMarkup(
      <AskFrame
        read={read}
        sessionId={SESSION}
        prose={null}
        receipt={receipt}
      />
    );
  };

  it("the live region announces the receipt only, and sits outside the card's inputs", () => {
    const open = frame(null, openRead());
    const region = /<p aria-live="polite"[^>]*>([^<]*)<\/p>/.exec(open);
    expect(region?.[1]).toBe("");
    // Exactly one live region, and it is not the card.
    expect(open.match(/aria-live/g)).toHaveLength(1);
    // The region is a sibling of the card, never around its controls.
    expect(
      open.indexOf("</p>", open.indexOf('aria-live="polite"'))
    ).toBeLessThan(open.indexOf('data-ask-state="open"'));
    const done = frame({ kind: "answered", at: 10 }, openRead());
    expect(done).toMatch(/aria-live="polite"[^>]*>Answer sent</);
  });

  it.each([
    ["answered", "Answer sent"],
    ["attested", "Marked as done"],
    ["handed-back", "Handed back to the agent"],
    ["refused", "Refused"],
  ] as const)("a %s settle reads %s", (kind, mark) => {
    const html = frame({ kind, at: 10 }, openRead());
    expect(html).toContain('data-ask-state="answered"');
    expect(text(html)).toContain(mark);
    expect(html).not.toContain('data-ask-state="open"');
    expect(buttons).toHaveLength(0);
    if (kind !== "answered") expect(text(html)).not.toContain("Answer sent");
  });

  it("the receipt and the refetched 'answered' state are one element type (focus survives)", () => {
    const tag = (html: string) =>
      /<(\w+)[^>]*data-ask-state="answered"/
        .exec(html)?.[0]
        .replace(/ class="[^"]*"/, "");
    const receipt = frame(
      { kind: "answered", at: 10 },
      { state: "answered", answer: "Yes, ship it", attested: false }
    );
    const plain = frame(null, {
      state: "answered",
      answer: "Yes, ship it",
      attested: false,
    });
    expect(tag(receipt)).toBe(tag(plain));
    expect(tag(receipt)).toContain('tabindex="-1"');
    // …and a hand-back (the slot then reads closed) keeps the receipt, not 'closed'.
    const afterHandBack = frame(
      { kind: "handed-back", at: 10 },
      { state: "closed" }
    );
    expect(text(afterHandBack)).toContain("Handed back to the agent");
    expect(text(afterHandBack)).not.toContain("closed without an answer");
    expect(url).toContain(SESSION);
  });
});

describe("every other state says what it is", () => {
  it("loading is a card-sized busy skeleton, and the prose is already there", () => {
    const { html } = draw({ state: "loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-ask-state="loading"');
    expect(html).toContain("min-h-[240px]");
    expect(text(html)).toContain(PROSE);
  });

  it("a FAILED read says so, offers Try again, and is not drawn as 'no question'", () => {
    const { html } = draw({
      state: "failed",
      retry: () => {},
      retrying: false,
    });
    expect(html).toContain('data-ask-state="failed"');
    expect(html).toMatch(/role="status"[^>]*data-ask-state="failed"/);
    expect(text(html)).toContain("This question couldn’t be loaded.");
    expect(text(html)).toContain("Try again");
    expect(text(html)).not.toMatch(/closed|available/);
    expect(text(html)).toContain(PROSE);
  });

  it("a failed read being retried says 'Retrying…' instead of offering the button again", () => {
    const { html } = draw({ state: "failed", retry: () => {}, retrying: true });
    expect(text(html)).toContain("Retrying…");
    expect(text(html)).not.toContain("Try again");
  });

  it("answered shows the recorded answer, no controls, and keeps the prose", () => {
    const { html } = draw({
      state: "answered",
      answer: "Yes, ship it",
      attested: false,
    });
    expect(html).toContain('data-ask-state="answered"');
    expect(text(html)).toContain("Answered");
    expect(text(html)).toContain("Yes, ship it");
    expect(buttons).toHaveLength(0);
    expect(html).not.toContain("<button");
    expect(text(html)).toContain(PROSE);
  });

  it("closed offers no control", () => {
    const { html } = draw({ state: "closed" });
    expect(html).toContain('data-ask-state="closed"');
    expect(buttons).toHaveLength(0);
    expect(text(html)).toContain(PROSE);
  });

  it("hidden (not visible, or an unknown slot) is a quiet line and the prose stays", () => {
    const { html } = draw({ state: "hidden" });
    expect(html).toContain('data-ask-state="hidden"');
    expect(text(html)).toContain("This question isn’t available.");
    expect(text(html)).toContain(PROSE);
    expect(buttons).toHaveLength(0);
  });

  it("with no reader (no host) it is a door to the session and the prose stays", () => {
    const { html } = draw(null);
    expect(html).toContain('data-ask-state="unresolved"');
    expect(html).toContain(`/open/session/${SESSION}`);
    expect(text(html)).toContain(PROSE);
  });

  it("an embed naming no session or slot is said to name nothing, prose kept", () => {
    const { html, asked } = draw(
      openRead(),
      `:::synap-ask{slot="ship-it"}\n${PROSE}\n:::`
    );
    expect(asked).toEqual([]);
    expect(html).toContain('data-ask-state="broken"');
    expect(text(html)).toContain("its reference is incomplete");
    expect(text(html)).toContain(PROSE);
  });

  it("inline in a sentence it is only the door to the session", () => {
    const { html } = draw(
      openRead(),
      `See :synap-ask{sessionId="${SESSION}" slot="ship-it"} first.`
    );
    expect(buttons).toHaveLength(0);
    expect(html).toContain(`/open/session/${SESSION}`);
  });
});
