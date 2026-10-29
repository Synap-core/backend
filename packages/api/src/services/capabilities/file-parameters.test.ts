/**
 * Pod file parameters — the declaration grammar, the install refusals, the URL
 * lifetime by verb mode, the proposal's file sentence, and the run door's
 * argument check reading `file:url` / `file[]:url` (plan e7c3c98e).
 *
 * Rows rule out: a bytes declaration installing before phase 2 wires it; a
 * file verb installing as read-only (it would auto-run at the gate); a
 * declaration with no delivery read as a URL by guess; an async verb getting a
 * URL that dies before a queued provider fetches it; the proposal naming a
 * raw tool id or a file id instead of the file; a `file[]` value that is not
 * a list passing the argument check.
 *
 * Pure: no database. The ask and run checks against real rows are
 * `file-parameters.pglite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  declaredFileParameters,
  describePodFileSend,
  fileParameterDeclarationProblems,
  formatByteSize,
  parseFileParameterType,
  podFileUrlTtlSeconds,
  POD_FILE_URL_TTL_ASYNC_SECONDS,
  POD_FILE_URL_TTL_SYNC_SECONDS,
} from "./file-parameters.js";
import {
  checkVerbParameters,
  describeParameterRepair,
} from "./validate-verb-parameters.js";

describe("the declaration grammar", () => {
  it("reads file, file[], the delivery and the optional mark", () => {
    expect(parseFileParameterType("file:url")).toEqual({
      many: false,
      delivery: "url",
      optional: false,
    });
    expect(parseFileParameterType("file[]:url?")).toEqual({
      many: true,
      delivery: "url",
      optional: true,
    });
    expect(parseFileParameterType("file[]:bytes")).toEqual({
      many: true,
      delivery: "bytes",
      optional: false,
    });
    expect(parseFileParameterType("file")).toEqual({
      many: false,
      delivery: null,
      optional: false,
    });
  });

  it("is not fooled by other types or near misses", () => {
    for (const raw of ["string", "array?", "files", "file:", "file[]x", 3]) {
      expect(parseFileParameterType(raw)).toBeNull();
    }
  });

  it("lists only the file parameters of a type map, never of JSON Schema", () => {
    expect(
      declaredFileParameters({
        content: "string",
        media: "file[]:url?",
        video: "file:url",
      }).map((p) => p.field)
    ).toEqual(["media", "video"]);
    expect(
      declaredFileParameters({
        type: "object",
        properties: { media: { type: "string" } },
      })
    ).toEqual([]);
    expect(declaredFileParameters(null)).toEqual([]);
  });
});

describe("install refuses a declaration that cannot be sent", () => {
  it("accepts file:url and file[]:url?", () => {
    expect(
      fileParameterDeclarationProblems({
        parameters: { media: "file[]:url?", video: "file:url" },
        metadata: { verbType: "write" },
      })
    ).toEqual([]);
  });

  it("accepts bytes on a code verb run in the pod (the default kind)", () => {
    for (const skill of [
      {},
      { kind: "code" },
      { kind: "code", executionMode: "async" },
    ])
      expect(
        fileParameterDeclarationProblems({
          parameters: { attachments: "file[]:bytes?" },
          ...skill,
        }),
        JSON.stringify(skill)
      ).toEqual([]);
  });

  it("refuses bytes where no sandbox bridge can send them: a declarative verb, a box script", () => {
    for (const skill of [
      { kind: "declarative" },
      { kind: "code", executionMode: "box" },
    ]) {
      const [problem] = fileParameterDeclarationProblems({
        parameters: { attachments: "file[]:bytes?" },
        ...skill,
      });
      expect(problem, JSON.stringify(skill)).toContain(
        "only a code verb run in the pod can send"
      );
    }
  });

  it("refuses a file parameter that does not say how the tool takes it", () => {
    const [problem] = fileParameterDeclarationProblems({
      parameters: { video: "file" },
    });
    expect(problem).toContain('declare it "file:url"');
  });

  it("refuses an unknown delivery", () => {
    expect(
      fileParameterDeclarationProblems({ parameters: { a: "file:ftp" } })
    ).toHaveLength(1);
  });

  it("refuses a read-only verb that takes a file", () => {
    expect(
      fileParameterDeclarationProblems({
        parameters: { media: "file:url" },
        metadata: { readOnly: true },
      })
    ).toEqual([expect.stringContaining("cannot be read-only")]);
    // Control: read-only with no file parameter is not this rule's business.
    expect(
      fileParameterDeclarationProblems({
        parameters: { q: "string" },
        metadata: { readOnly: true },
      })
    ).toEqual([]);
  });
});

describe("the URL lives as long as the verb needs it", () => {
  it("15 min for a sync verb, 6 h for an async or box verb", () => {
    expect(POD_FILE_URL_TTL_SYNC_SECONDS).toBe(900);
    expect(POD_FILE_URL_TTL_ASYNC_SECONDS).toBe(21_600);
    expect(podFileUrlTtlSeconds("sync")).toBe(900);
    expect(podFileUrlTtlSeconds(null)).toBe(900);
    expect(podFileUrlTtlSeconds("async")).toBe(21_600);
    expect(podFileUrlTtlSeconds("box")).toBe(21_600);
  });
});

describe("the proposal names the files", () => {
  const photo = {
    field: "media",
    id: "f1",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 2_202_009,
  };

  it("one file: its name, its size, the tool", () => {
    expect(describePodFileSend([photo], "Postiz")).toBe(
      "Sends photo.jpg (2.1 MB) to Postiz"
    );
  });

  it("several files: the count, the total, the first names", () => {
    const files = ["a.png", "b.png", "c.png", "d.png"].map((name, i) => ({
      ...photo,
      id: `f${i}`,
      name,
      size: 1024 * 1024,
    }));
    expect(describePodFileSend(files, "Postiz")).toBe(
      "Sends 4 files (4 MB) to Postiz: a.png, b.png, c.png and 1 more"
    );
  });

  it("no tool, no name, no size: still words, never an id", () => {
    expect(
      describePodFileSend([{ ...photo, name: null, size: null }], null)
    ).toBe("Sends a file out of your pod");
  });

  it("formats bytes", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(300 * 1024 * 1024)).toBe("300 MB");
  });
});

describe("the run door's argument check reads file parameters", () => {
  const skill = {
    kind: "code",
    name: "postiz_schedule_post",
    parameters: { content: "string", media: "file[]:url?", video: "file:url" },
  };
  const id = "6f1b0b8e-6b9e-4d1b-9a55-2f4f5f1c2a11";

  it("a list for file[], one id for file", () => {
    expect(
      checkVerbParameters(skill, { content: "hi", media: [id], video: id })
    ).toEqual({ status: "ok", unknown: [] });
  });

  it("a file[] given one id, or a required file missing, is refused", () => {
    const out = checkVerbParameters(skill, { content: "hi", media: id });
    expect(out).toEqual({
      status: "invalid",
      repair: {
        missing: ["video"],
        wrongType: { media: { expected: "array", received: "string" } },
        unknown: [],
      },
    });
  });

  it("a file refusal reads as words the caller can act on", () => {
    const message = describeParameterRepair("postiz_schedule_post", {
      missing: [],
      wrongType: {},
      unknown: [],
      files: [{ field: "media", fileId: id, problem: "forbidden" }],
    });
    expect(message).toContain(`media: you cannot read this file (${id})`);
  });
});
