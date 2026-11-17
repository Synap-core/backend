/**
 * The PDF engine client (PDF tools W1), against a fake `fetch` and a fake
 * storage that behaves like `IFileStorage.downloadStream`.
 *
 * What it pins: the base URL comes ONLY from `STIRLING_URL` (and "off" when it
 * is unset — fetch is never called); each verb's endpoint and form fields; the
 * files go under `fileInput`, in order; timeouts, 4xx/5xx and transport
 * failures map to typed refusals; the 50 MB result cap holds both on a
 * declared length and on a body that lies about it; a 200 that is not the
 * expected type is refused, never stored.
 *
 * NOT covered: a real Stirling engine (the field names were read from its
 * source; the pinned image is exercised once the Compose profile lands).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderFileRef } from "../../../connectors/provider-file-body.js";
import { PDF_VERB_PARAMS } from "../params.js";
import {
  callStirling,
  DEFAULT_TIMEOUT_MS,
  OCR_TIMEOUT_MS,
  probePdfEngine,
  STIRLING_RESPONSE_MAX_BYTES,
  stirlingCallFor,
  toPdfRouteFor,
  type FetchLike,
} from "../stirling-client.js";

const FILE_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID_2 = "22222222-2222-4222-8222-222222222222";
const PDF = Buffer.from("%PDF-1.7\nfake pdf body\n%%EOF");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

function fakeStorage(objects: Record<string, Buffer>) {
  return {
    async downloadStream(key: string) {
      const bytes = objects[key];
      if (!bytes) {
        throw Object.assign(new Error(`File not found: ${key}`), {
          code: "STORAGE_OBJECT_NOT_FOUND",
        });
      }
      async function* body() {
        yield new Uint8Array(bytes);
      }
      return {
        body: body(),
        size: bytes.length,
        contentType: "application/pdf",
        cancel() {},
      };
    },
  };
}

const ref = (storageKey: string, filename: string): ProviderFileRef => ({
  storageKey,
  filename,
  contentType: "application/pdf",
  size: PDF.length,
});

interface Sent {
  url: string;
  method?: string;
  contentType?: string;
  body: string;
}

/** A fetch that records the request (draining the streamed body) and answers. */
function fakeFetch(answer: (sent: Sent) => Response | Promise<Response>) {
  const calls: Sent[] = [];
  const fn: FetchLike = async (url, init) => {
    const body = init?.body
      ? Buffer.from(await new Response(init.body).arrayBuffer()).toString(
          "latin1"
        )
      : "";
    const sent: Sent = {
      url,
      method: init?.method,
      contentType: (init?.headers as Record<string, string> | undefined)?.[
        "content-type"
      ],
      body,
    };
    calls.push(sent);
    return answer(sent);
  };
  return { fn, calls };
}

/** The (name, value) text fields of a multipart body, in order. */
function textFields(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re =
    /Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out.push([m[1]!, m[2]!]);
  return out;
}

/** The filenames of the `fileInput` parts, in order. */
function fileParts(body: string): string[] {
  return [...body.matchAll(/name="fileInput"; filename="([^"]+)"/g)].map(
    (m) => m[1]!
  );
}

async function refusalOf(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, "expected a refusal").toBeTruthy();
  return err as {
    name: string;
    message: string;
    errorClass: string;
    code: string;
  };
}

const ORIGINAL = process.env.STIRLING_URL;
beforeEach(() => {
  process.env.STIRLING_URL = "http://stirling-pdf:8080/";
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.STIRLING_URL;
  else process.env.STIRLING_URL = ORIGINAL;
});

const pdfOk = () =>
  new Response(PDF, {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });

describe("engine off", () => {
  it("probe answers off and the call refuses PDF_ENGINE_OFF without fetching", async () => {
    delete process.env.STIRLING_URL;
    const f = fakeFetch(pdfOk);
    expect(await probePdfEngine({ fetch: f.fn })).toBe("off");
    const err = await refusalOf(
      callStirling(
        stirlingCallFor("pdf.compress", { fileId: FILE_ID }),
        [ref("k/a", "a.pdf")],
        { fetch: f.fn, storage: fakeStorage({ "k/a": PDF }) }
      )
    );
    expect(err.name).toBe("VerbRefusal");
    expect(err.code).toBe("PDF_ENGINE_OFF");
    // Never no_connection: that class attaches a CONNECT link to an account card.
    expect(err.errorClass).toBe("provider");
    expect(err.message).toContain("[PDF_ENGINE_OFF]");
    expect(f.calls).toHaveLength(0);
  });

  it("a blank STIRLING_URL is off too", async () => {
    process.env.STIRLING_URL = "   ";
    expect(await probePdfEngine({ fetch: fakeFetch(pdfOk).fn })).toBe("off");
  });
});

describe("probe", () => {
  it("ok when the status endpoint says UP; the URL is the env's, slash stripped", async () => {
    const f = fakeFetch(() => new Response('{"status":"UP","version":"1"}'));
    expect(await probePdfEngine({ fetch: f.fn })).toBe("ok");
    expect(f.calls[0]!.url).toBe("http://stirling-pdf:8080/api/v1/info/status");
  });

  it("down on a 5xx, on a body without UP, and on a transport error", async () => {
    expect(
      await probePdfEngine({
        fetch: fakeFetch(() => new Response("x", { status: 503 })).fn,
      })
    ).toBe("down");
    expect(
      await probePdfEngine({
        fetch: fakeFetch(() => new Response('{"status":"DOWN"}')).fn,
      })
    ).toBe("down");
    expect(
      await probePdfEngine({
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      })
    ).toBe("down");
  });
});

describe("each verb's endpoint and fields", () => {
  const send = async (
    spec: ReturnType<typeof stirlingCallFor>,
    files: ProviderFileRef[],
    answer: () => Response = pdfOk
  ) => {
    const f = fakeFetch(answer);
    const result = await callStirling(spec, files, {
      fetch: f.fn,
      storage: fakeStorage({ "k/a": PDF, "k/b": PDF }),
    });
    return { sent: f.calls[0]!, result };
  };

  it("pdf.ocr: languages repeated, skip-text by default, sandwich, 10 min", async () => {
    const input = PDF_VERB_PARAMS["pdf.ocr"].parse({
      fileId: FILE_ID,
      languages: ["eng", "fra"],
    });
    const spec = stirlingCallFor("pdf.ocr", input);
    expect(spec.timeoutMs).toBe(OCR_TIMEOUT_MS);
    const { sent, result } = await send(spec, [ref("k/a", "Scan.pdf")]);
    expect(sent.url).toBe("http://stirling-pdf:8080/api/v1/misc/ocr-pdf");
    expect(sent.method).toBe("POST");
    expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(textFields(sent.body)).toEqual([
      ["languages", "eng"],
      ["languages", "fra"],
      ["ocrType", "skip-text"],
      ["ocrRenderType", "sandwich"],
    ]);
    expect(fileParts(sent.body)).toEqual(["Scan.pdf"]);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.bytes.equals(PDF)).toBe(true);
  });

  it("pdf.ocr defaults: eng, and force-ocr when asked", async () => {
    expect(stirlingCallFor("pdf.ocr", { fileId: FILE_ID }).fields).toEqual({
      languages: ["eng"],
      ocrType: "skip-text",
      ocrRenderType: "sandwich",
    });
    expect(
      stirlingCallFor("pdf.ocr", { fileId: FILE_ID, mode: "force-ocr" }).fields
        .ocrType
    ).toBe("force-ocr");
  });

  it("pdf.merge: every file under fileInput, in the order given, orderProvided", async () => {
    const spec = stirlingCallFor("pdf.merge", {
      fileIds: [FILE_ID, FILE_ID_2],
    });
    const { sent } = await send(spec, [
      ref("k/b", "B.pdf"),
      ref("k/a", "A.pdf"),
    ]);
    expect(sent.url).toBe("http://stirling-pdf:8080/api/v1/general/merge-pdfs");
    expect(textFields(sent.body)).toEqual([["sortType", "orderProvided"]]);
    expect(fileParts(sent.body)).toEqual(["B.pdf", "A.pdf"]);
  });

  it("pdf.redact: terms one per line, rasterised so the text cannot be recovered", async () => {
    const spec = stirlingCallFor("pdf.redact", {
      fileId: FILE_ID,
      terms: ["Jane Doe", "4111 1111"],
      wholeWord: true,
    });
    const { sent } = await send(spec, [ref("k/a", "a.pdf")]);
    expect(sent.url).toBe(
      "http://stirling-pdf:8080/api/v1/security/auto-redact"
    );
    expect(Object.fromEntries(textFields(sent.body))).toEqual({
      listOfText: "Jane Doe\n4111 1111",
      useRegex: "false",
      wholeWordSearch: "true",
      convertPDFToImage: "true",
    });
  });

  it("pdf.split answers a ZIP and it is kept as a ZIP", async () => {
    const spec = stirlingCallFor("pdf.split", {
      fileId: FILE_ID,
      pages: "1-3,5",
    });
    expect(spec.fields).toEqual({ pageNumbers: "1-3,5" });
    const { sent, result } = await send(
      spec,
      [ref("k/a", "a.pdf")],
      () => new Response(ZIP, { status: 200 })
    );
    expect(sent.url).toBe(
      "http://stirling-pdf:8080/api/v1/general/split-pages"
    );
    expect(result.mimeType).toBe("application/zip");
  });

  it("the other verbs: endpoint, fields, 3 min", () => {
    const table: Array<[ReturnType<typeof stirlingCallFor>, string, object]> = [
      [
        stirlingCallFor("pdf.compress", { fileId: FILE_ID }),
        "/api/v1/misc/compress-pdf",
        { optimizeLevel: "5" },
      ],
      [
        stirlingCallFor("pdf.compress", { fileId: FILE_ID, level: 9 }),
        "/api/v1/misc/compress-pdf",
        { optimizeLevel: "9" },
      ],
      [
        stirlingCallFor("pdf.to_markdown", { fileId: FILE_ID }),
        "/api/v1/convert/pdf/markdown",
        {},
      ],
      [
        stirlingCallFor("pdf.info", { fileId: FILE_ID }),
        "/api/v1/security/get-info-on-pdf",
        {},
      ],
      [
        stirlingCallFor("pdf.protect", { fileId: FILE_ID, password: "s3cret" }),
        "/api/v1/security/add-password",
        { password: "s3cret" },
      ],
      [
        stirlingCallFor("pdf.unprotect", {
          fileId: FILE_ID,
          password: "s3cret",
        }),
        "/api/v1/security/remove-password",
        { password: "s3cret" },
      ],
    ];
    for (const [spec, path, fields] of table) {
      expect(spec.path).toBe(path);
      expect(spec.fields).toEqual(fields);
      expect(spec.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    }
  });

  it("pdf.to_pdf: the route by type, with the extension Stirling reads", () => {
    expect(
      toPdfRouteFor(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toMatchObject({ path: "/api/v1/convert/file/pdf", extension: "docx" });
    expect(toPdfRouteFor("image/jpeg")).toMatchObject({
      path: "/api/v1/convert/img/pdf",
      extension: "jpg",
    });
    expect(toPdfRouteFor("text/html; charset=utf-8")).toMatchObject({
      path: "/api/v1/convert/html/pdf",
      extension: "html",
    });
    expect(toPdfRouteFor("text/markdown")).toMatchObject({
      path: "/api/v1/convert/markdown/pdf",
      extension: "md",
    });
    expect(toPdfRouteFor("application/zip")).toBeNull();
    expect(toPdfRouteFor("application/pdf")).toBeNull();
    expect(toPdfRouteFor(null)).toBeNull();
    const route = toPdfRouteFor("image/png")!;
    expect(
      stirlingCallFor("pdf.to_pdf", { fileId: FILE_ID }, route)
    ).toMatchObject({
      path: "/api/v1/convert/img/pdf",
      fields: route.fields,
    });
  });
});

describe("failures are typed refusals", () => {
  const call = (
    fetchFn: FetchLike,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    storage = fakeStorage({ "k/a": PDF })
  ) =>
    callStirling(
      { ...stirlingCallFor("pdf.compress", { fileId: FILE_ID }), timeoutMs },
      [ref("k/a", "a.pdf")],
      { fetch: fetchFn, storage }
    );

  it("a timeout is transient PDF_ENGINE_TIMEOUT", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () =>
          reject(init!.signal!.reason)
        );
      });
    const err = await refusalOf(call(hang, 30));
    expect(err.code).toBe("PDF_ENGINE_TIMEOUT");
    expect(err.errorClass).toBe("transient");
  });

  it("an unreachable engine and a 5xx are transient PDF_ENGINE_DOWN", async () => {
    const unreachable = await refusalOf(
      call(async () => {
        throw new TypeError("fetch failed");
      })
    );
    expect(unreachable.code).toBe("PDF_ENGINE_DOWN");
    expect(unreachable.errorClass).toBe("transient");
    const fiveHundred = await refusalOf(
      call(fakeFetch(() => new Response("boom", { status: 502 })).fn)
    );
    expect(fiveHundred.code).toBe("PDF_ENGINE_DOWN");
    expect(fiveHundred.errorClass).toBe("transient");
  });

  it("a 4xx is provider PDF_ENGINE_REFUSED, with the engine's own reason", async () => {
    const err = await refusalOf(
      call(
        fakeFetch(
          () =>
            new Response(
              JSON.stringify({
                title: "Bad Request",
                detail: "Password is incorrect",
              }),
              {
                status: 400,
                headers: { "content-type": "application/problem+json" },
              }
            )
        ).fn
      )
    );
    expect(err.code).toBe("PDF_ENGINE_REFUSED");
    expect(err.errorClass).toBe("provider");
    expect(err.message).toContain("Password is incorrect (HTTP 400)");
  });

  it("a file gone from storage is target_missing FILE_NOT_FOUND, not 'engine down'", async () => {
    const err = await refusalOf(
      call(fakeFetch(pdfOk).fn, DEFAULT_TIMEOUT_MS, fakeStorage({}))
    );
    expect(err.code).toBe("FILE_NOT_FOUND");
    expect(err.errorClass).toBe("target_missing");
  });

  it("a 200 that is not a PDF (an HTML error page) is refused, never stored", async () => {
    const err = await refusalOf(
      call(
        fakeFetch(() => new Response("<html>login</html>", { status: 200 })).fn
      )
    );
    expect(err.code).toBe("PDF_ENGINE_BAD_OUTPUT");
    expect(err.errorClass).toBe("provider");
  });

  it("a result declared over 50 MB is refused before it is read", async () => {
    const err = await refusalOf(
      call(
        fakeFetch(
          () =>
            new Response(PDF, {
              status: 200,
              headers: {
                "content-length": String(STIRLING_RESPONSE_MAX_BYTES + 1),
              },
            })
        ).fn
      )
    );
    expect(err.code).toBe("RESULT_TOO_LARGE");
    expect(err.errorClass).toBe("validation");
  });

  it("a result that streams past 50 MB without declaring it is cut off and refused", async () => {
    const MB = Buffer.alloc(1024 * 1024, 0x41);
    MB.write("%PDF-", 0);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(MB));
      },
    });
    const err = await refusalOf(
      call(fakeFetch(() => new Response(endless, { status: 200 })).fn)
    );
    expect(err.code).toBe("RESULT_TOO_LARGE");
    // It stopped just past the cap, not at the end of an endless body.
    expect(pulled).toBeLessThan(60);
  });

  it("an input part over 100 MB is refused before anything is sent", async () => {
    const f = fakeFetch(pdfOk);
    const err = await refusalOf(
      callStirling(
        stirlingCallFor("pdf.compress", { fileId: FILE_ID }),
        [{ ...ref("k/a", "a.pdf"), size: 101 * 1024 * 1024 }],
        { fetch: f.fn, storage: fakeStorage({ "k/a": PDF }) }
      )
    );
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.errorClass).toBe("validation");
    expect(f.calls).toHaveLength(0);
  });
});
