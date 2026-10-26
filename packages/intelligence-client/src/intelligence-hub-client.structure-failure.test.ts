/**
 * `structure()` says WHY it returned `null` (issue 1c252b3b).
 *
 * Every non-auth failure is still a `null`, but the cause now reaches the
 * caller through `onFailure` instead of living in a `console.warn` line only:
 * a degraded capture was unexplainable without host log access, and a 402 was
 * retried and reported as transient. One case per cause the client can see.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntelligenceAuthError,
  IntelligenceHubClient,
  type StructureFailure,
} from "./intelligence-hub-client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => fetchMock.mockReset());

const client = new IntelligenceHubClient("http://intelligence.test", "key");

const jsonAnswer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const sse = (...frames: unknown[]) =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
const STAGE = {
  v: 1,
  seq: 1,
  kind: "stage",
  stage: "understanding",
  attempt: 1,
  at: "2026-10-26T00:00:00.000Z",
};
const BODY = { entities: [], relations: [], followUp: null };

/** Run one call; the result and every failure it reported. */
async function run(
  input: { text: string; timeoutMs?: number } = { text: "x" },
  stream = false
) {
  const failures: StructureFailure[] = [];
  const result = await client.structure(input, {
    onFailure: (f) => failures.push(f),
    ...(stream ? { onProgress: () => {} } : {}),
  });
  return { result, failures };
}

describe("IntelligenceHubClient.structure — the failure cause travels", () => {
  it.each([400, 413, 429, 500, 502])(
    "a %i answer is null with cause http and its status",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        jsonAnswer(status, { error: "Validation error" })
      );
      expect(await run()).toEqual({
        result: null,
        failures: [{ cause: "http", status }],
      });
    }
  );

  it("a 402 carries the IS failure envelope, never the rest of the body", async () => {
    const failure = { code: "credits_empty", retryable: false };
    fetchMock.mockResolvedValueOnce(
      jsonAnswer(402, { error: "no credits", failure, detail: "secret" })
    );
    expect((await run()).failures).toEqual([
      { cause: "http", status: 402, failure },
    ]);
  });

  it("a stream that ends without a result frame is cause stream", async () => {
    fetchMock.mockResolvedValueOnce(sse(STAGE));
    expect(await run({ text: "x" }, true)).toEqual({
      result: null,
      failures: [{ cause: "stream" }],
    });
  });

  it("an error frame is cause stream", async () => {
    fetchMock.mockResolvedValueOnce(
      sse(STAGE, { type: "error", error: "structure_error: TypeError" })
    );
    expect((await run({ text: "x" }, true)).failures).toEqual([
      { cause: "stream" },
    ]);
  });

  it("a non-200 result frame is cause stream with that status and envelope", async () => {
    const failure = { code: "provider_error", retryable: true };
    fetchMock.mockResolvedValueOnce(
      sse({ type: "result", status: 503, body: { error: "x", failure } })
    );
    expect((await run({ text: "x" }, true)).failures).toEqual([
      { cause: "stream", status: 503, failure },
    ]);
  });

  it("no answer at all is cause network, with the transport's own words", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await run()).failures).toEqual([
      { cause: "network", message: "fetch failed" },
    ]);
  });

  it("the deadline is cause timeout", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        )
    );
    expect((await run({ text: "x", timeoutMs: 5 })).failures).toEqual([
      { cause: "timeout" },
    ]);
  });

  it("a 200 whose body will not parse is cause http, status 200", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    expect((await run()).failures).toEqual([{ cause: "http", status: 200 }]);
  });

  it("a success reports nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonAnswer(200, BODY));
    expect(await run()).toEqual({ result: BODY, failures: [] });
  });

  it("an auth refusal still throws, and is not reported as a null's cause", async () => {
    fetchMock.mockResolvedValueOnce(jsonAnswer(401, { error: "no" }));
    const onFailure = vi.fn();
    await expect(
      client.structure({ text: "x" }, { onFailure })
    ).rejects.toBeInstanceOf(IntelligenceAuthError);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("a sink that throws does not turn the null into a throw", async () => {
    fetchMock.mockResolvedValueOnce(jsonAnswer(500, {}));
    expect(
      await client.structure(
        { text: "x" },
        {
          onFailure: () => {
            throw new Error("broken sink");
          },
        }
      )
    ).toBeNull();
  });
});
