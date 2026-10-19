import { describe, expect, it, vi } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  fileProblem,
  uploadProvidedFile,
  uploadRefusalWords,
} from "./provide-file";

const pdf = { name: "Invoice.PDF", type: "application/pdf", size: 2048 };

describe("what the agent asked for", () => {
  it("problems before sending, in words", () => {
    expect(fileProblem(pdf, [".pdf"])).toBeNull();
    // A bare token is an extension, as on every surface.
    expect(fileProblem(pdf, ["pdf"])).toBeNull();
    expect(fileProblem(pdf, [".csv"])).toBe(
      "The agent asked for .csv. Pick a file of that type."
    );
    expect(fileProblem({ ...pdf, size: 0 }, null)).toMatch(/empty/);
    expect(fileProblem({ ...pdf, size: MAX_UPLOAD_BYTES + 1 }, null)).toMatch(
      /larger than 10 MB/
    );
  });
});

describe("uploadProvidedFile", () => {
  const landing = { workspaceId: "w1", projectId: "p1" };
  const fileId = "44444444-4444-4444-8444-444444444444";

  it("posts to the pod's upload door with the space and project, returns the file id", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ entityId: fileId }), { status: 200 })
    );
    const result = await uploadProvidedFile({
      podUrl: "https://pod.example/",
      file: new File(["x"], "a.pdf", { type: "application/pdf" }),
      landing,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, fileId });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://pod.example/api/files/upload");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const body = init.body as FormData;
    expect(body.get("workspaceId")).toBe("w1");
    expect(body.get("projectId")).toBe("p1");
    expect((body.get("file") as File).name).toBe("a.pdf");
  });

  it("no project: none is sent", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ entityId: fileId }), { status: 200 })
    );
    await uploadProvidedFile({
      podUrl: "https://pod.example",
      file: new File(["x"], "a.pdf"),
      landing: { workspaceId: "w1", projectId: null },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect((init.body as FormData).has("projectId")).toBe(false);
  });

  it("a refusal, a network failure or an unreadable reply is said in words", async () => {
    const run = (fetchImpl: () => Promise<Response>) =>
      uploadProvidedFile({
        podUrl: "https://pod.example",
        file: new File(["x"], "a.pdf"),
        landing,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    expect(await run(async () => new Response("{}", { status: 403 }))).toEqual({
      ok: false,
      status: 403,
      message: uploadRefusalWords(403),
    });
    expect(
      await run(async () => {
        throw new TypeError("network");
      })
    ).toMatchObject({ ok: false, status: 0 });
    expect(
      await run(async () => new Response(JSON.stringify({ entityId: "nope" })))
    ).toMatchObject({ ok: false });
  });

  it("every refusal reads as a sentence", () => {
    for (const s of [0, 401, 403, 413, 415, 500]) {
      expect(uploadRefusalWords(s)).toMatch(/^[A-Z].*\.$/);
    }
  });
});
