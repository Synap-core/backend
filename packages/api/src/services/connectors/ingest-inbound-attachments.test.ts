/**
 * Inbound attachments fetch through THE guarded remote-bytes door
 * (`fetchGuardedBytes` → `openGuardedMedia`: validate + pinned
 * `safePublicFetch`, Content-Length pre-check, capped streamed read):
 *   - a public attachment's bytes and declared type reach the governed file
 *     door;
 *   - a private address is skipped without any request;
 *   - an attachment over 25 MB (declared or streamed) is skipped, the rest
 *     still land.
 *
 * Stubbed: the pinned fetcher (`safePublicFetch`, so the real validator and
 * the real capped reader run), the governed file door and the database writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requested: [] as string[],
  stored: [] as Array<{ buffer: Buffer; mimeType: string; filename: string }>,
  responses: new Map<string, () => Response>(),
}));

vi.mock("@synap/shared-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safePublicFetch: async (url: string) => {
      h.requested.push(url);
      const make = h.responses.get(url);
      if (!make) throw new Error(`unexpected fetch ${url}`);
      return make();
    },
    safeExternalFetch: async () => {
      throw new Error("the unpinned fetcher must not be used");
    },
  };
});

vi.mock("../../routers/create-governed-file-entity.js", () => ({
  createGovernedFileEntityFromBuffer: async (p: {
    buffer: Buffer;
    mimeType: string;
    filename: string;
  }) => {
    h.stored.push(p);
    return { status: "created", fileEntityId: `file-${h.stored.length}` };
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    values: () => chain,
    onConflictDoNothing: async () => undefined,
    set: () => chain,
    where: async () => undefined,
  };
  return {
    ...actual,
    db: {
      insert: () => chain,
      update: () => chain,
      query: { messages: { findFirst: async () => ({ metadata: {} }) } },
    },
  };
});

import { runInboundAttachmentIngest } from "./ingest-inbound-attachments.js";

const PDF = Buffer.from("%PDF-1.7 the quarterly report");

function job(urls: string[]) {
  return {
    channelId: "channel-1",
    messageId: "message-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    provider: "telegram",
    attachments: urls.map((url) => ({ url, type: "document" })),
  };
}

beforeEach(() => {
  h.requested.length = 0;
  h.stored.length = 0;
  h.responses.clear();
});

describe("runInboundAttachmentIngest", () => {
  it("a public attachment's bytes and declared type reach the governed file door", async () => {
    const url = "https://files.example.com/report.pdf";
    h.responses.set(
      url,
      () =>
        new Response(PDF, {
          headers: { "content-type": "application/pdf; charset=binary" },
        })
    );
    expect(await runInboundAttachmentIngest(job([url]) as never)).toEqual({
      stored: 1,
      skipped: 0,
    });
    expect(h.stored).toEqual(
      [
        { buffer: PDF, mimeType: "application/pdf", filename: "report.pdf" },
      ].map((x) => expect.objectContaining(x))
    );
  });

  it("a private address is skipped without a request; an oversized one too, the rest land", async () => {
    const ok = "https://files.example.com/a.pdf";
    const big = "https://files.example.com/big.bin";
    const lying = "https://files.example.com/lying.bin";
    h.responses.set(ok, () => new Response(PDF));
    h.responses.set(
      big,
      () =>
        new Response("x", {
          headers: { "content-length": String(26 * 1024 * 1024) },
        })
    );
    // No Content-Length, a body past 25 MB: cut by the streamed cap.
    h.responses.set(
      lying,
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(1024 * 1024));
            },
          })
        )
    );
    const result = await runInboundAttachmentIngest(
      job(["http://10.0.0.5/secret", big, lying, ok]) as never
    );
    expect(result).toEqual({ stored: 1, skipped: 3 });
    expect(h.requested).not.toContain("http://10.0.0.5/secret");
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]!.buffer).toEqual(PDF);
  });
});
