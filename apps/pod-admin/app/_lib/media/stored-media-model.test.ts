import { describe, expect, it } from "vitest";
import type { MediaRef } from "@synap-core/types/presentation";
import {
  documentFileMedia,
  fileTypeLabel,
  freshFor,
  imageDraw,
  isInlineImage,
  isRetryable,
  MediaSignError,
  mediaAlt,
  parseSigned,
  signFailureMessage,
  signingPath,
  withLoadFailure,
  type SignState,
} from "./stored-media-model";

const DOC = "11111111-1111-4111-8111-111111111111";
const ENT = "22222222-2222-4222-8222-222222222222";
const SIGNED =
  "https://pod.example/synap-storage/files/a.png?X-Amz-Signature=1";

const ready = (mimeType: string | null, url = SIGNED): SignState => ({
  status: "ready",
  data: { url, expiresAt: null, mimeType },
});
const failed = (status: number): SignState => ({
  status: "error",
  error: new MediaSignError(status),
});

describe("signingPath — the pod door that signs a reference", () => {
  it("a document is signed through the document door, for the record holding it", () => {
    expect(signingPath({ via: "stored", documentId: DOC })).toBe(
      `/api/files/documents/${DOC}/url`
    );
    expect(signingPath({ via: "stored", documentId: DOC }, ENT)).toBe(
      `/api/files/documents/${DOC}/url?entityId=${ENT}`
    );
  });

  it("a file entity is signed through its own door; nothing names nothing", () => {
    expect(signingPath({ via: "stored", entityId: ENT })).toBe(
      `/api/files/${ENT}/url`
    );
    expect(signingPath({ via: "stored" })).toBeNull();
  });
});

describe("isInlineImage — only rasters reach an <img>", () => {
  it("draws png, jpeg, gif, webp; never an SVG or an unnamed type", () => {
    for (const t of ["image/png", "IMAGE/JPEG", "image/webp; q=1", "image/gif"])
      expect(isInlineImage(t)).toBe(true);
    for (const t of ["image/svg+xml", "text/html", "", null, undefined])
      expect(isInlineImage(t)).toBe(false);
  });
});

describe("parseSigned — what goes into src is checked", () => {
  it("keeps an http(s) URL, its expiry and the type the pod signed", () => {
    expect(
      parseSigned({
        url: SIGNED,
        expiresAt: "2026-10-26T10:00:00Z",
        mimeType: "image/png",
      })
    ).toEqual({
      url: SIGNED,
      expiresAt: "2026-10-26T10:00:00Z",
      mimeType: "image/png",
    });
  });

  it("refuses anything else as a failure, never an image", () => {
    for (const body of [
      { url: "javascript:alert(1)" },
      { url: "data:image/png;base64,AA" },
      {},
      null,
    ])
      expect(() => parseSigned(body)).toThrow(MediaSignError);
  });
});

describe("freshFor — re-signed before the URL expires", () => {
  const now = Date.parse("2026-10-26T10:00:00Z");
  it("re-signs a minute early, never sooner than 5 s, 5 min when undated", () => {
    expect(freshFor("2026-10-26T11:00:00Z", now)).toBe(59 * 60_000);
    expect(freshFor("2026-10-26T09:00:00Z", now)).toBe(5_000);
    expect(freshFor(null, now)).toBe(5 * 60_000);
    expect(freshFor("not a date", now)).toBe(5 * 60_000);
  });
});

describe("a failed signing says why, and offers a retry only when it can help", () => {
  it("words each refusal", () => {
    expect(signFailureMessage(new MediaSignError(401))).toMatch(/Sign in/);
    expect(signFailureMessage(new MediaSignError(403))).toMatch(
      /isn’t visible to you/
    );
    expect(signFailureMessage(new MediaSignError(404))).toMatch(
      /no longer stored/
    );
    expect(signFailureMessage(new MediaSignError(500))).toMatch(
      /couldn’t be loaded/
    );
    expect(signFailureMessage(new Error("x"))).toMatch(/couldn’t be loaded/);
  });

  it("a refusal or a gone file is not retried; a broken answer is", () => {
    expect(isRetryable(new MediaSignError(403))).toBe(false);
    expect(isRetryable(new MediaSignError(404))).toBe(false);
    expect(isRetryable(new MediaSignError(0))).toBe(true);
    expect(isRetryable(new MediaSignError(500))).toBe(true);
  });
});

describe("imageDraw — the one thing to draw", () => {
  const png: MediaRef = { via: "stored", documentId: DOC, mime: "image/png" };
  const unnamed: MediaRef = { via: "stored", entityId: ENT };

  it("no media draws nothing", () => {
    expect(imageDraw({ via: "none" }, null)).toEqual({ state: "none" });
  });

  it("an outside address is a link, never loaded", () => {
    expect(
      imageDraw(
        { via: "external", url: "https://cdn.example/a.png", kind: "image" },
        null
      )
    ).toEqual({ state: "external", href: "https://cdn.example/a.png" });
    expect(
      imageDraw(
        { via: "external", url: "javascript:alert(1)", kind: "image" },
        null
      )
    ).toEqual({ state: "none" });
  });

  it("loads, then draws the signed raster", () => {
    expect(imageDraw(png, { status: "loading" })).toEqual({ state: "loading" });
    expect(imageDraw(png, ready("image/png"))).toEqual({
      state: "image",
      src: SIGNED,
    });
  });

  it("decides on the type the pod SIGNED when the ref names none", () => {
    expect(imageDraw(unnamed, ready("image/webp"))).toEqual({
      state: "image",
      src: SIGNED,
    });
    expect(imageDraw(unnamed, ready("image/svg+xml"))).toEqual({
      state: "file",
      href: SIGNED,
      mime: "image/svg+xml",
    });
    expect(imageDraw(unnamed, ready(null))).toEqual({
      state: "file",
      href: SIGNED,
      mime: null,
    });
  });

  it("an SVG is a file to download, even before it is signed", () => {
    const svg: MediaRef = {
      via: "stored",
      documentId: DOC,
      mime: "image/svg+xml",
    };
    expect(imageDraw(svg, { status: "loading" })).toEqual({
      state: "file",
      href: null,
      mime: "image/svg+xml",
    });
  });

  it("a failed signing is a failure with its reason — never 'no image'", () => {
    expect(imageDraw(png, failed(403))).toEqual({
      state: "failed",
      message: "This image isn’t visible to you.",
      retryable: false,
    });
    expect(imageDraw(png, failed(0))).toMatchObject({
      state: "failed",
      retryable: true,
    });
  });

  it("a console with no pod address says so", () => {
    expect(imageDraw(png, null, { podConfigured: false })).toMatchObject({
      state: "failed",
      retryable: false,
    });
  });
});

describe("withLoadFailure — a signed image the browser could not load", () => {
  it("is a retryable failure for that src only", () => {
    const draw = { state: "image" as const, src: SIGNED };
    expect(withLoadFailure(draw, SIGNED)).toEqual({
      state: "failed",
      message: "The image couldn’t be loaded.",
      retryable: true,
    });
    expect(withLoadFailure(draw, null)).toBe(draw);
    expect(withLoadFailure(draw, `${SIGNED}&re-signed`)).toBe(draw);
  });
});

describe("documentFileMedia — an uploaded document's own media", () => {
  it("an image or a video is media; anything else is not", () => {
    expect(documentFileMedia(DOC, "image/png")).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "image/png",
    });
    expect(documentFileMedia(DOC, "video/mp4; codecs=avc1")).toMatchObject({
      mime: "video/mp4",
    });
    expect(documentFileMedia(DOC, "application/pdf")).toBeNull();
    expect(documentFileMedia(DOC, null)).toBeNull();
  });
});

describe("fileTypeLabel", () => {
  it("names a file by its type", () => {
    expect(fileTypeLabel("image/svg+xml")).toBe("SVG image");
    expect(fileTypeLabel("application/pdf")).toBe("PDF");
    expect(fileTypeLabel(null)).toBe("File");
  });
});

describe("mediaAlt — an image is called by its record", () => {
  it("the record's title, else the file's name, else nothing", () => {
    expect(mediaAlt("Carousel 04", { fileName: "IMG_2041.png" })).toBe(
      "Carousel 04"
    );
    expect(mediaAlt("  ", { fileName: "IMG_2041.png" })).toBe("IMG_2041.png");
    expect(mediaAlt(null, null)).toBe("");
  });
});
