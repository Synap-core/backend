/**
 * Pod files through an intent's input (plan e7c3c98e phase 3): a map that
 * copies the intent's pod-file field (`publish_post.media`) must land it in a
 * declared pod-file parameter, and a pod-file parameter reads only such a
 * field. Pure.
 *
 * Rows rule out: pod file ids copied into a plain parameter (the tool would get
 * bare ids, unchecked and unreviewed); a URL, a text, a constant, an account or
 * a recipient fed to a pod-file parameter; a list fed to a one-file parameter;
 * the marker breaking input validation.
 */
import { describe, expect, it } from "vitest";
import {
  fileInputMapProblems,
  podFileInputFields,
  POD_FILE_INPUT_KEYWORD,
} from "./file-input-map.js";
import { validateInput } from "./intent-input.js";

/** 0368's publish_post shape, with 0377's marker on `media`. */
const PUBLISH_POST = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1 },
    media: {
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 10,
      [POD_FILE_INPUT_KEYWORD]: true,
    },
    cover: { type: "string", format: "uuid", [POD_FILE_INPUT_KEYWORD]: true },
    link: { type: "string", format: "uri" },
  },
  required: ["text"],
  additionalProperties: false,
};

const verb = (
  parameters: Record<string, string>,
  params: Record<string, unknown>
) => ({
  parameters,
  inputMap: { params },
});

describe("the intent's pod-file fields", () => {
  it("are the fields carrying the marker, a list or one id", () => {
    expect([...podFileInputFields(PUBLISH_POST)]).toEqual([
      ["media", { many: true }],
      ["cover", { many: false }],
    ]);
    expect(podFileInputFields(null).size).toBe(0);
  });

  it("the marker does not change what input validates", () => {
    const id = "6f1b0b8e-6b9e-4d1b-9a55-2f4f5f1c2a11";
    expect(validateInput(PUBLISH_POST, { text: "hi", media: [id] })).toEqual({
      ok: true,
      value: { text: "hi", media: [id] },
    });
    expect(validateInput(PUBLISH_POST, { text: "hi", media: ["x"] }).ok).toBe(
      false
    );
  });
});

describe("a map moves pod files only into declared pod-file parameters", () => {
  it("accepts media → file[]:url and file[]:bytes, cover → file:url", () => {
    for (const media of ["file[]:url?", "file[]:bytes"])
      expect(
        fileInputMapProblems(
          verb(
            { content: "string", media, image: "file:url?" },
            { content: "$.text", media: "$.media", image: "$.cover" }
          ),
          PUBLISH_POST
        ),
        media
      ).toEqual([]);
  });

  it("refuses pod file ids copied into a plain parameter", () => {
    const [problem, ...rest] = fileInputMapProblems(
      verb({ mediaUrls: "array?" }, { mediaUrls: "$.media" }),
      PUBLISH_POST
    );
    expect(rest).toEqual([]);
    expect(problem).toContain('declare "mediaUrls" as "file[]:url"');
  });

  it("refuses a pod-file parameter fed by anything but a pod-file field", () => {
    for (const source of [
      "$.text",
      "$.link",
      "$account.id",
      "$to.email",
      { const: "6f1b0b8e-6b9e-4d1b-9a55-2f4f5f1c2a11" },
    ]) {
      const problems = fileInputMapProblems(
        verb({ video: "file:url" }, { video: source }),
        PUBLISH_POST
      );
      expect(problems, JSON.stringify(source)).toHaveLength(1);
      expect(problems[0]).toContain(
        "can read only an input field of pod files"
      );
    }
  });

  it("refuses a list fed to a one-file parameter, and one file to a list", () => {
    expect(
      fileInputMapProblems(
        verb({ video: "file:url" }, { video: "$.media" }),
        PUBLISH_POST
      )[0]
    ).toContain("is a list of files");
    expect(
      fileInputMapProblems(
        verb({ media: "file[]:url" }, { media: "$.cover" }),
        PUBLISH_POST
      )[0]
    ).toContain("is one file");
  });

  it("an unmarked intent field is not pod files, even when it is a list of uuids", () => {
    const unmarked = {
      ...PUBLISH_POST,
      properties: {
        ...PUBLISH_POST.properties,
        media: { type: "array", items: { type: "string", format: "uuid" } },
      },
    };
    expect(
      fileInputMapProblems(
        verb({ media: "file[]:url" }, { media: "$.media" }),
        unmarked
      )
    ).toHaveLength(1);
    expect(
      fileInputMapProblems(
        verb({ mediaIds: "array" }, { mediaIds: "$.media" }),
        unmarked
      )
    ).toEqual([]);
  });

  it("a map it cannot read is left to the shape check", () => {
    expect(fileInputMapProblems({ inputMap: "nope" }, PUBLISH_POST)).toEqual(
      []
    );
    expect(fileInputMapProblems({}, PUBLISH_POST)).toEqual([]);
  });
});
