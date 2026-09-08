/**
 * `ExpectedOutput.ref` — the pointer a declared slot carries, end to end.
 *
 * WHAT IT IS FOR. An agent that declares an owed deliverable, or blocks one on
 * the person, could previously only hand over PROSE: "the Stripe restricted key
 * for the live account" names the missing thing and leaves you to find the page
 * yourself. `ref` makes the card's title a DOOR.
 *
 * FOUR PROPERTIES ARE PINNED HERE, and each one is a defect this codebase has
 * shipped in another field:
 *
 *   1. THE UNION IS CLOSED AT THE PARSE. Two arms, both `.strict()`. A
 *      `javascript:` url is a stored script vector — the session room renders
 *      this string as a link — and a `{kind}` outside the six the visibility
 *      floor can adjudicate would be a field declared on the wire and refused by
 *      every door: "advertised and unreachable", the signature defect.
 *   2. SILENCE KEEPS, `null` CLEARS. `ref` is in `SERVER_OWNED_OUTPUT_FIELDS`
 *      for ERASURE, so a browser that has never heard of it cannot drop the
 *      door the agent put on the card by renaming a sibling. That makes an
 *      explicit `null` the only way to say "remove it".
 *   3. A STORED SLOT NEVER CARRIES `null`. The wire's clear value is erased by
 *      the merge, so `ref` stays two-state for every reader downstream.
 *   4. THE DOOR REFUSES WHAT THE FLOOR REFUSES, LOUDLY. A dropped pointer under
 *      a 200 would put an undoorable card on the board and tell the caller
 *      otherwise — and the write must not happen at all.
 *
 * The DB is reached only in the last block, through a partial mock whose
 * `transaction` THROWS: a refusal that reaches the write is therefore a test
 * failure, not a silent pass.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { OUTPUT_REF_KINDS } from "@synap/playbooks";
import {
  expectedOutputWireSchema,
  outputRefWireSchema,
  mergeExpectedOutputs,
  CLIENT_DECLARABLE_OUTPUT_FIELDS,
  SERVER_OWNED_OUTPUT_FIELDS,
  SERVER_STAMPED_OUTPUT_FIELDS,
} from "../update-session.js";
import { stampBlocked, stampUnblocked } from "../block-output.js";
import { SESSION_ARTIFACT_KINDS } from "../record-session-artifact.js";

const UUID = "33333333-3333-4333-8333-333333333333";

// ── 0. the kind list is DERIVED, not two hand-kept copies ───────────────────

describe("OUTPUT_REF_KINDS mirrors the artifact kinds the floor can adjudicate", () => {
  it("is exactly SESSION_ARTIFACT_KINDS minus `url`", () => {
    // `url` is the OTHER arm of the union, not a kind. Every remaining artifact
    // kind has a branch in `isOutputRefVisible`, which is the whole reason this
    // list is these six and not the 37-kind OBJECT_KINDS vocabulary: a kind the
    // floor cannot adjudicate is a kind every door would have to refuse.
    expect([...OUTPUT_REF_KINDS].sort()).toEqual(
      SESSION_ARTIFACT_KINDS.filter((k) => k !== "url")
        .slice()
        .sort()
    );
    // Non-vacuity: the derivation is looking at a plausible number of things.
    expect(OUTPUT_REF_KINDS.length).toBeGreaterThanOrEqual(6);
  });
});

// ── 1. the union, at the parse ──────────────────────────────────────────────

describe("outputRefWireSchema — one union, two arms", () => {
  it("accepts an in-pod object ref for every adjudicable kind", () => {
    for (const kind of OUTPUT_REF_KINDS) {
      expect(outputRefWireSchema.parse({ kind, id: UUID })).toEqual({
        kind,
        id: UUID,
      });
    }
  });

  it("accepts an http(s) link", () => {
    expect(
      outputRefWireSchema.parse({ url: "https://stripe.com/keys" })
    ).toEqual({ url: "https://stripe.com/keys" });
    // Loopback is legitimate: nothing FETCHES this, it is rendered as a link.
    expect(
      outputRefWireSchema.parse({ url: "http://localhost:3000/x" })
    ).toEqual({ url: "http://localhost:3000/x" });
  });

  it("REFUSES a script-capable scheme — this string is rendered as a link", () => {
    expect(() =>
      outputRefWireSchema.parse({ url: "javascript:alert(1)" })
    ).toThrow();
    expect(() =>
      outputRefWireSchema.parse({ url: "data:text/html,<script>x</script>" })
    ).toThrow();
    expect(() =>
      outputRefWireSchema.parse({ url: "file:///etc/passwd" })
    ).toThrow();
    expect(() => outputRefWireSchema.parse({ url: "not a url" })).toThrow();
  });

  it("REFUSES a kind the visibility floor cannot adjudicate", () => {
    // `url` is the other arm; `task`/`proposal`/… are OBJECT_KINDS members with
    // no branch in `isOutputRefVisible`. Accepting them would declare a field
    // no door could ever satisfy.
    expect(() =>
      outputRefWireSchema.parse({ kind: "url", id: UUID })
    ).toThrow();
    expect(() =>
      outputRefWireSchema.parse({ kind: "task", id: UUID })
    ).toThrow();
    expect(() =>
      outputRefWireSchema.parse({ kind: "proposal", id: UUID })
    ).toThrow();
  });

  it("REFUSES a half-filled or mixed arm rather than silently picking one", () => {
    expect(() => outputRefWireSchema.parse({ kind: "entity" })).toThrow();
    expect(() => outputRefWireSchema.parse({ id: UUID })).toThrow();
    expect(() =>
      outputRefWireSchema.parse({ kind: "entity", id: "" })
    ).toThrow();
    // Both arms are `.strict()`. Without that, zod strips the unknown key and a
    // caller confused about which arm it wants is told it succeeded.
    expect(() =>
      outputRefWireSchema.parse({
        kind: "entity",
        id: UUID,
        url: "https://x.io",
      })
    ).toThrow();
  });
});

describe("expectedOutputWireSchema carries `ref`", () => {
  it("round-trips both arms on a whole slot", () => {
    const withObject: ExpectedOutput = {
      kind: "document",
      label: "Launch brief",
      ref: { kind: "document", id: UUID },
    };
    expect(expectedOutputWireSchema.parse(withObject)).toEqual(withObject);
    const withUrl: ExpectedOutput = {
      kind: "url",
      label: "Stripe key",
      owner: "human",
      blockedReason: "credential",
      why: "The restricted key for the live account",
      ref: { url: "https://dashboard.stripe.com/apikeys" },
    };
    expect(expectedOutputWireSchema.parse(withUrl)).toEqual(withUrl);
  });

  it("accepts an explicit null — the wire's CLEAR", () => {
    expect(
      expectedOutputWireSchema.parse({ kind: "doc", label: "X", ref: null })
    ).toEqual({ kind: "doc", label: "X", ref: null });
  });

  it("classifies `ref` as client-declarable and erasure-protected, never stamped", () => {
    // Declaring WHERE something lives is not a claim that it landed, so `ref`
    // may never sit among the receipts — a client-declarable field cannot close
    // a slot, and a stamped one cannot be authored by an agent at all.
    expect(CLIENT_DECLARABLE_OUTPUT_FIELDS).toContain("ref");
    expect(SERVER_OWNED_OUTPUT_FIELDS).toContain("ref");
    expect(SERVER_STAMPED_OUTPUT_FIELDS).not.toContain("ref");
  });
});

// ── 2 & 3. the merge ────────────────────────────────────────────────────────

describe("mergeExpectedOutputs — silence keeps a ref, null clears it", () => {
  const stored = (): ExpectedOutput[] => [
    {
      kind: "document",
      label: "Launch brief",
      ref: { kind: "document", id: UUID },
    },
  ];

  it("KEEPS the ref across a patch that omits it", () => {
    // The defect this prevents: the browser reads the array, renames a label,
    // sends the whole thing back — and the door the agent put on the card is
    // gone, with nobody told.
    const [merged] = mergeExpectedOutputs(stored(), [
      { kind: "document", label: "Launch brief" },
    ]);
    expect(merged.ref).toEqual({ kind: "document", id: UUID });
  });

  it("REPLACES the ref when the patch states a different one", () => {
    const [merged] = mergeExpectedOutputs(stored(), [
      {
        kind: "document",
        label: "Launch brief",
        ref: { url: "https://notion.so/brief" },
      },
    ]);
    expect(merged.ref).toEqual({ url: "https://notion.so/brief" });
  });

  it("CLEARS on an explicit null, and stores no null", () => {
    const [merged] = mergeExpectedOutputs(stored(), [
      { kind: "document", label: "Launch brief", ref: null },
    ]);
    // Property 3: the key is GONE, not present-and-null. Every reader may test
    // `slot.ref` for truthiness without knowing about a third state.
    expect(merged).not.toHaveProperty("ref");
  });

  it("stores no null for a BRAND-NEW slot either", () => {
    const [, added] = mergeExpectedOutputs(stored(), [
      { kind: "document", label: "Launch brief" },
      { kind: "entity", label: "Signed NDA", ref: null },
    ]);
    expect(added).not.toHaveProperty("ref");
  });
});

// ── the targeted stamper ────────────────────────────────────────────────────

describe("stampBlocked — the blocker and its door land together", () => {
  const slots = (): ExpectedOutput[] => [
    { kind: "entity", label: "Signed NDA" },
    { kind: "url", label: "Stripe key", ref: { url: "https://old.example/x" } },
  ];
  const AT = new Date("2026-09-08T09:00:00.000Z");

  it("writes the ref alongside owner/reason/why/owedSince", () => {
    const [blocked] = stampBlocked(
      slots(),
      "Signed NDA",
      "physical",
      "Sign the paper copy",
      AT,
      {
        url: "https://docs.example/nda.pdf",
      }
    );
    expect(blocked).toEqual({
      kind: "entity",
      label: "Signed NDA",
      owner: "human",
      blockedReason: "physical",
      why: "Sign the paper copy",
      owedSince: AT.toISOString(),
      ref: { url: "https://docs.example/nda.pdf" },
    });
  });

  it("leaves a stored ref alone when none is supplied", () => {
    // Handing a slot over says nothing about a pointer somebody already put on
    // it. `undefined` is not an instruction.
    const [, blocked] = stampBlocked(
      slots(),
      "Stripe key",
      "credential",
      undefined,
      AT
    );
    expect(blocked.ref).toEqual({ url: "https://old.example/x" });
  });

  it("clears a stored ref on an explicit null — the same three-state contract as the wire", () => {
    const [, blocked] = stampBlocked(
      slots(),
      "Stripe key",
      "credential",
      undefined,
      AT,
      null
    );
    expect(blocked).not.toHaveProperty("ref");
  });

  it("unblock does NOT clear the ref — it describes the deliverable, not the blocker", () => {
    const [, reclaimed] = stampUnblocked(
      stampBlocked(slots(), "Stripe key", "credential", undefined, AT),
      "Stripe key"
    );
    expect(reclaimed.ref).toEqual({ url: "https://old.example/x" });
    // The four ownership fields are what go together, both ways.
    expect(reclaimed).not.toHaveProperty("owner");
    expect(reclaimed).not.toHaveProperty("blockedReason");
    expect(reclaimed).not.toHaveProperty("owedSince");
  });
});
