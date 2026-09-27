/**
 * Stored-file checksums — a leaf with no provider or SDK import, so a consumer
 * (the document content door) can compare checksums without pulling in, or
 * being blinded by a test mock of, the storage client itself.
 */

import { createHash } from "crypto";

/**
 * THE stored-file checksum: `sha256:<hex>`. Every provider stamps
 * `FileMetadata.checksum` with this, and rows that copy it
 * (`document_versions.checksum`) are compared against content with
 * {@link checksumMatchesContent}.
 *
 * One encoding on purpose: MinIO/R2 used to stamp `sha256:<base64>` while the
 * local provider and the document door computed `sha256:<hex>`. The door's
 * "unchanged since the last checkpoint?" test then never matched on a real
 * pod, so every autosave tick and every room close cut a version row for a
 * document nobody had edited.
 */
export function fileChecksum(content: string | Buffer): string {
  const buf =
    typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/**
 * Does a stored checksum describe these bytes? Accepts the current
 * `sha256:<hex>` and the legacy `sha256:<base64>` that MinIO/R2 stamped before
 * {@link fileChecksum} existed — rows carrying it are persisted and stay
 * comparable.
 */
export function checksumMatchesContent(
  stored: string | null | undefined,
  content: string | Buffer
): boolean {
  if (!stored || !stored.startsWith("sha256:")) return false;
  const buf =
    typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const digest = createHash("sha256").update(buf).digest();
  const value = stored.slice("sha256:".length);
  return (
    value === digest.toString("hex") || value === digest.toString("base64")
  );
}
