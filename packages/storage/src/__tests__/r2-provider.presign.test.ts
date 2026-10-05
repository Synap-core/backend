/**
 * R2 presigned upload URLs, driven through the REAL presigner (signing is
 * local — no network). `r2-provider.test.ts` mocks the SDK and so cannot see
 * what the URL actually carries.
 */
import { describe, it, expect } from "vitest";
import { R2StorageProvider } from "../r2-provider.js";

describe("R2 presigned upload URL", () => {
  it("signs Content-Type + Content-Length and carries NO flexible-checksum params", async () => {
    const p = new R2StorageProvider({
      accountId: "acct",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucketName: "b",
    });
    const url = new URL(
      await p.getSignedUploadUrl("files/ws/uploads/u/x/clip.mp4", {
        contentType: "video/mp4",
        contentLength: 123,
      })
    );
    const params = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(params).toContain("x-amz-signature");
    expect(params.filter((k) => k.startsWith("x-amz-checksum"))).toEqual([]);
    expect(params).not.toContain("x-amz-sdk-checksum-algorithm");
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type", "host"])
    );
  });
});
