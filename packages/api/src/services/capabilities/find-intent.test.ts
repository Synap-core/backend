/**
 * `findByIntent` — the discovery door.
 *
 * WHAT IS MOCKED, AND WHY ONLY THAT. Exactly two I/O boundaries are stubbed:
 * `listCapabilities` (6 SQL round trips) and `matchSessionTemplate` (a 7th).
 * Everything between the wire rows and the wire answer is the REAL code —
 * `projectRunnableActions`, `runPosture`, `rankByTerms`, `foldVerbsByIntent`.
 * That is deliberate: the defect this door exists to prevent is a field that is
 * declared but never populated, and a test that hand-builds the output
 * downstream of the projection cannot see it. So the fixtures below are
 * registry ROWS, and every assertion reads the door's own answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AbstractVerb } from "@synap/database/schema";

import type { RegistryCapability } from "./capability-registry.js";
import { TEMPLATE_OPT_OUT } from "../focus-sessions/match-session-template.js";

const listCapabilities = vi.fn();
const matchSessionTemplate = vi.fn();

vi.mock("./capability-registry.js", () => ({
  listCapabilities: (...a: unknown[]) => listCapabilities(...a),
}));
vi.mock("../focus-sessions/match-session-template.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  matchSessionTemplate: (...a: unknown[]) => matchSessionTemplate(...a),
}));

const { findByIntent } = await import("./find-intent.js");

const GMAIL_SEND_ARGS = {
  type: "object",
  properties: {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["to", "body"],
};

/** A provider row shaped exactly as `listCapabilities` emits one. */
function provider(
  over: Partial<RegistryCapability> & { name: string }
): RegistryCapability {
  return {
    id: `cap-${over.name}`,
    kind: "source-provider",
    description: null,
    inputSchema: {},
    executor: "provider",
    governance: "auto",
    enabled: true,
    verbs: [],
    ...over,
  } as unknown as RegistryCapability;
}

function verb(over: {
  id: string;
  label: string;
  argsSchema?: Record<string, unknown>;
  intent?: AbstractVerb;
  kind?: "read" | "write" | "action";
}) {
  return {
    kind: "action" as const,
    granted: true,
    govDefault: "auto" as const,
    effectiveExecMode: "auto" as const,
    backingSkillExecutable: true,
    ...over,
  };
}

const CATALOG: RegistryCapability[] = [
  provider({
    name: "Google",
    description: "Gmail, Calendar and Drive for this pod",
    connection: { required: true, connected: true, provider: "google" },
    verbs: [
      verb({
        id: "gmail_send",
        label: "Send email",
        argsSchema: GMAIL_SEND_ARGS,
        intent: "send_message",
      }),
      verb({ id: "gmail_search", label: "Search email", kind: "read" }),
      verb({ id: "calendar_create_event", label: "Create calendar event" }),
    ],
  } as never),
  provider({
    name: "Contact hygiene",
    description: "Merge duplicate contact records",
    verbs: [
      verb({
        id: "contacts_dedupe",
        label: "Dedupe contacts",
        argsSchema: {
          type: "object",
          properties: { dryRun: { type: "boolean" } },
        },
      }),
    ],
  }),
  provider({
    name: "Housekeeping",
    description: "Clean up stale rows",
    verbs: [verb({ id: "cleanup_run", label: "Clean up workspace" })],
  }),
];

const NO_PLAYBOOKS = { candidates: [], optOut: TEMPLATE_OPT_OUT };

beforeEach(() => {
  listCapabilities.mockReset().mockResolvedValue(CATALOG);
  matchSessionTemplate.mockReset().mockResolvedValue(NO_PLAYBOOKS);
});

const lens = { workspaceId: null, userId: "u1" };

describe("findByIntent — reachability: the RIGHT verb, WITH its schema", () => {
  it("routes 'send an email to a client' to gmail_send and attaches its declared argsSchema", async () => {
    const r = await findByIntent({
      intent: "send an email to a client",
      ...lens,
    });

    const top = r.capabilities!.matches[0]!;
    expect(top.action.verbId).toBe("gmail_send");
    // Not "the key exists" — the VALUE arrives, down to the required list an
    // agent needs in order to call the verb without a second lookup.
    expect(top.argsSchema).toEqual(GMAIL_SEND_ARGS);
    expect((top.argsSchema as { required: string[] }).required).toEqual([
      "to",
      "body",
    ]);
    // The projection's own facts ride along, unmodified.
    expect(top.action.governance).toBe("auto");
    expect(top.action.intent).toBe("send_message");
    expect(top.whenToUse).toBe("Gmail, Calendar and Drive for this pod");
  });

  it("keeps the NOUN: 'clean up duplicate contacts' beats a generic cleanup verb", async () => {
    const r = await findByIntent({
      intent: "clean up duplicate contacts",
      ...lens,
    });
    const ids = r.capabilities!.matches.map((m) => m.action.verbId);
    expect(ids[0]).toBe("contacts_dedupe");
    expect(ids).toContain("cleanup_run");
    // The discriminating token reached the ranker — it is IN the explanation,
    // which is what proves the full query was matched and not a residue with
    // the noun stripped out.
    expect(r.capabilities!.matches[0]!.match.terms).toContain("contact");
    // …and dropping it flips the answer, which is what makes the token
    // load-bearing rather than decorative.
    const withoutNoun = await findByIntent({ intent: "clean up", ...lens });
    expect(withoutNoun.capabilities!.matches[0]!.action.verbId).toBe(
      "cleanup_run"
    );
  });

  it("a verb with no declared argsSchema carries none — never a fabricated {}", async () => {
    const r = await findByIntent({ intent: "calendar event", ...lens });
    const ev = r.capabilities!.matches.find(
      (m) => m.action.verbId === "calendar_create_event"
    )!;
    expect(ev).toBeDefined();
    expect("argsSchema" in ev).toBe(false);
  });
});

describe("findByIntent — per-catalog scoring", () => {
  it("normalises each catalog against ITS OWN best, and names the scale", async () => {
    const r = await findByIntent({ intent: "send a message", ...lens });
    // Both arms matched, and each one's top row is 1 — a shared denominator
    // would leave at most one of them at 1.
    expect(r.capabilities!.matches[0]!.confidence).toBe(1);
    expect(r.intents!.matches[0]!.confidence).toBe(1);
    expect(r.intents!.matches[0]!.intent).toBe("send_message");
    // What makes the assertion above DISCRIMINATING rather than decorative:
    // the two rankers disagree, and the capability arm scores LOWER. So a
    // shared denominator could not leave the capability top row at 1 — it
    // would read ~0.36. Pinned, because if a fixture change ever flipped this
    // ordering the guard above would silently stop proving anything.
    //
    // MEASURED LIMIT: this catches a shared denominator on the CAPABILITY
    // side only. Mutating the intents denominator to `max(intents, caps)` is
    // green here, because the intents arm is the larger of the two — verified
    // by running exactly that mutation. Covering the other direction needs a
    // fixture where the capability arm outranks the intent arm.
    expect(r.capabilities!.matches[0]!.score).toBeLessThan(
      r.intents!.matches[0]!.score
    );
    expect(r.scoring.capabilities!.scale).toMatch(/best capability score/);
    expect(r.scoring.intents!.scale).toMatch(/best intent score/);
    expect(r.scoring.playbooks!.note).toMatch(/not comparable/);
  });

  it("the intent arm resolves to CONCRETE verb ids under the caller's lens", async () => {
    const r = await findByIntent({ intent: "send a message", ...lens });
    const sendMessage = r.intents!.matches.find(
      (m) => m.intent === "send_message"
    )!;
    expect(sendMessage.verbs.map((v) => v.verbId)).toEqual(["gmail_send"]);
  });

  it("termCoverage is absolute — measured on the query, comparable across catalogs", async () => {
    const r = await findByIntent({ intent: "send a message", ...lens });
    // "a" is a stopword; the query reduces to two terms.
    expect(r.coverage.queryTerms).toEqual(["send", "messag"]);
    expect(r.capabilities!.matches[0]!.termCoverage.of).toBe(2);
    expect(r.intents!.matches[0]!.termCoverage).toEqual({ hit: 2, of: 2 });
  });
});

describe("findByIntent — ABSENT is not EMPTY", () => {
  it("a catalog not searched is ABSENT; a catalog searched with no hit is EMPTY", async () => {
    const r = await findByIntent({
      intent: "send an email",
      catalogs: ["capabilities"],
      ...lens,
    });
    expect("intents" in r).toBe(false);
    expect("playbooks" in r).toBe(false);
    expect(matchSessionTemplate).not.toHaveBeenCalled();

    const all = await findByIntent({ intent: "send an email", ...lens });
    // Searched, nothing fit — present with an empty list, a different fact.
    expect(all.intents!.matches.map((m) => m.intent)).not.toContain(
      "schedule_event"
    );
    expect(all.playbooks).toEqual(NO_PLAYBOOKS);
    expect(all.playbooks!.optOut).toBe(TEMPLATE_OPT_OUT);
  });

  it("unknown catalog names fall back to all three rather than searching nothing", async () => {
    const r = await findByIntent({
      intent: "send an email",
      catalogs: ["nonsense"],
      ...lens,
    });
    expect("capabilities" in r).toBe(true);
    expect("intents" in r).toBe(true);
    expect("playbooks" in r).toBe(true);
  });
});

describe("findByIntent — a miss is never bare emptiness", () => {
  it("carries the escalation ladder AND measured coverage when nothing matched", async () => {
    const r = await findByIntent({ intent: "xyzzy plugh", ...lens });
    expect(r.capabilities!.matches).toEqual([]);
    expect(r.intents!.matches).toEqual([]);

    const miss = r.noConfidentMatch!;
    expect(miss).toBeDefined();
    expect(miss.reason).toMatch(/NOT proof/);
    // The ladder is DOORS, not advice to go read a skill.
    expect(miss.escalation.map((e) => e.door).join(" ")).toMatch(
      /synap_run_capability/
    );
    expect(miss.escalation.map((e) => e.door).join(" ")).toMatch(
      /market\.install/
    );
    expect(miss.escalation.map((e) => e.door).join(" ")).toMatch(
      /tool\.request/
    );
    // Coverage is MEASURED off the rows that were read — this is the signal
    // that separates "the pod cannot do this" from "the index is incomplete".
    expect(miss.coverage.capabilityRows).toBe(3);
    expect(miss.coverage.runnableActions).toBe(5);
    expect(miss.coverage.verbs).toBe(5);
    expect(miss.coverage.verbsDeclaringIntent).toBe(1);
    expect(miss.coverage.abstractVerbs).toBeGreaterThan(5);
  });

  it("no noConfidentMatch when ANY catalog produced a match", async () => {
    matchSessionTemplate.mockResolvedValue({
      candidates: [
        {
          id: "pb-1",
          name: "Inbox zero",
          score: 3,
          reason: 'You mentioned "xyzzy"',
        },
      ],
      optOut: TEMPLATE_OPT_OUT,
    });
    const r = await findByIntent({ intent: "xyzzy plugh", ...lens });
    expect(r.capabilities!.matches).toEqual([]);
    expect(r.playbooks!.candidates).toHaveLength(1);
    expect(r.noConfidentMatch).toBeUndefined();
  });
});

describe("findByIntent — one registry read serves both capability arms", () => {
  it("reads the registry once, unbounded, with no query of its own", async () => {
    await findByIntent({ intent: "send an email", ...lens });
    expect(listCapabilities).toHaveBeenCalledTimes(1);
    const [ctx, opts] = listCapabilities.mock.calls[0]!;
    expect(ctx).toEqual({ workspaceId: null, userId: "u1" });
    // A `query` here would rank the raw ROWS before the runnable-action
    // candidate set exists; a numeric limit would slice it.
    expect(opts).toEqual({ limit: null });
  });

  it("skips the registry read entirely when only playbooks are asked for", async () => {
    await findByIntent({
      intent: "send an email",
      catalogs: ["playbooks"],
      ...lens,
    });
    expect(listCapabilities).not.toHaveBeenCalled();
    expect(matchSessionTemplate).toHaveBeenCalledTimes(1);
  });
});

/**
 * SOURCE SCAN — the founder decision "match on the FULL QUERY" is a property of
 * what this module does NOT call, and no behavioural test can observe an
 * absence. So it is scanned, with a non-vacuity self-check.
 *
 * WHAT IT DOES NOT COVER, measured: it reads THIS file only. A future caller
 * could pass a pre-cleaned string INTO `findByIntent`, and this scan would stay
 * green — the behavioural test above ("keeps the NOUN") is what covers the
 * value actually reaching the ranker.
 */
describe("tripwire: the door never routes through understandQuery's residue", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "find-intent.ts"),
    "utf8"
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("the scan can see this file's code at all (non-vacuity)", () => {
    expect(code).toContain("rankByTerms");
    expect(code.length).toBeGreaterThan(1000);
  });

  it("no import of, or call to, understandQuery / cleanedQuery", () => {
    expect(code).not.toMatch(/understandQuery|cleanedQuery|understand-query/);
  });
});
