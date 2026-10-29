import { describe, expect, it } from "vitest";
import {
  askFingerprint,
  classifyAskRefusal,
  type Ask,
} from "@synap-core/types/ask";
import {
  OTHER_KEY,
  answerCall,
  askSlotOf,
  askStaleness,
  askView,
  formAnswerValues,
  formFieldErrors,
  initialFormDraft,
  nextRowKey,
  relayCall,
  relayWaitingView,
  slotCall,
  type AskSlot,
  type FormFieldView,
} from "./ask-detail";

function slot(ask: Ask | null, over: Partial<AskSlot> = {}): AskSlot {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    label: "Pick the hook",
    sessionTitle: "Plan next content",
    ask,
    why: null,
    claimedDone: false,
    blockedReason: null,
    owedSince: null,
    askerName: null,
    askCause: null,
    ...over,
  };
}

const choose: Ask = {
  mode: "choose",
  options: [
    {
      label: "Failure story",
      value: "fail",
      description: "Opens on a failure.",
    },
    { label: "Stance", recommended: true, description: "Clear stance." },
    { label: "Numbers" },
  ],
};

const form: Ask = {
  mode: "form",
  form: {
    title: "Billing details",
    fields: [
      { key: "email", label: "Billing email", type: "email", required: true },
      {
        key: "seats",
        label: "Seats",
        type: "number",
        constraints: { min: 1, max: 50 },
      },
      {
        key: "plan",
        label: "Plan",
        type: "enum",
        constraints: { enum: ["pro", "team"] },
      },
      {
        key: "po",
        label: "PO number",
        type: "text",
        constraints: { pattern: "PO-\\d+" },
      },
      { key: "rush", label: "Rush", type: "boolean" },
      { key: "api_key", label: "API key", type: "text" },
    ],
  },
};

describe("askSlotOf — which needs-you rows are answered here", () => {
  const owed = {
    kind: "owed-slot",
    title: "Pick the hook",
    target: { kind: "session", id: "s1" },
    sessionTitle: " Plan next content ",
    why: "  ",
    claimedDone: true,
    ask: choose,
    blockedReason: "decision",
    occurredAt: "2026-10-20T09:00:00.000Z",
    by: { label: " Claude Code " },
  };
  it("reads an owed slot's question off its signal, asker and clock included", () => {
    expect(askSlotOf(owed)).toEqual({
      sessionId: "s1",
      label: "Pick the hook",
      sessionTitle: "Plan next content",
      ask: choose,
      why: null,
      claimedDone: true,
      blockedReason: "decision",
      owedSince: "2026-10-20T09:00:00.000Z",
      askerName: "Claude Code",
      askerId: null,
      askCause: null,
      pendingRelay: null,
      keptOwedAt: null,
      paramName: null,
    });
  });
  it("carries the fields the card's fate and cause read", () => {
    expect(
      askSlotOf({
        ...owed,
        keptOwedAt: "2026-10-21T09:00:00.000Z",
        paramName: "channel",
      })
    ).toMatchObject({
      keptOwedAt: "2026-10-21T09:00:00.000Z",
      paramName: "channel",
    });
  });
  it("leaves out a criterion slot whose ask is not its grade, any other kind, and a slot with no session", () => {
    // `choose` carries one verdict value ("fail") beside a plain option: not a
    // grade (wrong rule: any verdict option makes it one).
    expect(askSlotOf({ ...owed, slotKind: "criterion" })).toBeNull();
    expect(askSlotOf({ ...owed, slotKind: "criterion", ask: null })).toBeNull();
    expect(askSlotOf({ ...owed, kind: "draft-asks" })).toBeNull();
    expect(askSlotOf({ ...owed, target: null })).toBeNull();
  });
});

describe("askSlotOf — an escalated criterion is graded here", () => {
  it("reads a criterion slot whose ask is Pass / Fail, so its answer is the grade", () => {
    const grade: Ask = {
      mode: "choose",
      options: [
        { label: "Pass", value: "pass" },
        { label: "Fail", value: "fail" },
      ],
    };
    expect(
      askSlotOf({
        kind: "owed-slot",
        title: "Check: the rules match their pod skills",
        slotKind: "criterion",
        target: { kind: "session", id: "s1" },
        ask: grade,
      })
    ).toMatchObject({ sessionId: "s1", ask: grade });
  });
});

describe("askView — one control per mode", () => {
  it("confirm: the card's two answers — icon, tone, recommendation, consequence", () => {
    const view = askView(
      slot({
        mode: "confirm",
        prompt: " Ship it? ",
        yes: { recommended: true, description: "Publishes today" },
      })
    );
    expect(view.heading).toBe("Ship it?");
    expect(view.control).toEqual({
      mode: "confirm",
      answers: [
        {
          key: "yes",
          label: "Yes",
          description: "Publishes today",
          recommended: true,
          tone: "positive",
          icon: "check",
        },
        {
          key: "no",
          label: "No",
          description: null,
          recommended: false,
          tone: "neutral",
          icon: "x",
        },
      ],
    });
  });

  it("the founder's card: the question once, the cause named, age + fate as one mark", () => {
    const title = "Four observations will confirm or kill H1 and H2";
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    const view = askView(
      slot(
        { mode: "confirm", prompt: `Accept: ${title}?` },
        {
          label: `Decide: ${title}`,
          why: `${title}. Dated and falsifiable.`,
          blockedReason: "decision",
          owedSince: "2026-10-18T12:00:00.000Z",
          askCause: { kind: "decision", ref: { kind: "entity", id: "d1" } },
        }
      ),
      now
    );
    expect(view.heading).toBe(`${title}?`);
    expect(view.context).toBeNull();
    expect(view.asker).toMatchObject({
      kind: "cause",
      label: "From a proposed decision",
    });
    expect(view.ageFate.label).toBe("Asked 8d ago · In Review later");
    expect(view.note.label).toBe("Add a note");
  });

  it("a named asker is the agent's mark, with its session as the door", () => {
    const view = askView(slot(choose, { askerName: "Claude Code" }));
    expect(view.asker).toEqual({
      kind: "agent",
      name: "Claude Code",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("choose: the recommended option is pre-selected, with its description", () => {
    const c = askView(slot(choose)).control;
    expect(c).toMatchObject({
      mode: "choose",
      initialKey: "Stance",
      // Open by default: the person can always answer in their own words.
      allowOther: true,
    });
    if (c.mode !== "choose") throw new Error("choose");
    expect(c.options.map((o) => [o.key, o.recommended, o.description])).toEqual(
      [
        ["fail", false, "Opens on a failure."],
        ["Stance", true, "Clear stance."],
        ["Numbers", false, null],
      ]
    );
  });

  it("choose: nothing is pre-selected without a recommendation", () => {
    const c = askView(
      slot({
        mode: "choose",
        options: [{ label: "A" }, { label: "B" }],
        allowOther: true,
      })
    ).control;
    expect(c).toMatchObject({
      mode: "choose",
      initialKey: null,
      allowOther: true,
    });
  });

  it("form: a control per field, constraints kept, credential fields dropped", () => {
    const c = askView(slot(form)).control;
    if (c.mode !== "form") throw new Error("form");
    expect(c.title).toBe("Billing details");
    expect(c.fields.map((f) => [f.key, f.control, f.inputType])).toEqual([
      ["email", "text", "email"],
      ["seats", "number", "text"],
      ["plan", "select", "text"],
      ["po", "text", "text"],
      ["rush", "switch", "text"],
    ]);
    expect(c.fields[1]).toMatchObject({ min: 1, max: 50 });
    expect(c.fields[2]!.options).toEqual(["pro", "team"]);
  });

  it("act: the full trimmed url and the steps, blanks dropped", () => {
    const url = "https://dash.example.com/7f3a/dns/records?zone=synap.live";
    expect(
      askView(
        slot({
          mode: "act",
          url: ` ${url} `,
          steps: ["Open it", " ", "Add the record"],
        })
      ).control
    ).toEqual({ mode: "act", url, steps: ["Open it", "Add the record"] });
  });

  it("provide: names what it wants handed over", () => {
    expect(
      askView(
        slot({
          mode: "provide",
          provide: { kind: "secret", name: "Stripe key" },
        })
      ).control
    ).toEqual({
      mode: "provide",
      kind: "secret",
      wants: "A secret: Stripe key",
    });
    expect(
      askView(
        slot({
          mode: "provide",
          provide: { kind: "connection", service: "github" },
        })
      ).control
    ).toMatchObject({
      kind: "connection",
      wants: "A connection to GitHub",
    });
    const file = askView(
      slot({ mode: "provide", provide: { kind: "file", accept: [".pdf"] } })
    ).control;
    expect(file).toMatchObject({ wants: "A file (.pdf)" });
  });

  it("no ask: today's free text, I did this, Not mine", () => {
    expect(askView(slot(null)).control).toEqual({ mode: "legacy" });
  });

  it("what it looked at: the pod's names, else the kind's noun", () => {
    const view = askView(
      slot({
        mode: "confirm",
        lookedAt: [
          { kind: "document", id: "d1", title: "Draft #4" } as never,
          { kind: "entity", id: "e1" },
        ],
      })
    );
    expect(view.lookedAt).toEqual([
      { kind: "document", id: "d1", label: "Draft #4" },
      { kind: "entity", id: "e1", label: expect.any(String) },
    ]);
    expect(view.lookedAt[1]!.label.length).toBeGreaterThan(0);
  });
});

describe("answerCall — checked with the pod's rule, carrying the fingerprint", () => {
  it("confirm: yes with a note", () => {
    const ask: Ask = { mode: "confirm" };
    const built = answerCall(slot(ask), {
      type: "confirm",
      confirmed: true,
      note: " ok ",
    });
    expect(built).toEqual({
      ok: true,
      call: {
        sessionId: slot(ask).sessionId,
        expectedLabel: "Pick the hook",
        value: { type: "confirm", confirmed: true },
        text: "ok",
        askFingerprint: askFingerprint(ask),
      },
    });
  });

  it("choose: sends the OFFERED option, not a copy", () => {
    const built = answerCall(slot(choose), { type: "choose", key: "fail" });
    expect(built.ok && built.call.value).toEqual({
      type: "chip",
      chip: choose.mode === "choose" ? choose.options[0] : null,
    });
  });

  it("choose: an option it does not offer is refused", () => {
    expect(answerCall(slot(choose), { type: "choose", key: "nope" }).ok).toBe(
      false
    );
  });

  it("choose: a picked option carries the person's details as its note", () => {
    const built = answerCall(slot(choose), {
      type: "choose",
      key: "fail",
      note: " but keep it short ",
    });
    expect(built.ok && built.call).toMatchObject({
      value: { type: "chip" },
      text: "but keep it short",
    });
  });

  it("choose: their own answer unless the ask is closed, and only with words", () => {
    const closed = slot({ ...choose, allowOther: false } as Ask);
    expect(askView(closed).control).toMatchObject({ allowOther: false });
    const other = answerCall(closed, {
      type: "choose",
      key: OTHER_KEY,
      other: "Mine",
    });
    expect(other.ok).toBe(false);
    const open = slot(choose);
    const built = answerCall(open, {
      type: "choose",
      key: OTHER_KEY,
      other: " Mine ",
    });
    expect(built.ok && built.call).toMatchObject({
      value: { type: "text" },
      text: "Mine",
    });
    expect(
      answerCall(open, { type: "choose", key: OTHER_KEY, other: " " }).ok
    ).toBe(false);
  });

  it("form: field hints first, then the values the pod receives", () => {
    const s = slot(form);
    const view = askView(s).control;
    if (view.mode !== "form") throw new Error("form");
    const draft = initialFormDraft(view.fields);
    const empty = answerCall(s, { type: "form", draft });
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.fieldErrors).toEqual({ email: "Required." });

    const built = answerCall(s, {
      type: "form",
      draft: {
        ...draft,
        email: " a@b.co ",
        seats: "3",
        plan: "team",
        po: "PO-12",
      },
    });
    expect(built.ok && built.call.value).toEqual({
      type: "form",
      values: {
        email: "a@b.co",
        seats: 3,
        plan: "team",
        po: "PO-12",
        rush: false,
      },
    });
  });

  it("act: never through the answer door", () => {
    expect(
      answerCall(slot({ mode: "act" }), { type: "text", text: "done" }).ok
    ).toBe(false);
  });

  it("provide: words never answer it, a reference of the asked kind does", () => {
    const s = slot({
      mode: "provide",
      provide: { kind: "connection", service: "github" },
    });
    expect(answerCall(s, { type: "text", text: "here" }).ok).toBe(false);
    const connectionId = "22222222-2222-4222-8222-222222222222";
    const built = answerCall(s, {
      type: "provide",
      ref: { kind: "connection", connectionId },
    });
    expect(built.ok && built.call).toEqual({
      sessionId: s.sessionId,
      expectedLabel: s.label,
      value: { type: "provide", ref: { kind: "connection", connectionId } },
      askFingerprint: askFingerprint(s.ask),
    });
    // A secret handed over for a connection ask is refused before it is sent.
    expect(
      answerCall(s, {
        type: "provide",
        ref: {
          kind: "secret",
          vaultRef: "vault://33333333-3333-4333-8333-333333333333",
        },
      }).ok
    ).toBe(false);
  });

  it("no ask: the answer in words", () => {
    const built = answerCall(slot(null), { type: "text", text: " Use EU " });
    expect(built.ok && built.call).toMatchObject({
      value: { type: "text" },
      text: "Use EU",
      askFingerprint: "none",
    });
    expect(answerCall(slot(null), { type: "text", text: "  " }).ok).toBe(false);
  });

  it("attest / ask-about carry the slot and the fingerprint", () => {
    const s = slot({ mode: "act", url: "https://x.example" });
    expect(slotCall(s)).toEqual({
      sessionId: s.sessionId,
      expectedLabel: s.label,
      askFingerprint: askFingerprint(s.ask),
    });
  });
});

describe("formFieldErrors / formAnswerValues", () => {
  const fields: FormFieldView[] = [
    {
      key: "n",
      label: "N",
      help: null,
      required: false,
      control: "number",
      inputType: "text",
      options: [],
      min: 2,
      max: 4,
      pattern: null,
    },
    {
      key: "code",
      label: "Code",
      help: null,
      required: false,
      control: "text",
      inputType: "text",
      options: [],
      min: null,
      max: null,
      pattern: "[A-Z]{3}",
    },
  ];
  it("checks a number's bounds and a text's pattern, ignoring blanks", () => {
    expect(formFieldErrors(fields, { n: "", code: "" })).toEqual({});
    expect(formFieldErrors(fields, { n: "x", code: "abc" })).toEqual({
      n: "Enter a number.",
      code: "Not in the expected format.",
    });
    expect(formFieldErrors(fields, { n: "9", code: "ABC" })).toEqual({
      n: "At most 4.",
    });
  });
  it("an unreadable pattern is no hint at all", () => {
    expect(
      formFieldErrors([{ ...fields[1]!, pattern: "(" }], { code: "x" })
    ).toEqual({});
  });
  it("leaves blanks out", () => {
    expect(formAnswerValues(fields, { n: " ", code: "ABC" })).toEqual({
      code: "ABC",
    });
  });
});

describe("a question that moved under the reader", () => {
  it("same ask → same; re-asked → changed; no longer owed → gone", () => {
    const seen = slot(choose);
    expect(askStaleness(seen, slot(choose, { why: "new context" }))).toBe(
      "same"
    );
    expect(
      askStaleness(seen, slot({ ...choose, allowOther: true } as Ask))
    ).toBe("changed");
    expect(askStaleness(seen, null)).toBe("gone");
  });

  it("provenance is not the question: new 'looked at' refs are not a change", () => {
    const seen = slot({ mode: "confirm" });
    expect(
      askStaleness(
        seen,
        slot({ mode: "confirm", lookedAt: [{ kind: "entity", id: "e" }] })
      )
    ).toBe("same");
  });

  it("the pod's stale refusals read as stale, never as a failure", () => {
    expect(
      classifyAskRefusal('ask_changed: the question on "x" changed').kind
    ).toBe("ask_changed");
    expect(classifyAskRefusal('"x" is already delivered').kind).toBe(
      "moved_on"
    );
    expect(
      classifyAskRefusal("Only the person can answer — an agent key cannot.")
    ).toEqual({
      kind: "failed",
      message: "Only the person can answer — an agent key cannot.",
    });
  });
});

describe("nextRowKey", () => {
  it("moves to the next row, else the previous, else nowhere", () => {
    expect(nextRowKey(["a", "b", "c"], "b")).toBe("c");
    expect(nextRowKey(["a", "b", "c"], "c")).toBe("b");
    expect(nextRowKey(["a"], "a")).toBeNull();
  });
});

describe("a relayed answer waiting for the tap", () => {
  const relay = {
    text: "Yes",
    quote: "yes, ship it friday",
    relayedBy: "agent-1",
    relayedAt: "2026-10-26T10:00:00.000Z",
  };
  const confirm: Ask = { mode: "confirm", prompt: "Deploy now?" };

  it("reaches the slot from the needs-you signal", () => {
    const s = askSlotOf({
      kind: "owed-slot",
      title: "Deploy",
      target: { kind: "session", id: "s1" },
      ask: confirm,
      by: { id: "agent-1", label: "Claude Code" },
      pendingRelay: relay,
    });
    expect(s?.pendingRelay).toEqual(relay);
    expect(relayWaitingView(s!)).toEqual({
      mark: {
        tone: "warning",
        label: "Relayed by Claude Code · needs your tap",
        disposition: "awaiting_your_tap",
      },
      recorded: "Yes",
      said: "You said “yes, ship it friday”",
    });
  });

  it("a relay the wire did not carry whole is no relay, never a Confirm with no relayer", () => {
    const s = askSlotOf({
      kind: "owed-slot",
      title: "Deploy",
      target: { kind: "session", id: "s1" },
      ask: confirm,
      pendingRelay: { text: "Yes" },
    });
    expect(s?.pendingRelay).toBeNull();
    expect(relayWaitingView(s!)).toBeNull();
  });

  it("headlines what Confirm records, as the answer's own button reads", () => {
    const s = slot(
      { mode: "confirm", yes: { label: "Ship it" } },
      {
        pendingRelay: {
          ...relay,
          value: { type: "confirm", confirmed: true },
        },
      }
    );
    expect(relayWaitingView(s)).toMatchObject({
      recorded: "Ship it",
      said: "You said “yes, ship it friday”",
    });
  });

  it("the card's fate reads the relay and the kept-owed stamp", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    const relayedToday = slot(confirm, {
      owedSince: "2026-10-18T12:00:00.000Z",
      pendingRelay: { ...relay, relayedAt: "2026-10-27T09:00:00.000Z" },
    });
    expect(askView(relayedToday, now).ageFate.fate.kind).not.toBe(
      "review_later"
    );
    const kept = slot(confirm, {
      owedSince: "2026-10-26T12:00:00.000Z",
      keptOwedAt: "2026-10-27T08:00:00.000Z",
    });
    expect(askView(kept, now).ageFate.fate.kind).toBe("until_decided");
    expect(askView(slot(confirm), now).ageFate.fate.kind).toBe(
      "ends_with_session"
    );
  });

  it("names the relayer only when it is the agent that asked", () => {
    const other = slot(confirm, {
      askerId: "agent-2",
      askerName: "Scout",
      pendingRelay: relay,
    });
    expect(relayWaitingView(other)?.mark.label).toBe(
      "Relayed · needs your tap"
    );
    expect(relayWaitingView(slot(confirm))).toBeNull();
  });

  it("Confirm and Not what I said address the slot, nothing else", () => {
    const s = slot(confirm, { pendingRelay: relay });
    expect(relayCall(s, "confirm")).toEqual({
      sessionId: s.sessionId,
      expectedLabel: s.label,
      confirmRelayed: true,
    });
    expect(relayCall(s, "reject")).toEqual({
      sessionId: s.sessionId,
      expectedLabel: s.label,
      rejectRelayed: true,
    });
  });
});
