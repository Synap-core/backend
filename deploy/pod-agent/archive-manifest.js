"use strict";

/**
 * The archive's manifest, as archive-pod.sh prints it on its last stdout line
 * (`ARCHIVE_MANIFEST {json}`). pod-agent returns it as the pulled result's
 * `data.archiveManifest`; the CP refuses to delete a server unless it lists
 * every expected volume (control plane: archive-manifest.ts).
 *
 * Returns the parsed object, or null when the line is absent or not JSON —
 * never a guess: a missing manifest reaches the CP as missing, and the CP
 * keeps the server.
 */
function archiveManifestFrom(output) {
  const lines = String(output || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^ARCHIVE_MANIFEST (\{.*\})\s*$/.exec(lines[i]);
    if (!match) continue;
    try {
      const manifest = JSON.parse(match[1]);
      return manifest && typeof manifest === "object" ? manifest : null;
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { archiveManifestFrom };
