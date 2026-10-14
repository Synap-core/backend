/**
 * CLI: field encryption at rest, inside the backend container.
 *
 *   node dist/scripts/field-crypto.js audit
 *     Counts per kid / legacy / plaintext for every ENCRYPTED_COLUMNS cell
 *     (SELECT-only; prints counts, never values). Exit 0 when every value is
 *     under the current SYNAP_FIELD_KEYS kid, 2 otherwise.
 *
 *   node dist/scripts/field-crypto.js reencrypt [--dry-run] [--batch=N]
 *     Rewrites every value not under the current kid (batched,
 *     compare-and-set). Exit 0 when every row was rewritten, 1 on any failure
 *     (each failure printed as `failed row <id>: <code>`, never a value).
 *
 *   node dist/scripts/field-crypto.js federation-oidc-client
 *     For the installer's Kratos render ONLY: prints the CP-pushed OIDC client
 *     as `clientId|clientSecret|issuer` (the line the installer's psql read
 *     used to produce), the secret decrypted. Prints nothing (exit 0) when
 *     the pod has no federation client. It prints a SECRET: never run it by
 *     hand or in a transcript.
 *
 * Runbook: deploy/runbooks/rotate-field-key.md.
 */

import "dotenv/config";
import {
  auditEncryptedColumns,
  executorFor,
  getDb,
  podFieldCrypto,
  podSettings,
  reencryptColumns,
  resolveField,
  staleCount,
} from "@synap/database";

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  const [command, ...flags] = process.argv.slice(2);
  const db = await getDb();
  const exec = executorFor(db);
  const crypto = podFieldCrypto();
  const current = crypto.currentKid;

  if (command === "audit") {
    const audit = await auditEncryptedColumns(exec);
    let stale = 0;
    for (const a of audit) {
      const left = current ? staleCount(a, current) : a.total;
      stale += left;
      out(
        `${a.column}: total=${a.total} ${Object.entries(a.byKid)
          .map(([kid, n]) => `${kid}=${n}`)
          .join(" ")}${current ? ` not-current=${left}` : ""}`
      );
    }
    out(
      current
        ? `current kid: ${current}; values not under it: ${stale}`
        : "SYNAP_FIELD_KEYS is not set: every value is in its pre-keyring format"
    );
    return stale === 0 ? 0 : 2;
  }

  if (command === "reencrypt") {
    const dryRun = flags.includes("--dry-run");
    const batchFlag = flags.find((f) => f.startsWith("--batch="));
    const batchSize = batchFlag ? Number(batchFlag.slice(8)) : undefined;
    const results = await reencryptColumns(exec, crypto, { dryRun, batchSize });
    let failed = 0;
    for (const r of results) {
      failed += r.failed.length;
      out(
        `${r.column}: scanned=${r.scanned} rewritten=${r.rewritten} skipped-concurrent=${r.skippedConcurrent} failed=${r.failed.length}${dryRun ? " (dry run)" : ""}`
      );
      for (const f of r.failed) out(`  failed row ${f.rowId}: ${f.code}`);
    }
    return failed === 0 ? 0 : 1;
  }

  if (command === "federation-oidc-client") {
    const [row] = await db
      .select({ id: podSettings.id, settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    const client = row?.settings?.federationOidcClient;
    if (!row || !client?.clientId || !client.clientSecret || !client.issuer) {
      return 0;
    }
    const secret = resolveField(client.clientSecret, {
      column: "pod_settings.federation_oidc_client_secret",
      rowId: row.id,
    });
    out(`${client.clientId}|${secret}|${client.issuer}`);
    return 0;
  }

  console.error(
    "usage: field-crypto audit | reencrypt [--dry-run] [--batch=N] | federation-oidc-client"
  );
  return 64;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const e = err as { name?: string; code?: string; message?: string };
    console.error(
      `field-crypto failed: ${e?.code ?? e?.name ?? "Error"}${e?.message ? `: ${e.message}` : ""}`
    );
    process.exit(1);
  });
