/**
 * Terminal rendering for the workspace-identity diagnostic.
 *
 * Kept beside the matcher (and free of any `@synap/database` import) so the
 * report can be produced and inspected without a database — the diagnostic is
 * a READ that PRINTS, and nothing about formatting it should require a live
 * pod. `BackfillResult` structurally satisfies `IdentityReportInput`.
 */

import type { IdentityMatch } from "./fingerprint.js";

export interface IdentityReportInput {
  matches: IdentityMatch[];
  alreadyIdentified: Array<{ id: string; name: string; identity: string }>;
  stamped: Array<{ id: string; name: string; slug: string; subtype?: string }>;
  failed: number;
  didStamp: boolean;
}

export function formatIdentityReport(result: IdentityReportInput): string {
  const lines: string[] = [];
  lines.push(
    `mode=${result.didStamp ? "STAMP" : "REPORT (read-only)"}  orphans=${result.matches.length}  alreadyIdentified=${result.alreadyIdentified.length}`
  );
  lines.push("");

  for (const id of result.alreadyIdentified) {
    lines.push(`  [identified] ${id.name} (${id.id}) → ${id.identity}`);
  }
  if (result.alreadyIdentified.length > 0) lines.push("");

  for (const m of result.matches) {
    lines.push(
      `${m.verdict.padEnd(11)} ${m.workspaceName} (${m.workspaceId})  entities=${m.entityCount ?? 0}`
    );
    lines.push(`            ${m.reason}`);
    for (const c of m.candidates.slice(0, 5)) {
      lines.push(
        `            ${c.strong ? "→" : " "} ${c.slug.padEnd(22)} coverage=${c.coverage.toFixed(2)} (${c.matched.length}/${c.templateProfileCount})` +
          ` distinctive=${c.distinctiveMatched.length} name=${c.nameMatch ? "Y" : "n"} sourceRoles=${c.sourceRolesMatch ? "Y" : "n"}` +
          (c.distinctiveMatched.length > 0
            ? `  [${c.distinctiveMatched.slice(0, 4).join(", ")}]`
            : "")
      );
    }
    lines.push("");
  }

  if (result.didStamp) {
    lines.push(`stamped: ${result.stamped.length}, failed: ${result.failed}`);
    for (const s of result.stamped) {
      lines.push(
        `  ✓ ${s.name} → packageSlug=${s.slug} workspaceSubtype=${s.subtype ?? "(none)"}`
      );
    }
  } else {
    const n = result.matches.filter((m) => m.verdict === "UNAMBIGUOUS").length;
    lines.push(
      `${n} workspace(s) would be stamped. Re-run with --stamp to write them.`
    );
  }

  return lines.join("\n");
}
