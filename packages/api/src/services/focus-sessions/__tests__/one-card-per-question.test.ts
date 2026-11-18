/**
 * ONE CARD PER QUESTION (plan efb315a5, W1; `same-question.ts`).
 *
 * The fixture is the live twin of session cf60123c (17 Nov 2026): a pod-run
 * agent declared "Disposition Esteban Arias — Nurturing ou Disqualified" in
 * one turn and "Disposition d'Esteban Arias (Prometheus)" in the next, with
 * different option VALUES and `why` (so neither the label nor `askFingerprint`
 * matches). The rows where the candidate rules DISAGREE: another lead with
 * the same choice (subject rule), the same lead with another choice (choice
 * rule), the open card already answered (open rule), two different objects
 * (ref veto), an update of the open card itself (self rule), and a person's
 * own write (agents only).
 */
import { describe, expect, it } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { sameQuestion } from "../same-question.js";
import {
  applyOutputMutations,
  dedupeOpenQuestions,
} from "../update-session.js";

const ARIAS = "4c4866dc-52f5-41e3-8ebb-29bff8fa4c7c";

/** The first card, as stored (cf60123c `validation-esteban-arias`). */
const FIRST: ExpectedOutput = {
  key: "validation-esteban-arias",
  kind: "decision",
  label: "Disposition Esteban Arias — Nurturing ou Disqualified",
  status: "pending",
  owner: "human",
  blockedReason: "decision",
  why: "Prometheus est une association, pas un fit actuel. Antoine doit choisir entre Nurturing et Disqualified pour clôturer la fiche.",
  owedSince: "2026-11-17T14:11:30.000Z",
  ask: {
    mode: "choose",
    options: [
      {
        label: "Nurturing",
        value:
          "Passer le lead en nurturing — garder le contact, Prometheus pourrait devenir un fit plus tard",
        description: "Lead passé en nurturing avec nextActionAt à définir",
        recommended: false,
      },
      {
        label: "Disqualified",
        value:
          "Passer le lead en disqualified — Prometheus est une association, pas un fit, raison enregistrée",
        description: "Lead passé en disqualified avec disqualificationReason",
        recommended: true,
      },
    ],
  },
} as ExpectedOutput;

/** The second card, as the next turn sent it (cf60123c `disposition-esteban-arias`). */
const SECOND: ExpectedOutput = {
  key: "disposition-esteban-arias",
  kind: "decision",
  label: "Disposition d'Esteban Arias (Prometheus)",
  owner: "human",
  blockedReason: "decision",
  why: "Prometheus a répondu le 2 Nov : c'est une association, pas un fit actuel. Antoine doit choisir entre Nurturing et Disqualified.",
  ref: { kind: "entity", id: ARIAS },
  ask: {
    mode: "choose",
    options: [
      {
        label: "Nurturing",
        value: "nurturing",
        description: "Maintenir le contact, réengager plus tard",
        recommended: true,
      },
      {
        label: "Disqualified",
        value: "disqualified",
        description: "Clôturer le lead, pas un fit actuel",
      },
    ],
  },
} as ExpectedOutput;

const WORK: ExpectedOutput = {
  key: "conversations-lues",
  kind: "output",
  label: "Conversations lues — 4 leads envoyés le 2 Nov",
} as ExpectedOutput;

describe("sameQuestion — the cf60123c twin and the rows that rule each rule in", () => {
  it("the live twin: same choice offered, same subject, different words → the same question", () => {
    expect(sameQuestion(FIRST, SECOND)).toBe(true);
    expect(sameQuestion(SECOND, FIRST)).toBe(true);
  });

  it("another lead, same choice → different questions (the subject rule)", () => {
    const engbers = {
      ...SECOND,
      label: "Disposition Alexander Engbers",
      ref: undefined,
    } as ExpectedOutput;
    expect(sameQuestion(FIRST, engbers)).toBe(false);
  });

  it("the same lead, another choice → different questions (the choice rule)", () => {
    const relance = {
      ...SECOND,
      ask: {
        mode: "choose",
        options: [{ label: "Relancer" }, { label: "Attendre" }],
      },
    } as ExpectedOutput;
    expect(sameQuestion(FIRST, relance)).toBe(false);
  });

  it("two different objects never merge (the ref veto)", () => {
    const other = {
      ...FIRST,
      ref: { kind: "entity", id: "0c19deb1-13e3-46a2-ae40-76d1af4e2190" },
    } as ExpectedOutput;
    expect(sameQuestion(other, SECOND)).toBe(false);
  });

  it("the same label is the same question, case and spaces aside", () => {
    expect(
      sameQuestion(FIRST, {
        kind: "decision",
        label: "  disposition esteban arias — nurturing ou disqualified ",
      } as ExpectedOutput)
    ).toBe(true);
  });

  it("a label that names MORE is a different question: 'Send the email' and 'Send the email to Bob' stay apart (lead review)", () => {
    const send = {
      label: "Send the email",
      ask: { mode: "confirm", prompt: "Send it?" },
    } as ExpectedOutput;
    const toBob = {
      label: "Send the email to Bob",
      ask: { mode: "confirm", prompt: "Send it?" },
    } as ExpectedOutput;
    expect(sameQuestion(send, toBob)).toBe(false);
    expect(sameQuestion(toBob, send)).toBe(false);
    const d = dedupeOpenQuestions(
      [{ ...send, kind: "decision", owner: "human" } as ExpectedOutput],
      [{ ...toBob, kind: "decision", owner: "human" } as ExpectedOutput]
    );
    expect(d.deduped).toEqual([]);
  });

  it("a confirm: same prompt AND same subject; a generic prompt alone is not enough", () => {
    const a = {
      label: "Send the follow-up to Engbers",
      ask: { mode: "confirm", prompt: "Send it?" },
    } as ExpectedOutput;
    const b = {
      label: "Send the follow-up to Zarka",
      ask: { mode: "confirm", prompt: "Send it?" },
    } as ExpectedOutput;
    expect(sameQuestion(a, b)).toBe(false);
    expect(
      sameQuestion(a, {
        label: "Send follow-up Engbers",
        ask: { mode: "confirm", prompt: "send it?" },
      } as ExpectedOutput)
    ).toBe(true);
  });
});

describe("dedupeOpenQuestions — an agent's list", () => {
  it("the cf60123c turn: the second card is left out, the open one is named", () => {
    const d = dedupeOpenQuestions([WORK, FIRST], [WORK, FIRST, SECOND]);
    expect(d.incoming.map((o) => o.label)).toEqual([WORK.label, FIRST.label]);
    expect(d.deduped).toEqual([
      {
        key: "validation-esteban-arias",
        label: FIRST.label,
        asked: SECOND.label,
      },
    ]);
  });

  it("the open card ALREADY ANSWERED: a new card is a new question (the open rule)", () => {
    const answered = {
      ...FIRST,
      owner: undefined,
      answer: {
        text: "Disqualified",
        answeredAt: "2026-11-18T11:25:43.066Z",
        answeredBy: "u",
        messageId: "m",
      },
    } as ExpectedOutput;
    const d = dedupeOpenQuestions([answered], [SECOND]);
    expect(d.deduped).toEqual([]);
    expect(d.incoming).toEqual([SECOND]);
  });

  it("an update of the open card itself is never a duplicate (the self rule)", () => {
    const reworded = { ...FIRST, why: "Choose now." } as ExpectedOutput;
    const d = dedupeOpenQuestions([FIRST], [reworded]);
    expect(d.deduped).toEqual([]);
    expect(d.incoming).toEqual([reworded]);
  });

  it("a stored slot of the agent's handed over as the twin: it stays as stored", () => {
    const agentsOwn = {
      key: "disposition-esteban-arias",
      kind: "decision",
      label: SECOND.label,
      status: "pending",
    } as ExpectedOutput;
    const d = dedupeOpenQuestions([FIRST, agentsOwn], [SECOND]);
    expect(d.incoming).toEqual([agentsOwn]);
    expect(d.deduped).toHaveLength(1);
  });
});

describe("applyOutputMutations — only an agent's patch is deduped", () => {
  it("an agent's list (keepUnlisted) makes no second card and reports it", () => {
    const r = applyOutputMutations(
      [WORK, FIRST],
      { expectedOutputs: [SECOND] },
      { keepUnlisted: true, askedBy: "agent-1" }
    );
    expect(r.outputs.filter((o) => o.owner === "human")).toHaveLength(1);
    expect(r.outputs.map((o) => o.label)).not.toContain(SECOND.label);
    expect(r.deduped).toEqual([
      expect.objectContaining({ label: FIRST.label, asked: SECOND.label }),
    ]);
  });

  it("an agent's addOutput twin is dropped too", () => {
    const r = applyOutputMutations(
      [FIRST],
      {
        addOutput: {
          kind: "decision",
          label: SECOND.label,
          owner: "human",
          blockedReason: "decision",
          ask: SECOND.ask,
        } as never,
      },
      { keepUnlisted: true }
    );
    expect(r.outputs).toHaveLength(1);
    expect(r.deduped).toHaveLength(1);
  });

  it("CONTROL: the person's own list is theirs — no dedupe", () => {
    const r = applyOutputMutations([FIRST], {
      expectedOutputs: [FIRST, SECOND],
    });
    expect(r.outputs.map((o) => o.label)).toEqual([FIRST.label, SECOND.label]);
    expect(r.deduped).toBeUndefined();
  });
});
