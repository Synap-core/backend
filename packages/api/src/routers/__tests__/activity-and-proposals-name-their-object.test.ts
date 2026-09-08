/**
 * A CARD MUST NAME THE OBJECT IT IS ABOUT.
 *
 * Two fixes are pinned here, both from the founder's complaint: "instead of
 * saying AI edit documents, we can just say … the name of the document".
 *
 *  1. `hub-protocol/documents.ts` filed every AI document-edit proposal with the
 *     hardcoded literal `"AI document edit proposal"` — a string that describes
 *     the PRODUCER and never the thing produced, so every such row in the queue
 *     was indistinguishable from every other one.
 *
 *  2. `events.search` — the door relay's activity feed reads — returned no
 *     subject name at all, while `subscriptions.ts` had carried an 8-table,
 *     visibility-floored batch resolver for exactly that all along. Relay could
 *     only guess from the payload, so rows rendered as a bare "Created".
 *
 * Both are asserted structurally (the wire) AND behaviourally where a pure
 * function allows it. The structural halves exist because the failure mode is a
 * FORK — a second literal, or a second resolver — which a value test cannot see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

describe("document edit proposals name the document", () => {
  it("composes the title through the vocabulary SSOT", () => {
    expect(
      buildObjectActionTitle({
        action: "update",
        objectKind: "document",
        objectName: "Q3 launch brief",
      })
    ).toBe('Update Document "Q3 launch brief"');
  });

  it("no longer files the hardcoded literal", () => {
    const src = read("../hub-protocol/documents.ts");
    // The literal itself, in any casing/spacing a reintroduction would use.
    expect(src).not.toMatch(/summary:\s*"AI document edit proposal"/i);
  });

  it("passes the loaded document's real title into the summary", () => {
    const src = read("../hub-protocol/documents.ts");
    // The proposal's summary must be COMPOSED from `doc.title`, not a constant.
    // `doc` is loaded and owner-checked earlier in the same procedure.
    const summaryCall = src.match(
      /summary:\s*buildObjectActionTitle\(\{[\s\S]{0,240}?\}\)/
    );
    expect(
      summaryCall,
      "summary is not built by buildObjectActionTitle"
    ).not.toBeNull();
    expect(summaryCall![0]).toContain("objectName: doc.title");
    expect(summaryCall![0]).toContain('objectKind: "document"');
  });
});

describe("events.search resolves subject names — through the ONE resolver", () => {
  it("imports the resolver from subscriptions.ts rather than declaring one", () => {
    const src = read("../events.ts");
    expect(src).toMatch(
      /import\s*\{[\s\S]{0,120}?resolveSubjectNames[\s\S]{0,120}?\}\s*from\s*"\.\/subscriptions\.js"/
    );
    // A second resolver is the failure this guards: eight visibility predicates
    // forked is how a name leaks. `events.ts` must not declare its own.
    expect(src).not.toMatch(/function\s+resolveSubjectNames/);
    expect(src).not.toMatch(/function\s+subjectKey/);
  });

  it("the resolver is actually exported and callable (the binding, not the name)", async () => {
    const mod = await import("../subscriptions.js");
    expect(typeof mod.resolveSubjectNames).toBe("function");
    expect(typeof mod.subjectKey).toBe("function");
    expect(mod.subjectKey("entity", "abc")).toBe("entity:abc");
    // An empty page must not touch the database at all — this is the property
    // that keeps the door cheap, and it runs with no connection.
    await expect(mod.resolveSubjectNames([], "user-1")).resolves.toEqual(
      new Map()
    );
  });

  it("keeps the page bounded so the batch resolver stays cheap", () => {
    const src = read("../events.ts");
    // The resolver costs ≤1 query per DISTINCT subject type, not per event —
    // but the page must still be capped, or the in-memory grouping is unbounded.
    expect(src).toMatch(/limit:\s*z\.number\(\)\.min\(1\)\.max\(100\)/);
  });

  it("omits subjectName rather than fabricating one", () => {
    const src = read("../events.ts");
    // Fail-open: an id the caller cannot see is absent from the map, and the
    // event is returned untouched. No `?? something` fallback may appear.
    expect(src).toMatch(
      /name\s*\?\s*\{\s*\.\.\.event,\s*subjectName:\s*name\s*\}\s*:\s*event/
    );
  });
});
