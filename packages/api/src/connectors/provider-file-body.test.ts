import { describe, expect, it } from "vitest";
import {
  BASE64_BODY_MAX_BYTES,
  MULTIPART_FILE_MAX_BYTES,
  ProviderFileBodyError,
  encodeProviderFileBody,
  type ProviderFileRef,
} from "./provider-file-body.js";

/**
 * The file-body encoder, against a fake storage that behaves like
 * `IFileStorage.downloadStream` (typed `code`s, `maxBytes` enforced on the
 * bytes). The dispatcher half (headers, the vault handler, the gate refusals)
 * is `provider-file-body.dispatch.test.ts`.
 */

type Opened = { key: string; maxBytes?: number };

function fakeStorage(
  objects: Record<string, Buffer>,
  opts: { lieAboutSize?: boolean; failWith?: unknown } = {}
) {
  const opened: Opened[] = [];
  return {
    opened,
    async downloadStream(key: string, o?: { maxBytes?: number }) {
      opened.push({ key, maxBytes: o?.maxBytes });
      if (opts.failWith) throw opts.failWith;
      const bytes = objects[key];
      if (!bytes) {
        throw Object.assign(new Error(`File not found: ${key}`), {
          code: "STORAGE_OBJECT_NOT_FOUND",
        });
      }
      const max = o?.maxBytes;
      if (!opts.lieAboutSize && max !== undefined && bytes.length > max) {
        throw Object.assign(new Error("too large"), {
          code: "STORAGE_OBJECT_TOO_LARGE",
        });
      }
      async function* body() {
        let seen = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          const chunk = bytes.subarray(i, i + 4);
          seen += chunk.length;
          if (max !== undefined && seen > max) {
            throw Object.assign(new Error("too large"), {
              code: "STORAGE_OBJECT_TOO_LARGE",
            });
          }
          yield chunk;
        }
      }
      return {
        body: body(),
        size: bytes.length,
        contentType: "application/octet-stream",
        cancel() {},
      };
    },
  };
}

const ref = (
  storageKey: string,
  filename: string,
  contentType: string,
  size: number
): ProviderFileRef => ({ storageKey, filename, contentType, size });

async function drain(body: string | AsyncIterable<Uint8Array>) {
  if (typeof body === "string") return Buffer.from(body);
  const out: Buffer[] = [];
  for await (const c of body) out.push(Buffer.from(c));
  return Buffer.concat(out);
}

async function refusal(p: Promise<unknown>): Promise<ProviderFileBodyError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ProviderFileBodyError);
  return err as ProviderFileBodyError;
}

describe("multipart", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const MP4 = Buffer.from("not-really-an-mp4");

  it("text fields, then each file part with its filename and Content-Type, framed by the boundary", async () => {
    const storage = fakeStorage({ "k/png": PNG, "k/mp4": MP4 });
    const enc = await encodeProviderFileBody(
      {
        encoding: "multipart",
        fields: { account_id: "acc-1", text: "Hello\nworld" },
        files: [
          {
            field: "attachments",
            file: ref("k/png", 'a "b".png', "image/png", PNG.length),
          },
          {
            field: "attachments",
            file: ref("k/mp4", "clip.mp4", "video/mp4", MP4.length),
          },
        ],
      },
      { storage, boundary: "BOUNDARY" }
    );
    expect(enc.contentType).toBe("multipart/form-data; boundary=BOUNDARY");
    expect(typeof enc.body).not.toBe("string");
    const expected = Buffer.concat([
      Buffer.from(
        '--BOUNDARY\r\nContent-Disposition: form-data; name="account_id"\r\n\r\nacc-1\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="text"\r\n\r\nHello\nworld\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="attachments"; filename="a %22b%22.png"\r\nContent-Type: image/png\r\n\r\n'
      ),
      PNG,
      Buffer.from(
        '\r\n--BOUNDARY\r\nContent-Disposition: form-data; name="attachments"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n'
      ),
      MP4,
      Buffer.from("\r\n--BOUNDARY--\r\n"),
    ]);
    expect((await drain(enc.body)).equals(expected)).toBe(true);
    expect(enc.failure()).toBeNull();
    expect(storage.opened).toEqual([
      { key: "k/png", maxBytes: MULTIPART_FILE_MAX_BYTES },
      { key: "k/mp4", maxBytes: MULTIPART_FILE_MAX_BYTES },
    ]);
  });

  it("files are opened only as the request reads them, never at encode time", async () => {
    const storage = fakeStorage({ "k/png": PNG });
    const enc = await encodeProviderFileBody(
      {
        encoding: "multipart",
        files: [{ field: "f", file: ref("k/png", "a.png", "image/png", 9) }],
      },
      { storage, boundary: "B" }
    );
    expect(storage.opened).toEqual([]);
    await drain(enc.body);
    expect(storage.opened).toHaveLength(1);
  });

  it("the default boundary is random per body", async () => {
    const storage = fakeStorage({ "k/png": PNG });
    const body = {
      encoding: "multipart" as const,
      files: [{ field: "f", file: ref("k/png", "a.png", "image/png", 9) }],
    };
    const a = await encodeProviderFileBody(body, { storage });
    const b = await encodeProviderFileBody(body, { storage });
    expect(a.contentType).toMatch(
      /^multipart\/form-data; boundary=----SynapFormBoundary[0-9a-f]{32}$/
    );
    expect(a.contentType).not.toBe(b.contentType);
  });

  it("a file recorded over 100 MB is refused before storage is touched (413)", async () => {
    const storage = fakeStorage({});
    const err = await refusal(
      encodeProviderFileBody(
        {
          encoding: "multipart",
          files: [
            {
              field: "f",
              file: ref(
                "k/v",
                "v.mp4",
                "video/mp4",
                MULTIPART_FILE_MAX_BYTES + 1
              ),
            },
          ],
        },
        { storage }
      )
    );
    expect(err).toMatchObject({ code: "file_too_large", status: 413 });
    expect(storage.opened).toEqual([]);
  });

  it("bytes past the cap end the stream with a typed failure (a recorded size that lied)", async () => {
    // Storage enforces maxBytes on the bytes as they pass; here with a cap of 8
    // on a 12-byte object whose recorded size (1) was wrong.
    const lying = fakeStorage(
      { "k/v": Buffer.alloc(12) },
      { lieAboutSize: true }
    );
    const enc = await encodeProviderFileBody(
      {
        encoding: "multipart",
        files: [{ field: "f", file: ref("k/v", "v.bin", "x/y", 1) }],
      },
      {
        storage: {
          downloadStream: (key: string) =>
            lying.downloadStream(key, { maxBytes: 8 }),
        },
        boundary: "B",
      }
    );
    const err = await refusal(drain(enc.body));
    expect(err).toMatchObject({
      code: "file_too_large",
      status: 413,
      filename: "v.bin",
    });
    expect(enc.failure()).toBe(err);
  });

  it("a file gone from storage ends the stream with a typed not-found (404)", async () => {
    const storage = fakeStorage({ "k/png": PNG });
    const enc = await encodeProviderFileBody(
      {
        encoding: "multipart",
        files: [
          { field: "f", file: ref("k/png", "a.png", "image/png", 9) },
          { field: "f", file: ref("k/gone", "gone.png", "image/png", 9) },
        ],
      },
      { storage, boundary: "B" }
    );
    const err = await refusal(drain(enc.body));
    expect(err).toMatchObject({
      code: "file_not_found",
      status: 404,
      filename: "gone.png",
    });
    expect(enc.failure()).toBe(err);
  });

  it("a storage that fails is file_unreadable (502), never 'not found'", async () => {
    const storage = fakeStorage({}, { failWith: new Error("ECONNRESET") });
    const enc = await encodeProviderFileBody(
      {
        encoding: "multipart",
        files: [{ field: "f", file: ref("k/a", "a.png", "image/png", 9) }],
      },
      { storage, boundary: "B" }
    );
    const err = await refusal(drain(enc.body));
    expect(err).toMatchObject({ code: "file_unreadable", status: 502 });
    expect(err.message).toContain("ECONNRESET");
  });

  it("a Content-Type carrying a line break is refused (no header injection into a part)", async () => {
    const err = await refusal(
      encodeProviderFileBody(
        {
          encoding: "multipart",
          files: [
            {
              field: "f",
              file: ref("k/a", "a.png", "image/png\r\nX-Evil: 1", 9),
            },
          ],
        },
        { storage: fakeStorage({}) }
      )
    );
    expect(err).toMatchObject({ code: "bad_file_body", status: 400 });
  });

  it("no files, or a file part with no field name, is a bad body", async () => {
    const storage = fakeStorage({});
    expect(
      await refusal(
        encodeProviderFileBody(
          { encoding: "multipart", files: [] },
          { storage }
        )
      )
    ).toMatchObject({ code: "bad_file_body" });
    expect(
      await refusal(
        encodeProviderFileBody(
          {
            encoding: "multipart",
            files: [{ field: "", file: ref("k", "a", "x/y", 1) }],
          },
          { storage }
        )
      )
    ).toMatchObject({ code: "bad_file_body" });
  });
});

describe("json-base64", () => {
  const IMG = Buffer.from("tiny-image-bytes");

  it("fills each declared slot with the file's base64 and sends JSON", async () => {
    const storage = fakeStorage({ "k/img": IMG, "k/doc": Buffer.from("pdf") });
    const enc = await encodeProviderFileBody(
      {
        encoding: "json-base64",
        json: {
          text: "hi",
          media: [{ name: "a.png", data: null }],
          document: "",
        },
        files: [
          {
            path: ["media", 0, "data"],
            file: ref("k/img", "a.png", "image/png", IMG.length),
          },
          {
            path: ["document"],
            file: ref("k/doc", "d.pdf", "application/pdf", 3),
          },
        ],
      },
      { storage }
    );
    expect(enc.contentType).toBe("application/json");
    expect(typeof enc.body).toBe("string");
    expect(JSON.parse(enc.body as string)).toEqual({
      text: "hi",
      media: [{ name: "a.png", data: IMG.toString("base64") }],
      document: Buffer.from("pdf").toString("base64"),
    });
    // The budget is shared: the second file may use what the first left.
    expect(storage.opened).toEqual([
      { key: "k/img", maxBytes: BASE64_BODY_MAX_BYTES },
      { key: "k/doc", maxBytes: BASE64_BODY_MAX_BYTES - IMG.length },
    ]);
  });

  it("does not mutate the caller's JSON", async () => {
    const json = { data: "" };
    await encodeProviderFileBody(
      {
        encoding: "json-base64",
        json,
        files: [
          { path: ["data"], file: ref("k/img", "a.png", "image/png", 1) },
        ],
      },
      { storage: fakeStorage({ "k/img": IMG }) }
    );
    expect(json).toEqual({ data: "" });
  });

  it("a slot the body does not declare is refused, nothing read", async () => {
    const storage = fakeStorage({ "k/img": IMG });
    for (const path of [
      ["missing"],
      ["media", 3, "data"],
      ["media", "0"],
      [],
    ]) {
      const err = await refusal(
        encodeProviderFileBody(
          {
            encoding: "json-base64",
            json: { media: [{ data: null }] },
            files: [{ path, file: ref("k/img", "a.png", "image/png", 1) }],
          },
          { storage }
        )
      );
      expect(err).toMatchObject({ code: "bad_file_body", status: 400 });
    }
    expect(storage.opened).toEqual([]);
  });

  it("files recorded over 20 MB together are refused before storage is touched (413)", async () => {
    const storage = fakeStorage({});
    const half = BASE64_BODY_MAX_BYTES / 2;
    const err = await refusal(
      encodeProviderFileBody(
        {
          encoding: "json-base64",
          json: { a: "", b: "" },
          files: [
            { path: ["a"], file: ref("k/a", "a.mp4", "video/mp4", half) },
            { path: ["b"], file: ref("k/b", "b.mp4", "video/mp4", half + 1) },
          ],
        },
        { storage }
      )
    );
    expect(err).toMatchObject({ code: "file_too_large", status: 413 });
    expect(storage.opened).toEqual([]);
  });

  it("stored bytes over the remaining budget are refused (413), whatever the record said", async () => {
    const storage = fakeStorage({ "k/a": Buffer.alloc(16) });
    const err = await refusal(
      encodeProviderFileBody(
        {
          encoding: "json-base64",
          json: { a: "" },
          files: [{ path: ["a"], file: ref("k/a", "a.bin", "x/y", 1) }],
        },
        {
          storage: {
            downloadStream: (key: string) =>
              storage.downloadStream(key, { maxBytes: 8 }),
          },
        }
      )
    );
    expect(err).toMatchObject({
      code: "file_too_large",
      status: 413,
      filename: "a.bin",
    });
  });

  it("a missing object is a typed not-found (404); a failing storage is 502", async () => {
    const missing = await refusal(
      encodeProviderFileBody(
        {
          encoding: "json-base64",
          json: { a: "" },
          files: [
            { path: ["a"], file: ref("k/gone", "g.png", "image/png", 1) },
          ],
        },
        { storage: fakeStorage({}) }
      )
    );
    expect(missing).toMatchObject({ code: "file_not_found", status: 404 });
    const down = await refusal(
      encodeProviderFileBody(
        {
          encoding: "json-base64",
          json: { a: "" },
          files: [{ path: ["a"], file: ref("k/a", "a.png", "image/png", 1) }],
        },
        { storage: fakeStorage({}, { failWith: new Error("timeout") }) }
      )
    );
    expect(down).toMatchObject({ code: "file_unreadable", status: 502 });
  });
});
