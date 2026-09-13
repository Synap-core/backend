/**
 * Operator op selection — `run-conversions.ts --only <opKey>`.
 *
 * Narrows the manifest HANDED to `runConversions` rather than adding a second
 * engine entry point: the engine's contract (ledger, defer, destructive-tail
 * refusal) applies unchanged to whatever subset is selected.
 */

import type { ConversionManifest } from "./manifest.js";
import { suggestClosest } from "../services/did-you-mean.js";

/**
 * Collect every `--only` value from argv. Accepts `--only a`, `--only=a`,
 * repeats, and comma-separated lists. Returns `null` when `--only` is absent
 * (run the whole manifest) — never `[]`, which would mean "select nothing".
 * A `--only` with no value is a hard error.
 */
export function parseOnlyArgs(argv: readonly string[]): string[] | null {
  let seen = false;
  const keys: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw: string | undefined;
    if (arg === "--only") {
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new Error(
          "--only requires an opKey (e.g. --only w4.dedupe.knowledge)"
        );
      }
      i++;
    } else if (arg.startsWith("--only=")) {
      raw = arg.slice("--only=".length);
    } else {
      continue;
    }
    seen = true;
    const parts = raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      throw new Error(
        "--only requires an opKey (e.g. --only w4.dedupe.knowledge)"
      );
    }
    keys.push(...parts);
  }
  return seen ? keys : null;
}

/** Candidates for an unknown key: substring hits first, then the fuzzy nearest. */
function closeMatches(key: string, known: readonly string[]): string[] {
  const needle = key.toLowerCase();
  const hits = known.filter((k) => {
    const hay = k.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
  const nearest = suggestClosest(key, known);
  if (nearest && !hits.includes(nearest)) hits.push(nearest);
  return hits.slice(0, 5);
}

/**
 * The manifest restricted to `opKeys`, in MANIFEST order (never argv order —
 * ops are sequenced deliberately). Any unknown key is a hard error naming close
 * matches, so a typo never silently runs nothing.
 */
export function selectManifestOps(
  manifest: ConversionManifest,
  opKeys: readonly string[]
): ConversionManifest {
  const known = manifest.ops.map((o) => o.opKey);
  const knownSet = new Set(known);
  const unknown = [...new Set(opKeys)].filter((k) => !knownSet.has(k));
  if (unknown.length > 0) {
    const lines = unknown.map((k) => {
      const close = closeMatches(k, known);
      return close.length
        ? `  '${k}' — did you mean: ${close.join(", ")}`
        : `  '${k}' — no close match`;
    });
    throw new Error(
      `--only: unknown opKey(s) not in manifest v${manifest.version}:\n${lines.join("\n")}`
    );
  }
  const wanted = new Set(opKeys);
  return { ...manifest, ops: manifest.ops.filter((o) => wanted.has(o.opKey)) };
}
