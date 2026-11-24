import { describe, expect, it } from "vitest";
import {
  appliedEdit,
  htmlPages,
  htmlReadings,
  htmlReplaceCandidate,
  htmlUnchanged,
  isHtmlDocument,
} from "./document-update-model";

// Built from its code point: a literal byte-order mark in source is invisible.
const BOM = String.fromCharCode(0xfeff);
const PAGE = "<!doctype html><html><body><h1>New</h1></body></html>";
const OLD = "<!doctype html><html><body><h1>Old</h1></body></html>";
const replaceAll = (content: unknown) => ({
  ops: [{ op: "replace_all", content }],
});

describe("htmlReplaceCandidate — only a whole-body replacement that opens like HTML", () => {
  it("takes the complete new page from the op, not from the cut preview", () => {
    const payload = {
      ...replaceAll(PAGE),
      // The real proposal's preview began inside the stylesheet: a piece.
      preview: [{ before: "a{color:red}", after: "a{color:blue}" }],
    };
    expect(htmlReplaceCandidate(payload)).toEqual({ after: PAGE });
  });

  it("tolerates a byte-order mark and leading whitespace before the tag", () => {
    expect(htmlReplaceCandidate(replaceAll(`${BOM} \n${PAGE}`))?.after).toBe(
      `${BOM} \n${PAGE}`
    );
  });

  it("is not a page when the op is a patch, or there are several ops", () => {
    expect(
      htmlReplaceCandidate({
        ops: [{ op: "replace_section", sectionId: "s", content: PAGE }],
      })
    ).toBeNull();
    expect(
      htmlReplaceCandidate({ ops: [{ op: "append", content: PAGE }] })
    ).toBeNull();
    expect(
      htmlReplaceCandidate({
        ops: [
          { op: "replace_all", content: PAGE },
          { op: "replace_all", content: PAGE },
        ],
      })
    ).toBeNull();
    expect(htmlReplaceCandidate({ ops: [] })).toBeNull();
  });

  it("is not a page when the new body is Markdown or not text", () => {
    expect(htmlReplaceCandidate(replaceAll("# A title\n\nBody."))).toBeNull();
    expect(htmlReplaceCandidate(replaceAll(""))).toBeNull();
    expect(htmlReplaceCandidate(replaceAll(42))).toBeNull();
    expect(htmlReplaceCandidate(replaceAll(undefined))).toBeNull();
  });

  it("reads nothing from a payload that is not an object with ops", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, { ops: "no" }]) {
      expect(htmlReplaceCandidate(bad)).toBeNull();
    }
  });
});

describe("isHtmlDocument — the document's own type decides", () => {
  it("is true for type html only", () => {
    expect(isHtmlDocument({ type: "html" })).toBe(true);
    expect(isHtmlDocument({ type: "markdown" })).toBe(false);
    expect(isHtmlDocument({ type: "text" })).toBe(false);
    expect(isHtmlDocument({})).toBe(false);
    expect(isHtmlDocument(null)).toBe(false);
    expect(isHtmlDocument(undefined)).toBe(false);
  });
});

describe("appliedEdit — what approval stamped", () => {
  const stamped = (changes: unknown) => ({
    materialized: { documentEdit: { changes } },
  });

  it("returns the two whole texts", () => {
    expect(
      appliedEdit(stamped([{ before: OLD, after: PAGE, sectionId: null }]))
    ).toEqual({ before: OLD, after: PAGE });
  });

  it("returns null for anything that is not exactly one before/after pair", () => {
    expect(appliedEdit(stamped([]))).toBeNull();
    expect(
      appliedEdit(
        stamped([
          { before: "a", after: "b" },
          { before: "c", after: "d" },
        ])
      )
    ).toBeNull();
    expect(appliedEdit(stamped([{ before: "a" }]))).toBeNull();
    expect(appliedEdit(stamped([{ before: 1, after: 2 }]))).toBeNull();
    expect(appliedEdit({ materialized: {} })).toBeNull();
    expect(appliedEdit({})).toBeNull();
    expect(appliedEdit(null)).toBeNull();
  });
});

describe("htmlPages — which two pages are honest to draw", () => {
  const candidate = { after: PAGE };
  const stamp = {
    materialized: {
      documentEdit: { changes: [{ before: OLD, after: PAGE }] },
    },
  };

  it("an open proposal: the new page from the op, the old one from the live document", () => {
    expect(
      htmlPages({
        status: "pending",
        candidate,
        envelope: {},
        liveContent: OLD,
      })
    ).toEqual({ before: OLD, after: PAGE });
  });

  it("an open proposal whose document could not be read has no 'before'", () => {
    expect(
      htmlPages({
        status: "pending",
        candidate,
        envelope: {},
        liveContent: null,
      })
    ).toEqual({ before: null, after: PAGE });
  });

  it("a rejected or expired proposal left the document as it was: live is the before", () => {
    for (const status of ["rejected", "expired", "withdrawn"]) {
      expect(
        htmlPages({ status, candidate, envelope: {}, liveContent: OLD }).before
      ).toBe(OLD);
    }
  });

  it("an approved one with a stamp uses the stamp, whatever the document holds now", () => {
    expect(
      htmlPages({
        status: "approved",
        candidate,
        envelope: stamp,
        liveContent: "SOMETHING-EDITED-LATER",
      })
    ).toEqual({ before: OLD, after: PAGE });
  });

  it("an approved one with NO stamp never takes the live document for the old page", () => {
    // After approval the document IS the new page: drawing it as "before" would
    // show two identical pages and call it a comparison.
    for (const status of ["approved", "auto_approved"]) {
      expect(
        htmlPages({ status, candidate, envelope: {}, liveContent: PAGE })
      ).toEqual({ before: null, after: PAGE });
    }
  });
});

describe("htmlReadings — what can honestly be offered", () => {
  it("offers all three when both pages are known and differ", () => {
    expect(htmlReadings({ before: OLD, after: PAGE })).toEqual([
      "result",
      "side",
      "lines",
    ]);
  });

  it("offers the result alone when the old page is unknown", () => {
    expect(htmlReadings({ before: null, after: PAGE })).toEqual(["result"]);
  });

  it("offers the result alone when nothing changed, and says so", () => {
    expect(htmlReadings({ before: PAGE, after: PAGE })).toEqual(["result"]);
    expect(htmlUnchanged({ before: PAGE, after: PAGE })).toBe(true);
    expect(htmlUnchanged({ before: OLD, after: PAGE })).toBe(false);
    // Unknown is not "unchanged".
    expect(htmlUnchanged({ before: null, after: PAGE })).toBe(false);
  });
});
