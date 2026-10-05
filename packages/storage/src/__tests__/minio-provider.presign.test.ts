/**
 * Presigned URLs handed to CLIENTS must name a host the client can reach.
 *
 * SigV4 signs the `host` header, so a URL signed against the compose-internal
 * endpoint (`http://minio:9000`) is unusable outside the pod network and cannot
 * be rewritten afterwards. These tests drive the REAL presigner (signing is
 * local — no network) and assert on the URL it produced.
 */
import { describe, it, expect } from "vitest";
import { MinIOStorageProvider } from "../minio-provider.js";
import { StorageUploadUnavailableError } from "../interface.js";

const base = {
  endpoint: "http://minio:9000",
  accessKeyId: "k",
  secretAccessKey: "s",
  bucketName: "synap-storage",
};

function provider(publicUrl?: string): MinIOStorageProvider {
  const p = new MinIOStorageProvider({ ...base, publicUrl });
  // Skip the HeadBucket round-trip — these tests never talk to MinIO.
  (p as unknown as { bucketInitialized: boolean }).bucketInitialized = true;
  return p;
}

describe("MinIO presigned URLs — client reachability", () => {
  it("signs an upload URL against the PUBLIC origin, bucket path at root", async () => {
    const url = new URL(
      await provider("https://pod.example.com").getSignedUploadUrl(
        "files/ws/uploads/u/x/clip.mp4",
        { contentType: "video/mp4", contentLength: 123 }
      )
    );
    expect(url.host).toBe("pod.example.com");
    expect(url.pathname).toBe("/synap-storage/files/ws/uploads/u/x/clip.mp4");
    // Content-Type and Content-Length are part of the signature.
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed).toContain("content-length");
    expect(signed).toContain("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("refuses (typed) to presign an upload with no public URL configured", async () => {
    await expect(
      provider().getSignedUploadUrl("k", {
        contentType: "video/mp4",
        contentLength: 1,
      })
    ).rejects.toBeInstanceOf(StorageUploadUnavailableError);
  });

  it("signs download URLs against the public origin when configured", async () => {
    const url = new URL(
      await provider("https://pod.example.com").getSignedUrl("a/b.png", 60)
    );
    expect(url.host).toBe("pod.example.com");
  });

  it("keeps the historical internal-host download URL when no public URL is set", async () => {
    const url = new URL(await provider().getSignedUrl("a/b.png", 60));
    expect(url.host).toBe("minio:9000");
  });
});
