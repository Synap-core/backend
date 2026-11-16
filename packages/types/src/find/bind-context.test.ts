import { describe, expect, it } from "vitest";
import {
  bindContext,
  OWED_INLINE_MAX,
  type FindSelection,
  type FindSelectionItem,
} from "./bind-context.js";

const person = (id: string, roles?: string[]): FindSelectionItem => ({
  id,
  kind: "person",
  ...(roles ? { roles } : {}),
});
const file = (id: string): FindSelectionItem => ({
  id,
  kind: "file",
  file: { mimeType: "image/png" },
});
const sel = (...items: FindSelectionItem[]): FindSelection => ({ items });

describe("bindContext — playbook subject", () => {
  it("fills the subject by kind", () => {
    const b = bindContext(sel(file("f1"), person("p1")), {
      vocabulary: "playbook",
      subject: "person",
      requiredParams: [],
    });
    expect(b.filled).toEqual([
      { name: "subject", value: "p1", source: "subject" },
    ]);
    expect(b.owed).toEqual([]);
    expect(b.mismatch).toBeUndefined();
  });

  it("fills the subject by a live role", () => {
    const b = bindContext(sel(person("p1", ["client"])), {
      vocabulary: "playbook",
      subject: "client",
      requiredParams: [],
    });
    expect(b.filled[0]).toEqual({
      name: "subject",
      value: "p1",
      source: "subject",
    });
  });

  it("fills unverified when the kind differs and the roles are unknown (the run door decides)", () => {
    const b = bindContext(sel(person("p1")), {
      vocabulary: "playbook",
      subject: "client",
      requiredParams: [],
    });
    expect(b.filled[0]).toEqual({
      name: "subject",
      value: "p1",
      source: "subject",
      unverified: true,
    });
  });

  it("says mismatch when the kind differs and the known roles do not include it", () => {
    const b = bindContext(sel(person("p1", ["investor"])), {
      vocabulary: "playbook",
      subject: "client",
      requiredParams: [],
    });
    expect(b.filled).toEqual([]);
    expect(b.mismatch).toMatch(/client/);
    expect(b.owed.map((o) => o.slot)).toEqual(["subject"]);
  });

  it("a subject-less playbook fills nothing", () => {
    const b = bindContext(sel(person("p1")), {
      vocabulary: "playbook",
      subject: null,
      requiredParams: [],
    });
    expect(b).toEqual({ filled: [], owed: [], owedMore: 0 });
  });

  it("an entity param with `from` is never owed (the run funnel fills it)", () => {
    const b = bindContext(sel(person("p1")), {
      vocabulary: "playbook",
      subject: "person",
      requiredParams: [{ name: "contact", type: "entity", from: "subject" }],
    });
    expect(b.owed).toEqual([]);
  });

  it("an entity param without `from` takes the single remaining item", () => {
    const b = bindContext(sel(person("p1"), person("p2")), {
      vocabulary: "playbook",
      subject: "person",
      requiredParams: [{ name: "introducer", type: "entity" }],
    });
    expect(b.filled).toContainEqual({
      name: "introducer",
      value: "p2",
      source: "param",
    });
  });

  it("two candidates for an entity param: owed, NEVER a guess", () => {
    const b = bindContext(sel(person("p1"), person("p2")), {
      vocabulary: "playbook",
      subject: null,
      requiredParams: [{ name: "introducer", label: "Who", type: "entity" }],
    });
    expect(b.filled).toEqual([]);
    expect(b.owed).toEqual([
      { slot: "introducer", label: "Who", type: "entity" },
    ]);
  });
});

describe("bindContext — capability file parameters", () => {
  it("`file` takes the first selected file, `file[]` takes them all", () => {
    const b = bindContext(sel(file("f1"), file("f2"), file("f3")), {
      vocabulary: "action",
      parameters: {
        cover: "file:url",
        media: "file[]:url",
        caption: "string?",
      },
    });
    expect(b.filled).toEqual([
      { name: "cover", value: "f1", source: "file" },
      { name: "media", value: ["f2", "f3"], source: "file" },
    ]);
  });

  it("two `file` params and one file: the first REQUIRED one is filled", () => {
    const b = bindContext(sel(file("f1")), {
      vocabulary: "action",
      parameters: { thumb: "file:url?", video: "file:url" },
    });
    expect(b.filled).toEqual([{ name: "video", value: "f1", source: "file" }]);
    expect(b.owed).toEqual([]);
  });

  it("21 files into a `file[]`: 20 filled and the rest said, never dropped silently", () => {
    const files = Array.from({ length: 21 }, (_, i) => file(`f${i}`));
    const b = bindContext(sel(...files), {
      vocabulary: "action",
      parameters: { media: "file[]:url" },
    });
    expect(b.filled[0]!.value).toHaveLength(20);
    expect(b.mismatch).toMatch(/1 left out/);
  });

  it("files with no declared file parameter fill NOTHING (never a plain parameter)", () => {
    const b = bindContext(sel(file("f1")), {
      vocabulary: "action",
      parameters: { url: "string", note: "string?" },
    });
    expect(b.filled).toEqual([]);
    expect(b.owed).toEqual([{ slot: "url", label: "url", type: "string" }]);
  });

  it("a JSON Schema contract owes its required fields", () => {
    const b = bindContext(sel(), {
      vocabulary: "action",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, body: { type: "string" } },
        required: ["to", "body"],
      },
    });
    expect(b.owed.map((o) => o.slot)).toEqual(["to", "body"]);
  });

  it("owed is capped inline, the rest counted", () => {
    const b = bindContext(sel(), {
      vocabulary: "action",
      parameters: {
        a: "string",
        b: "string",
        c: "string",
        d: "string",
        e: "number",
      },
    });
    expect(b.owed).toHaveLength(OWED_INLINE_MAX);
    expect(b.owedMore).toBe(2);
  });
});

describe("bindContext — intent input", () => {
  const input = {
    type: "object",
    properties: {
      to: { type: "string" },
      media: { type: "array", "x-synap-pod-file": true },
      text: { type: "string" },
    },
    required: ["to", "text"],
  };

  it("`to` takes the single selected non-file item; pod-file fields take the files", () => {
    const b = bindContext(sel(person("p1"), file("f1")), {
      vocabulary: "intent",
      input,
    });
    expect(b.filled).toEqual([
      { name: "media", value: ["f1"], source: "file" },
      { name: "to", value: "p1", source: "recipient" },
    ]);
    expect(b.owed.map((o) => o.slot)).toEqual(["text"]);
  });

  it("`to` with two people: owed, never guessed", () => {
    const b = bindContext(sel(person("p1"), person("p2")), {
      vocabulary: "intent",
      input,
    });
    expect(b.filled).toEqual([]);
    expect(b.owed.map((o) => o.slot)).toEqual(["to", "text"]);
  });
});
