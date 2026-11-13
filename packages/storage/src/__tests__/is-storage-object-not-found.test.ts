/**
 * `isStorageObjectNotFound` answers "this KEY names no object" and nothing
 * wider: a reader that takes a missing bucket or a proxy's 404 for "missing"
 * opens an existing board empty and lets its first stroke overwrite it.
 */
import { describe, expect, it } from "vitest";
import {
  isStorageObjectNotFound,
  StorageObjectNotFoundError,
} from "../interface.js";

const s3 = (fields: Record<string, unknown>) =>
  Object.assign(new Error("s3"), fields);

describe("isStorageObjectNotFound", () => {
  it.each([
    ["StorageObjectNotFoundError", new StorageObjectNotFoundError("k")],
    [
      "S3 NoSuchKey by name",
      s3({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }),
    ],
    ["S3 NoSuchKey by Code", s3({ Code: "NoSuchKey" })],
  ])("%s → missing", (_n, err) => {
    expect(isStorageObjectNotFound(err)).toBe(true);
  });

  it.each([
    ["a bare HTTP 404", s3({ $metadata: { httpStatusCode: 404 } })],
    [
      "NoSuchBucket",
      s3({ name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } }),
    ],
    [
      "a HEAD-style NotFound",
      s3({ name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    ],
    [
      "a network error",
      Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
    ],
    [
      "a plain 'File not found' Error (not the class)",
      new Error("File not found: k"),
    ],
    ["null", null],
  ])("%s → NOT missing", (_n, err) => {
    expect(isStorageObjectNotFound(err)).toBe(false);
  });
});
