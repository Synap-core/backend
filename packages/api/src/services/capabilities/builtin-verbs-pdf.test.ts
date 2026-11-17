/**
 * The PDF verbs (PDF tools W1), driven through the REAL registered handlers
 * (`BUILTIN_VERBS["pdf.*"]`) and the real runner (`services/pdf/run-pdf-verb.ts`),
 * with the doors mocked at their seams:
 *   - the read floor (`readableFileEntity`),
 *   - the engine (`callStirling`; the probe is the REAL one where "off" is the
 *     point, so "no STIRLING_URL → refusal" is proven end to end),
 *   - the governed file door (`createGovernedFileEntityFromBuffer`),
 *   - the governed relations door (`relationsRouter.createCaller().create`).
 *
 * What it pins: engine off/down are answered before any file is read; each
 * refusal is a typed `VerbRefusal` with its class and code; a new file goes
 * through the governed door with the acting agent, titled from its source,
 * and is linked `derived_from` each source through the governed relations
 * door, under the agent; a proposed file reports `link: "pending"` and makes
 * no edge; a failed edge is reported, never swallowed; `pdf.info` creates
 * nothing.
 *
 * NOT covered here: the engine wire (stirling-client.test.ts); the doors'
 * own governance (their own suites); a live pod (the devbox/CI pglite run).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readable: vi.fn(),
  probe: vi.fn(),
  callStirling: vi.fn(),
  storeFile: vi.fn(),
  createCaller: vi.fn(),
  linkCreate: vi.fn(),
  defaultWorkspace: vi.fn(),
}));

vi.mock("../../routers/file-upload.js", () => ({
  readableFileEntity: h.readable,
}));
vi.mock("../../routers/create-governed-file-entity.js", () => ({
  createGovernedFileEntityFromBuffer: h.storeFile,
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: h.createCaller },
}));
vi.mock("../../utils/user-default-workspace.js", () => ({
  findUserDefaultWorkspaceId: h.defaultWorkspace,
}));
vi.mock("../pdf/stirling-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../pdf/stirling-client.js")>();
  return { ...actual, probePdfEngine: h.probe, callStirling: h.callStirling };
});

import {
  BUILTIN_VERBS,
  BUILTIN_VERB_PARAM_SCHEMAS,
  READ_ONLY_BUILTIN_VERBS,
  type BuiltinVerbContext,
} from "./builtin-verbs.js";

const SRC = "11111111-1111-4111-8111-111111111111";
const SRC_2 = "22222222-2222-4222-8222-222222222222";
const NEW_FILE = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const PDF = Buffer.from("%PDF-1.7\nresult\n%%EOF");

const ctx: BuiltinVerbContext = {
  userId: "user-1",
  workspaceId: WS,
  agentUserId: "agent-1",
  sessionId: "session-1",
};

function readableFile(over: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    entity: {
      id: SRC,
      documentId: "doc-src",
      storageKey: "k/src",
      mimeType: "application/pdf",
      title: "Scan.pdf",
      size: 1234,
      deletedAt: null,
      ...over,
    },
  };
}

async function refusalOf(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, "expected a refusal").toBeTruthy();
  return err as {
    name: string;
    errorClass: string;
    code: string;
    message: string;
  };
}

const run = (verb: string, params: Record<string, unknown>, c = ctx) =>
  BUILTIN_VERBS[verb]!(params, c) as Promise<Record<string, unknown>>;

const ORIGINAL_URL = process.env.STIRLING_URL;
beforeEach(() => {
  vi.clearAllMocks();
  h.probe.mockResolvedValue("ok");
  h.readable.mockResolvedValue(readableFile());
  h.callStirling.mockResolvedValue({ bytes: PDF, mimeType: "application/pdf" });
  h.storeFile.mockResolvedValue({
    status: "created",
    fileEntityId: NEW_FILE,
    documentId: "doc-new",
  });
  h.linkCreate.mockResolvedValue({ id: "rel-1", status: "created" });
  h.createCaller.mockReturnValue({ create: h.linkCreate });
  h.defaultWorkspace.mockResolvedValue(null);
});
afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.STIRLING_URL;
  else process.env.STIRLING_URL = ORIGINAL_URL;
});

describe("registration", () => {
  const VERBS = [
    "pdf.ocr",
    "pdf.compress",
    "pdf.merge",
    "pdf.split",
    "pdf.redact",
    "pdf.to_pdf",
    "pdf.to_markdown",
    "pdf.info",
    "pdf.protect",
    "pdf.unprotect",
  ];
  it("every PDF verb has a handler and a param schema; only pdf.info is read-only", () => {
    for (const v of VERBS) {
      expect(BUILTIN_VERBS[v], v).toBeTypeOf("function");
      expect(BUILTIN_VERB_PARAM_SCHEMAS[v], v).toBeTruthy();
    }
    expect(VERBS.filter((v) => READ_ONLY_BUILTIN_VERBS.has(v))).toEqual([
      "pdf.info",
    ]);
  });
});

describe("refusals: nothing runs, the class and code say why", () => {
  it("engine OFF (no STIRLING_URL, the real probe): refused before any file is read", async () => {
    const { probePdfEngine } = await vi.importActual<
      typeof import("../pdf/stirling-client.js")
    >("../pdf/stirling-client.js");
    h.probe.mockImplementation(probePdfEngine);
    delete process.env.STIRLING_URL;
    const err = await refusalOf(run("pdf.ocr", { fileId: SRC }));
    expect(err.name).toBe("VerbRefusal");
    expect(err.code).toBe("PDF_ENGINE_OFF");
    expect(err.errorClass).toBe("provider");
    expect(h.readable).not.toHaveBeenCalled();
    expect(h.callStirling).not.toHaveBeenCalled();
    expect(h.storeFile).not.toHaveBeenCalled();
  });

  it("engine OFF refuses pdf.info too (never an empty success)", async () => {
    h.probe.mockResolvedValue("off");
    const err = await refusalOf(run("pdf.info", { fileId: SRC }));
    expect(err.code).toBe("PDF_ENGINE_OFF");
  });

  it("engine DOWN: transient PDF_ENGINE_DOWN, before any file is read", async () => {
    h.probe.mockResolvedValue("down");
    const err = await refusalOf(run("pdf.compress", { fileId: SRC }));
    expect(err.code).toBe("PDF_ENGINE_DOWN");
    expect(err.errorClass).toBe("transient");
    expect(h.readable).not.toHaveBeenCalled();
  });

  it("a missing file is target_missing; a file you cannot read is permission", async () => {
    h.readable.mockResolvedValueOnce({ ok: false, status: 404, error: "x" });
    const missing = await refusalOf(run("pdf.ocr", { fileId: SRC }));
    expect(missing.code).toBe("FILE_NOT_FOUND");
    expect(missing.errorClass).toBe("target_missing");
    expect(h.readable).toHaveBeenCalledWith("user-1", SRC);

    h.readable.mockResolvedValueOnce({ ok: false, status: 403, error: "x" });
    const forbidden = await refusalOf(run("pdf.ocr", { fileId: SRC }));
    expect(forbidden.code).toBe("FILE_NOT_READABLE");
    expect(forbidden.errorClass).toBe("permission");
    expect(h.callStirling).not.toHaveBeenCalled();
  });

  it("a trashed file, or one with no stored bytes, is target_missing", async () => {
    h.readable.mockResolvedValueOnce(readableFile({ deletedAt: new Date() }));
    expect((await refusalOf(run("pdf.ocr", { fileId: SRC }))).errorClass).toBe(
      "target_missing"
    );
    h.readable.mockResolvedValueOnce(readableFile({ storageKey: undefined }));
    const noBytes = await refusalOf(run("pdf.ocr", { fileId: SRC }));
    expect(noBytes.code).toBe("FILE_NO_BYTES");
    expect(noBytes.errorClass).toBe("target_missing");
  });

  it("a file over 100 MB is validation FILE_TOO_LARGE and is never sent", async () => {
    h.readable.mockResolvedValueOnce(readableFile({ size: 101 * 1024 * 1024 }));
    const err = await refusalOf(run("pdf.compress", { fileId: SRC }));
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.errorClass).toBe("validation");
    expect(h.callStirling).not.toHaveBeenCalled();
  });

  it("pdf.to_pdf refuses a type it cannot convert (UNSUPPORTED_TYPE)", async () => {
    h.readable.mockResolvedValueOnce(
      readableFile({ mimeType: "application/zip", title: "bundle.zip" })
    );
    const err = await refusalOf(run("pdf.to_pdf", { fileId: SRC }));
    expect(err.code).toBe("UNSUPPORTED_TYPE");
    expect(err.errorClass).toBe("validation");
    expect(h.callStirling).not.toHaveBeenCalled();
  });

  it("a PDF verb refuses a file that is not a PDF (NOT_A_PDF)", async () => {
    h.readable.mockResolvedValueOnce(
      readableFile({ mimeType: "image/png", title: "photo.png" })
    );
    const err = await refusalOf(run("pdf.ocr", { fileId: SRC }));
    expect(err.code).toBe("NOT_A_PDF");
    expect(h.callStirling).not.toHaveBeenCalled();
  });

  it("no space to file the result in: validation PDF_NO_SPACE, nothing stored", async () => {
    const err = await refusalOf(
      run("pdf.compress", { fileId: SRC }, { ...ctx, workspaceId: null })
    );
    expect(err.code).toBe("PDF_NO_SPACE");
    expect(h.storeFile).not.toHaveBeenCalled();
  });
});

describe("the happy path: a governed new file, linked derived_from its source", () => {
  it("pdf.ocr: engine call, governed file under the agent, governed edge under the agent", async () => {
    const out = await run("pdf.ocr", { fileId: SRC, languages: ["fra"] });

    // The engine got the stored file, named with the extension Stirling reads.
    const [spec, files] = h.callStirling.mock.calls[0]!;
    expect(spec).toMatchObject({
      path: "/api/v1/misc/ocr-pdf",
      fields: { languages: ["fra"] },
    });
    expect(files).toEqual([
      {
        storageKey: "k/src",
        filename: "Scan.pdf",
        contentType: "application/pdf",
        size: 1234,
      },
    ]);

    // The output went through the GOVERNED file door, as the agent.
    expect(h.storeFile).toHaveBeenCalledTimes(1);
    expect(h.storeFile.mock.calls[0]![0]).toMatchObject({
      buffer: PDF,
      mimeType: "application/pdf",
      title: "Scan (OCR)",
      filename: "Scan (OCR).pdf",
      userId: "user-1",
      workspaceId: WS,
      agentUserId: "agent-1",
      sessionId: "session-1",
    });

    // The edge went through the governed relations door, with the agent on the
    // caller context (relations.create gates on ctx.agentUserId).
    expect(h.createCaller.mock.calls[0]![0]).toMatchObject({
      userId: "user-1",
      agentUserId: "agent-1",
      sessionId: "session-1",
    });
    expect(h.linkCreate).toHaveBeenCalledWith({
      sourceEntityId: NEW_FILE,
      targetEntityId: SRC,
      type: "derived_from",
      workspaceId: WS,
      metadata: { verb: "pdf.ocr" },
    });

    expect(out).toMatchObject({
      status: "created",
      fileEntityId: NEW_FILE,
      documentId: "doc-new",
      title: "Scan (OCR)",
      mimeType: "application/pdf",
      sourceFileIds: [SRC],
      link: "linked",
      links: [{ sourceFileId: SRC, state: "linked", relationId: "rel-1" }],
    });
  });

  it("a proposed file: link is pending and no edge is attempted (no id yet)", async () => {
    h.storeFile.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod/open/prop-1",
      documentId: "doc-new",
    });
    const out = await run("pdf.compress", { fileId: SRC });
    expect(out).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod/open/prop-1",
      link: "pending",
      links: [],
    });
    expect(out.fileEntityId).toBeUndefined();
    expect(h.linkCreate).not.toHaveBeenCalled();
  });

  it("pdf.merge: one edge per source; a proposed edge and a FAILED edge are both reported", async () => {
    h.readable.mockImplementation(async (_u: string, id: string) =>
      readableFile({
        id,
        title: id === SRC ? "A.pdf" : "B.pdf",
        storageKey: `k/${id}`,
      })
    );
    h.linkCreate
      .mockResolvedValueOnce({ status: "proposed", proposalId: "prop-edge" })
      .mockRejectedValueOnce(new Error("Unknown relation type"));
    const out = await run("pdf.merge", { fileIds: [SRC, SRC_2] });

    expect(
      h.callStirling.mock.calls[0]![1].map(
        (f: { filename: string }) => f.filename
      )
    ).toEqual(["A.pdf", "B.pdf"]);
    expect(h.linkCreate.mock.calls.map((c) => c[0].targetEntityId)).toEqual([
      SRC,
      SRC_2,
    ]);
    expect(out).toMatchObject({
      status: "created",
      title: "A (merged)",
      link: "failed",
      links: [
        { sourceFileId: SRC, state: "proposed", proposalId: "prop-edge" },
        {
          sourceFileId: SRC_2,
          state: "failed",
          error: "Unknown relation type",
        },
      ],
    });
  });

  it("pdf.split: a ZIP result is stored as one .zip file and says so", async () => {
    h.callStirling.mockResolvedValueOnce({
      bytes: Buffer.from([0x50, 0x4b, 3, 4]),
      mimeType: "application/zip",
    });
    const out = await run("pdf.split", { fileId: SRC, pages: "1-3" });
    expect(h.storeFile.mock.calls[0]![0]).toMatchObject({
      mimeType: "application/zip",
      title: "Scan (pages 1-3)",
      filename: "Scan (pages 1-3).zip",
    });
    expect(out.note).toMatch(/ZIP/);
  });

  it("pdf.to_pdf: the route follows the source type and the part carries its extension", async () => {
    h.readable.mockResolvedValueOnce(
      readableFile({
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        title: "Brief",
      })
    );
    await run("pdf.to_pdf", { fileId: SRC });
    const [spec, files] = h.callStirling.mock.calls[0]!;
    expect(spec.path).toBe("/api/v1/convert/file/pdf");
    expect(files[0].filename).toBe("Brief.docx");
    expect(h.storeFile.mock.calls[0]![0].title).toBe("Brief (PDF)");
  });

  it("no ambient workspace: the person's default space is used", async () => {
    h.defaultWorkspace.mockResolvedValueOnce(WS);
    await run("pdf.compress", { fileId: SRC }, { ...ctx, workspaceId: null });
    expect(h.storeFile.mock.calls[0]![0].workspaceId).toBe(WS);
    expect(h.linkCreate.mock.calls[0]![0].workspaceId).toBe(WS);
  });
});

describe("pdf.info reads only", () => {
  it("returns the engine's JSON and creates nothing", async () => {
    h.callStirling.mockResolvedValueOnce({
      bytes: Buffer.from(
        JSON.stringify({ BasicInfo: { "Number of pages": 3 } })
      ),
      mimeType: "application/json",
    });
    const out = await run("pdf.info", { fileId: SRC });
    expect(out).toEqual({
      fileId: SRC,
      info: { BasicInfo: { "Number of pages": 3 } },
    });
    expect(h.callStirling.mock.calls[0]![0].path).toBe(
      "/api/v1/security/get-info-on-pdf"
    );
    expect(h.storeFile).not.toHaveBeenCalled();
    expect(h.createCaller).not.toHaveBeenCalled();
  });
});
