/**
 * Ask materialization: the validation rules (`planAskDefinitions`) and the
 * filing rules (`materializeAskDefinitions`), with the session side
 * (`ask-slots.ts`) replaced by an in-memory session. The REAL slot door
 * (`updateFocusSession`, `expectedOutputWireSchema`) is driven by
 * `materialize-asks.pglite.test.ts`; the two document doors by
 * `apply-document-patch.pglite.test.ts` and
 * `hub-protocol/documents.create-ask.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";

interface FakeSession {
  userId: string;
  status: string;
  expectedOutputs: ExpectedOutput[];
}
const fake = vi.hoisted(() => ({
  sessions: new Map<string, FakeSession>(),
  filed: [] as ExpectedOutput[][],
  mode: "updated" as "updated" | "proposed" | "refused" | "silent",
  /** Runs right after a successful filing: a parallel write landing in between. */
  afterFiling: null as null | ((s: FakeSession) => void),
  /** The key the server stamps on a filed slot, when it is not the proposed one. */
  mintKey: null as null | string,
}));

vi.mock("./ask-slots.js", () => ({
  readAskSession: async (a: { sessionId: string; userId: string }) => {
    const s = fake.sessions.get(a.sessionId);
    return s && s.userId === a.userId
      ? { status: s.status, expectedOutputs: s.expectedOutputs }
      : null;
  },
  buildAskSlot: async (spec: Record<string, unknown>) => ({
    kind: "ask",
    owner: "human",
    ...spec,
  }),
  fileAskSlots: async (a: { sessionId: string; slots: ExpectedOutput[] }) => {
    fake.filed.push(a.slots);
    if (fake.mode === "proposed")
      return {
        status: "proposed",
        proposalId: "prop-9",
        reviewUrl: "https://pod/open/prop-9",
      };
    if (fake.mode === "refused")
      return { status: "refused", reason: "not allowed" };
    if (fake.mode === "updated") {
      const s = fake.sessions.get(a.sessionId)!;
      s.expectedOutputs = [
        ...s.expectedOutputs,
        ...a.slots.map((slot) =>
          fake.mintKey ? { ...slot, key: fake.mintKey } : slot
        ),
      ];
      fake.afterFiling?.(s);
    }
    return { status: "updated" };
  },
}));

import { readEmbed } from "@synap-core/markdown-core/embeds";
import { parseMarkdown } from "@synap-core/markdown-core/processor";
import {
  holdsAskDefinition,
  materializeAskDefinitions,
  materializeAskDefinitionsInOps,
  opsHoldAskDefinition,
  planAskDefinitions,
} from "./materialize-asks.js";

const USER = "user-1";
const AGENT = "agent-1";
const SESSION = "6f1c2b0e-0a52-4c4e-9d33-2d6c0f6d9a11";
const OTHER = "0a0a0a0a-0a52-4c4e-9d33-2d6c0f6d9a11";

const CHOOSE = {
  mode: "choose",
  options: [{ label: "PostgreSQL", recommended: true }, { label: "SQLite" }],
};
const def = (props: Record<string, unknown>, prose = "Which database?") =>
  [
    ":::synap-ask",
    "```json",
    JSON.stringify(props),
    "```",
    "",
    prose,
    ":::",
  ].join("\n");
const DB = def({
  key: "which-database",
  label: "Which database?",
  ask: CHOOSE,
});
const REF = (session: string, slot: string) =>
  `:::synap-ask{sessionId="${session}" slot="${slot}"}\nWhich?\n:::`;

const author = {
  userId: USER,
  agentUserId: AGENT,
  sessionId: SESSION,
  namedSessionId: null,
};

function seed(expectedOutputs: ExpectedOutput[] = [], status = "active") {
  fake.sessions.set(SESSION, { userId: USER, status, expectedOutputs });
}
const stored = () => fake.sessions.get(SESSION)!.expectedOutputs;

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  fake.sessions.clear();
  fake.filed = [];
  fake.mode = "updated";
  fake.afterFiling = null;
  fake.mintKey = null;
  seed();
});

describe("planAskDefinitions", () => {
  it("no definition: ok with no plans", () => {
    expect(planAskDefinitions(["# Plan\n\nText."])).toEqual({
      ok: true,
      plans: [],
    });
  });

  it("a valid definition: key, label, ask", () => {
    const r = planAskDefinitions([DB]);
    expect(r.ok && r.plans[0]).toMatchObject({
      key: "which-database",
      label: "Which database?",
      textIndex: 0,
    });
  });

  it("key falls back to the label's slug; label to the prose's first line", () => {
    const r = planAskDefinitions([def({ ask: CHOOSE }, "Which cloud?")]);
    expect(r.ok && r.plans[0]).toMatchObject({
      key: "which-cloud",
      label: "Which cloud?",
    });
  });

  it("an invalid ask names the failing field and the skill", () => {
    const r = planAskDefinitions([
      def({ key: "k", label: "L", ask: { mode: "choose", options: [] } }),
    ]);
    expect(!r.ok && r.message).toMatch(/ask\.options/);
    expect(!r.ok && r.message).toMatch(/system\/synap\/asks/);
  });

  it("an unknown props field is refused (strict)", () => {
    const r = planAskDefinitions([
      def({ key: "k", label: "L", ask: CHOOSE, sessionId: SESSION }),
    ]);
    expect(!r.ok && r.message).toMatch(/sessionId/);
  });

  it("a blockedReason outside the closed list is refused", () => {
    const r = planAskDefinitions([
      def({ key: "k", label: "L", ask: CHOOSE, blockedReason: "because" }),
    ]);
    expect(!r.ok && r.message).toMatch(/blockedReason/);
  });

  it("a missing ask object is refused, with the skill", () => {
    const r = planAskDefinitions([def({ key: "k", label: "L" })]);
    expect(!r.ok && r.message).toMatch(/needs an `ask` object/);
    expect(!r.ok && r.message).toMatch(/system\/synap\/asks/);
  });

  it("two definitions with one key are refused", () => {
    const r = planAskDefinitions([`${DB}\n\n${DB}`]);
    expect(!r.ok && r.message).toMatch(/share the key "which-database"/);
  });

  it("more than 20 definitions in one write are refused", () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      def({ key: `k-${i}`, label: `L${i}`, ask: CHOOSE })
    ).join("\n\n");
    const r = planAskDefinitions([many]);
    expect(!r.ok && r.message).toMatch(/at most 20/);
  });

  it("a definition inside a code fence is invisible", () => {
    expect(planAskDefinitions(["```\n" + DB + "\n```"])).toEqual({
      ok: true,
      plans: [],
    });
  });

  it("an indented opener is refused: the renderer does not read it as the same block", () => {
    const r = planAskDefinitions([`  ${DB.split("\n").join("\n  ")}`]);
    expect(!r.ok && r.message).toMatch(/beginning of a line/);
  });

  it("a ```json-x fence is not the props block the renderer reads: no definition", () => {
    expect(planAskDefinitions([DB.replace("```json", "```json-x")])).toEqual({
      ok: true,
      plans: [],
    });
  });

  it("a definition inside an HTML comment is refused (the renderer hides it)", () => {
    const r = planAskDefinitions([`<!--\n${DB}\n-->`]);
    expect(!r.ok && r.message).toMatch(/HTML comment/);
  });
});

describe("holdsAskDefinition / opsHoldAskDefinition", () => {
  it("a definition, or an unreadable one, is held; prose and references are not", () => {
    expect(holdsAskDefinition([DB])).toBe(true);
    expect(holdsAskDefinition([DB.replace('"key"', "{ nope")])).toBe(true);
    expect(holdsAskDefinition(["Plain text."])).toBe(false);
    expect(holdsAskDefinition([REF(SESSION, "x")])).toBe(false);
    expect(
      opsHoldAskDefinition([
        { op: "replace_text", old: "a", new: "b" },
        { op: "append", body: DB },
      ] as never)
    ).toBe(true);
    expect(opsHoldAskDefinition([{ op: "append", body: "Hi" }] as never)).toBe(
      false
    );
  });
});

describe("materializeAskDefinitions", () => {
  it("files the slot and writes the reference form on the author's session", async () => {
    const r = await materializeAskDefinitions([`# Plan\n\n${DB}`], author);
    expect(r.changed).toBe(true);
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]![0]).toMatchObject({
      key: "which-database",
      label: "Which database?",
      owner: "human",
    });
    expect(r.texts[0]).toContain(`sessionId="${SESSION}"`);
    expect(r.texts[0]).toContain(`slot="which-database"`);
    expect(r.texts[0]).not.toContain("```json");
    const tree = parseMarkdown(r.texts[0]!) as { children: unknown[] };
    const embed = readEmbed(
      tree.children.find(
        (n) => (n as { type: string }).type === "containerDirective"
      ) as never
    );
    expect(embed?.ref).toMatchObject({
      sessionId: SESSION,
      slot: "which-database",
    });
  });

  it("a reference form is returned untouched, and files nothing", async () => {
    const first = await materializeAskDefinitions([DB], author);
    const again = await materializeAskDefinitions([first.texts[0]!], author);
    expect(again.changed).toBe(false);
    expect(again.texts).toEqual(first.texts);
    expect(fake.filed).toHaveLength(1);
  });

  it("the same definition sent again reuses the stored question (by session and key)", async () => {
    await materializeAskDefinitions([DB], author);
    const r = await materializeAskDefinitions([DB], author);
    expect(r.changed).toBe(true);
    expect(fake.filed).toHaveLength(1);
    expect(r.texts[0]).toContain(`slot="which-database"`);
  });

  it("a DIFFERENT ask under an existing key is refused, naming the key", async () => {
    await materializeAskDefinitions([DB], author);
    const other = def({
      key: "which-database",
      label: "Which database?",
      ask: { mode: "confirm" },
    });
    const e = await refusal(materializeAskDefinitions([other], author));
    expect(e.message).toMatch(
      /"which-database" already exists .* with a different ask: use the same ask or change the key\. Nothing was written\./
    );
    expect(fake.filed).toHaveLength(1);
  });

  it("the same ask with its keys in another order is the SAME ask", async () => {
    await materializeAskDefinitions([DB], author);
    const reordered = def({
      ask: {
        options: [
          { recommended: true, label: "PostgreSQL" },
          { label: "SQLite" },
        ],
        mode: "choose",
      },
      label: "Which database?",
      key: "which-database",
    });
    const r = await materializeAskDefinitions([reordered], author);
    expect(r.changed).toBe(true);
    expect(fake.filed).toHaveLength(1);
  });

  it("a parallel write that changed the ask between filing and read-back: refused, no reference", async () => {
    fake.afterFiling = (s) => {
      s.expectedOutputs = s.expectedOutputs.map((slot) => ({
        ...slot,
        ask: { mode: "confirm" },
      })) as ExpectedOutput[];
    };
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(e.message).toMatch(/changed by another write/);
  });

  it("two asks in one write: two keys, ONE slot write, stable on a re-send", async () => {
    const two = `${DB}\n\n${def({ key: "ship-friday", label: "Ship Friday?", ask: { mode: "confirm" } }, "Ship?")}`;
    const r = await materializeAskDefinitions([two], author);
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]).toHaveLength(2);
    const again = await materializeAskDefinitions([two], author);
    expect(fake.filed).toHaveLength(1);
    expect(again.texts).toEqual(r.texts);
  });

  it("the reference uses the key the session ends up with, not the proposed one", async () => {
    fake.mintKey = "minted-1";
    const r = await materializeAskDefinitions([DB], author);
    expect(r.texts[0]).toContain(`slot="minted-1"`);
    expect(r.texts[0]).not.toContain(`slot="which-database"`);
  });

  it("no verified session: refused with the fix, nothing filed", async () => {
    const e = await refusal(
      materializeAskDefinitions([DB], { ...author, sessionId: null })
    );
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(e.message).toMatch(/This write holds a question/);
    expect(e.message).toMatch(/synap_start_session/);
    expect(fake.filed).toEqual([]);
  });

  it("a write that names ANOTHER session than the verified one is refused, even the person's own", async () => {
    fake.sessions.set(OTHER, {
      userId: USER,
      status: "active",
      expectedOutputs: [],
    });
    const e = await refusal(
      materializeAskDefinitions([DB], { ...author, namedSessionId: OTHER })
    );
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(e.message).toMatch(/names session .*0a0a0a0a/);
    expect(fake.filed).toEqual([]);
    expect(fake.sessions.get(OTHER)!.expectedOutputs).toEqual([]);
  });

  it("naming the verified session itself passes", async () => {
    const r = await materializeAskDefinitions([DB], {
      ...author,
      namedSessionId: SESSION,
    });
    expect(r.changed).toBe(true);
  });

  it("a session that is not the author's: refused", async () => {
    const e = await refusal(
      materializeAskDefinitions([DB], { ...author, sessionId: OTHER })
    );
    expect(e.message).toMatch(/not one of yours/);
    expect(fake.filed).toEqual([]);
  });

  it("an ended session: refused", async () => {
    seed([], "closed");
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.message).toMatch(/has ended \(closed\)/);
    expect(fake.filed).toEqual([]);
  });

  it("slot creation only proposed: the exact short refusal, nothing written", async () => {
    fake.mode = "proposed";
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(e.message).toBe(
      "Filing the question needs a person's approval (proposal prop-9, https://pod/open/prop-9). Nothing was written. Send this same write again once it is approved."
    );
  });

  it("slot creation refused: nothing written", async () => {
    fake.mode = "refused";
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.message).toMatch(/not allowed/);
  });

  it("a slot that is not there after filing: no reference to nothing", async () => {
    fake.mode = "silent";
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.message).toMatch(/missing from session/);
  });

  it("a key that already names a non-ask output: refused", async () => {
    seed([
      { kind: "doc", label: "Report", key: "which-database" } as ExpectedOutput,
    ]);
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.message).toMatch(/not a question to a person/);
    expect(fake.filed).toEqual([]);
  });

  it("a label already used under another key: refused", async () => {
    seed([
      { kind: "doc", label: "Which database?", key: "other" } as ExpectedOutput,
    ]);
    const e = await refusal(materializeAskDefinitions([DB], author));
    expect(e.message).toMatch(
      /already has an output labelled "Which database\?"/
    );
    expect(fake.filed).toEqual([]);
  });

  it("an invalid ask next to a valid one: nothing filed", async () => {
    const bad = def({
      key: "bad",
      label: "Bad",
      ask: { mode: "choose", options: [] },
    });
    await refusal(materializeAskDefinitions([`${DB}\n\n${bad}`], author));
    expect(fake.filed).toEqual([]);
  });

  it("a reference to ANOTHER session is left as written, never repaired", async () => {
    const md = REF(OTHER, "elsewhere");
    const r = await materializeAskDefinitions([md], author);
    expect(r).toEqual({ texts: [md], changed: false });
    expect(fake.filed).toEqual([]);
  });

  it("an author with NO agent (a person, the pod) holding a valid definition: untouched, nothing filed", async () => {
    const r = await materializeAskDefinitions([DB], {
      userId: USER,
      agentUserId: null,
      sessionId: SESSION,
    });
    expect(r).toEqual({ texts: [DB], changed: false });
    expect(fake.filed).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it("a write with no definition is returned untouched, CRLF included", async () => {
    const md = "# Plan\r\n\r\nWe ship.\r\n:::note\r\nhi\r\n:::\r\n";
    const r = await materializeAskDefinitions([md], author);
    expect(r).toEqual({ texts: [md], changed: false });
  });

  it("a CRLF document WITH a definition comes back with LF line endings (the rewrite normalizes)", async () => {
    const md = `# Plan\r\n\r\n${DB.replace(/\n/g, "\r\n")}\r\n\r\nAfter.\r\n`;
    const r = await materializeAskDefinitions([md], author);
    expect(r.changed).toBe(true);
    expect(r.texts[0]).not.toContain("\r");
    expect(r.texts[0]).toContain("After.");
  });
});

describe("materializeAskDefinitionsInOps", () => {
  it("rewrites every op's markdown field once; ops without markdown pass", async () => {
    const ops = [
      { op: "append", body: DB },
      { op: "replace_text", old: "a", new: "b" },
    ] as never;
    const r = await materializeAskDefinitionsInOps(ops, author);
    expect(r.changed).toBe(true);
    expect((r.ops[0] as { body: string }).body).toContain(
      `slot="which-database"`
    );
    expect(r.ops[1]).toEqual((ops as unknown[])[1]);
    expect(fake.filed).toHaveLength(1);
  });

  it("a patch with no definition returns the SAME array", async () => {
    const ops = [{ op: "append", body: "Hello" }] as never;
    const r = await materializeAskDefinitionsInOps(ops, author);
    expect(r.changed).toBe(false);
    expect(r.ops).toBe(ops);
  });
});
