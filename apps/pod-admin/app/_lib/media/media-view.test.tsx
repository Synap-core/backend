import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaFrame } from "./media-view";
import { MediaSignError } from "./stored-media-model";
import { signStoredMedia } from "./use-stored-media";

const SIGNED =
  "https://pod.example/synap-storage/files/a.png?X-Amz-Signature=1";
const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("MediaFrame — every state drawn and worded", () => {
  it("none draws nothing", () => {
    expect(
      html(<MediaFrame draw={{ state: "none" }} alt="Logo" size="full" />)
    ).toBe("");
  });

  it("loading is a sized, labelled placeholder — no image yet", () => {
    const out = html(
      <MediaFrame draw={{ state: "loading" }} alt="Logo" size="thumb" />
    );
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-label="Loading Logo…"');
    expect(out).not.toContain("<img");
  });

  it("loaded: a lazy, bounded image named by its record, that opens full size", () => {
    const out = html(
      <MediaFrame
        draw={{ state: "image", src: SIGNED }}
        alt="Contact sheet"
        size="thumb"
      />
    );
    expect(out).toContain(`src="${SIGNED}"`);
    expect(out).toContain('alt="Contact sheet"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain("max-h-40");
    expect(out).toContain('aria-label="Open Contact sheet full size"');
    // Its edge is an outline: an inset ring paints under the image's pixels.
    const img = out.slice(out.indexOf("<img"));
    expect(img).toContain("outline-foreground/10");
    expect(img.slice(0, img.indexOf(">"))).not.toContain("ring-inset");
  });

  it("failed: says why and offers Try again when asking again can help", () => {
    const out = html(
      <MediaFrame
        draw={{
          state: "failed",
          message: "The image couldn’t be loaded.",
          retryable: true,
        }}
        alt="Logo"
        size="full"
        onRetry={() => {}}
      />
    );
    expect(out).toContain("The image couldn’t be loaded.");
    expect(out).toContain("Try again");
    expect(out).not.toContain("<img");
  });

  it("a refusal is worded without a retry", () => {
    const out = html(
      <MediaFrame
        draw={{
          state: "failed",
          message: "This image isn’t visible to you.",
          retryable: false,
        }}
        alt="Logo"
        size="full"
        onRetry={() => {}}
      />
    );
    expect(out).toContain("This image isn’t visible to you.");
    expect(out).not.toContain("Try again");
  });

  it("a stored file that is not a drawable raster is named and downloaded, never drawn", () => {
    const out = html(
      <MediaFrame
        draw={{ state: "file", href: SIGNED, mime: "image/svg+xml" }}
        alt="Synap logo"
        size="full"
      />
    );
    expect(out).toContain("SVG image · Synap logo");
    expect(out).toContain("href=");
    expect(out).not.toContain("<img");
  });

  it("an outside address is a link out, never loaded", () => {
    const out = html(
      <MediaFrame
        draw={{ state: "external", href: "https://cdn.example/a.png" }}
        alt="Cover"
        size="full"
      />
    );
    expect(out).toContain('href="https://cdn.example/a.png"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toContain("<img");
  });
});

describe("signStoredMedia — one signing on the reader's own cookie", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });

  it("asks the pod door with credentials and returns the signed URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({ url: SIGNED, expiresAt: null, mimeType: "image/png" })
    );
    await expect(
      signStoredMedia("https://pod.example", "/api/files/x/url", fetchImpl)
    ).resolves.toEqual({ url: SIGNED, expiresAt: null, mimeType: "image/png" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pod.example/api/files/x/url",
      {
        credentials: "include",
      }
    );
  });

  it("a refusal throws with its status — never an empty answer", async () => {
    for (const status of [401, 403, 404, 500]) {
      const err = await signStoredMedia(
        "https://pod.example",
        "/p",
        async () => new Response("{}", { status })
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaSignError);
      expect((err as MediaSignError).status).toBe(status);
    }
  });

  it("an unreachable pod or an unusable answer throws too", async () => {
    const down = await signStoredMedia(
      "https://pod.example",
      "/p",
      async () => {
        throw new TypeError("network");
      }
    ).catch((e: unknown) => e);
    expect((down as MediaSignError).status).toBe(0);
    const notJson = await signStoredMedia(
      "https://pod.example",
      "/p",
      async () => new Response("<html>", { status: 200 })
    ).catch((e: unknown) => e);
    expect(notJson).toBeInstanceOf(MediaSignError);
  });
});
