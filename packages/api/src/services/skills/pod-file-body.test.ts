/**
 * `podFileBodyFor` — a `callProvider` body's handles, turned into the
 * host-side file body (plan e7c3c98e phase 2b). Pure; the end-to-end run
 * through the real sandbox and dispatcher is `run-skill-in-sandbox.pod-files.test.ts`.
 *
 * Rows rule out: a handle sent as text; a handle of another run resolving; a
 * handle hidden in a multipart text field going out as text; a body with no
 * handle changing shape; a multipart form with no file.
 */
import { describe, expect, it } from "vitest";
import { podFileBodyFor } from "./pod-file-body.js";
import type { PodFileHandles } from "../capabilities/file-parameters.js";

const photo = {
  storageKey: "users/o/photo.jpg",
  filename: "photo.jpg",
  contentType: "image/jpeg",
  size: 8,
};
const clip = {
  storageKey: "users/o/clip.mp4",
  filename: "clip.mp4",
  contentType: "video/mp4",
  size: 80,
};
const RUN: PodFileHandles = {
  files: new Map([
    ["podfile:aaa", photo],
    ["podfile:bbb", clip],
  ]),
  toolIds: ["tool-1"],
};

describe("JSON body: a handle's slot becomes the file's base64", () => {
  it("finds every handle, nested in objects and arrays, by path", () => {
    const json = {
      prompt: "warmer",
      input: { image: "podfile:aaa", refs: ["podfile:bbb", "keep"] },
    };
    expect(podFileBodyFor(json, undefined, RUN)).toEqual({
      fileBody: {
        encoding: "json-base64",
        json,
        files: [
          { path: ["input", "image"], file: photo },
          { path: ["input", "refs", 0], file: clip },
        ],
      },
    });
  });

  it("control: no handle → the body as it was, no file body", () => {
    expect(podFileBodyFor({ a: 1 }, undefined, RUN)).toEqual({
      body: { a: 1 },
    });
    expect(podFileBodyFor({ a: 1 }, undefined, undefined)).toEqual({
      body: { a: 1 },
    });
    expect(podFileBodyFor(undefined, undefined, RUN)).toEqual({});
  });
});

describe("multipart: handles become file parts, the rest text fields", () => {
  it("one field may carry several files; objects become JSON text", () => {
    expect(
      podFileBodyFor(
        {
          account_id: "acc-1",
          text: "Launch day",
          options: { visibility: "public" },
          attachments: ["podfile:aaa", "podfile:bbb"],
          cover: "podfile:aaa",
        },
        { multipart: true },
        RUN
      )
    ).toEqual({
      fileBody: {
        encoding: "multipart",
        fields: {
          account_id: "acc-1",
          text: "Launch day",
          options: '{"visibility":"public"}',
        },
        files: [
          { field: "attachments", file: photo },
          { field: "attachments", file: clip },
          { field: "cover", file: photo },
        ],
      },
    });
  });

  it("refuses a form with no file of this run", () => {
    expect(() =>
      podFileBodyFor({ text: "hi" }, { multipart: true }, RUN)
    ).toThrow("at least one file of this run");
  });

  it("refuses a handle hidden in a text field (it would go out as text)", () => {
    expect(() =>
      podFileBodyFor(
        { attachments: "podfile:aaa", meta: { image: "podfile:bbb" } },
        { multipart: true },
        RUN
      )
    ).toThrow("not nested in a text field");
  });
});

describe("only this run's handles resolve", () => {
  it("a handle the run did not receive is refused, in JSON and multipart", () => {
    for (const opts of [undefined, { multipart: true }])
      expect(
        () => podFileBodyFor({ image: "podfile:zzz" }, opts, RUN),
        JSON.stringify(opts)
      ).toThrow("not a file of this run");
  });

  it("a run with no files resolves no handle at all", () => {
    expect(() =>
      podFileBodyFor({ image: "podfile:aaa" }, undefined, undefined)
    ).toThrow("not a file of this run");
  });
});
