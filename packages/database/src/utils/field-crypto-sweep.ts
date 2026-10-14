/**
 * Audit + re-encrypt for every cell in `ENCRYPTED_COLUMNS` (mirrors the
 * control plane's `field-crypto-sweep.ts`, over the pod's three storage kinds:
 * a text column, a server-vault blob, a field inside a JSONB blob).
 *
 * - `auditEncryptedColumns` is SELECT-only and returns COUNTS (per kid, plus
 *   `legacy` and `plaintext`). It never reads a value into the process.
 * - `reencryptColumns` rewrites every value not under the current kid, in
 *   batches, with a compare-and-set update (`WHERE id = … AND value = <old>`),
 *   so a concurrent write is never overwritten. Failures are counted by error
 *   code with the row id — never a value.
 *
 * CLI: `node dist/scripts/field-crypto.js audit|reencrypt` in the backend
 * container (packages/api/src/scripts/field-crypto-cli.ts). Runbook:
 * deploy/runbooks/rotate-field-key.md.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  ENCRYPTED_COLUMNS,
  encryptedColumnName,
  LEGACY_KID,
  PLAINTEXT_KID,
  type BlobColumn,
  type EncryptedColumn,
  type EncryptedColumnEntry,
  type TextColumn,
} from "./encrypted-columns.js";
import { FieldCryptoError, type PodFieldCrypto } from "./field-crypto.js";

export type Row = Record<string, unknown>;
export type Exec = (query: SQL) => Promise<Row[]>;

/** Adapt a drizzle client (postgres-js returns rows, PGlite `{rows}`). */
export function executorFor(db: {
  execute: (query: SQL) => Promise<unknown>;
}): Exec {
  return async (query) => {
    const res = await db.execute(query);
    if (Array.isArray(res)) return res as Row[];
    return ((res as { rows?: Row[] }).rows ?? []) as Row[];
  };
}

/** An envelope of a version this build cannot read. */
export const UNSUPPORTED_KID = "unsupported-envelope";

export interface ColumnAudit {
  column: EncryptedColumn;
  /** Non-null values. */
  total: number;
  /** Count per kid, plus `legacy`, `plaintext`, `unsupported-envelope`. */
  byKid: Record<string, number>;
}

/** A constant label as a SQL literal (constants only — never caller input). */
function label(value: string): SQL {
  if (!/^[a-z-]+$/.test(value)) throw new Error("label must be [a-z-]");
  return sql.raw(`'${value}'::text`);
}

/** The SQL expression that reads the cell's stored string. */
function valueExpr(entry: EncryptedColumnEntry): SQL {
  if (entry.storage.kind === "json") {
    const path = `{${entry.storage.path.join(",")}}`;
    return sql`(${sql.identifier(entry.storage.jsonColumn)} #>> ${path}::text[])`;
  }
  return sql`${sql.identifier(entry.column)}`;
}

/** Extra row filter (server-mode vault rows only). */
function rowFilter(entry: EncryptedColumnEntry): SQL {
  if (entry.storage.kind === "vault-blob") {
    const f = entry.storage.filter;
    return sql`AND ${sql.identifier(f.column)} = ${f.equals}`;
  }
  return sql``;
}

/** How a non-envelope value of this cell is labelled. */
function nonEnvelopeLabel(entry: EncryptedColumnEntry, value: SQL): SQL {
  if (entry.legacy === "server-vault") return label(LEGACY_KID);
  if (entry.legacy === "service-key") {
    return sql`CASE WHEN left(${value}, 1) = '{' THEN ${label(LEGACY_KID)} ELSE ${label(PLAINTEXT_KID)} END`;
  }
  return label(PLAINTEXT_KID);
}

export async function auditEncryptedColumns(
  exec: Exec,
  columns: readonly EncryptedColumnEntry[] = ENCRYPTED_COLUMNS
): Promise<ColumnAudit[]> {
  const out: ColumnAudit[] = [];
  for (const entry of columns) {
    const v = valueExpr(entry);
    const rows = await exec(sql`
      SELECT
        CASE
          WHEN left(${v}, 7) = 'senc:1:' THEN split_part(${v}, ':', 3)
          WHEN left(${v}, 5) = 'senc:' THEN ${label(UNSUPPORTED_KID)}
          ELSE ${nonEnvelopeLabel(entry, v)}
        END AS kid,
        count(*)::int AS n
      FROM ${sql.identifier(entry.table)}
      WHERE ${v} IS NOT NULL ${rowFilter(entry)}
      GROUP BY 1
      ORDER BY 1
    `);
    const byKid: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      byKid[String(r.kid)] = n;
      total += n;
    }
    out.push({ column: encryptedColumnName(entry), total, byKid });
  }
  return out;
}

/** Values the current ring would still have to rewrite. */
export function staleCount(audit: ColumnAudit, currentKid: string): number {
  return audit.total - (audit.byKid[currentKid] ?? 0);
}

export interface ReencryptResult {
  column: EncryptedColumn;
  scanned: number;
  rewritten: number;
  /** The row changed between read and write (left for the next run). */
  skippedConcurrent: number;
  failed: Array<{ rowId: string; code: string }>;
}

export interface ReencryptOptions {
  batchSize?: number;
  /** Decrypt and count, write nothing. */
  dryRun?: boolean;
  columns?: readonly EncryptedColumnEntry[];
}

/** Rewrite one row's cell under the current key (compare-and-set). */
function writeBack(
  entry: EncryptedColumnEntry,
  rowId: string,
  oldValue: string,
  next: string
): SQL {
  const table = sql.identifier(entry.table);
  const id = sql.identifier(entry.idColumn);
  if (entry.storage.kind === "json") {
    const json = sql.identifier(entry.storage.jsonColumn);
    const path = `{${entry.storage.path.join(",")}}`;
    return sql`
      UPDATE ${table}
      SET ${json} = jsonb_set(${json}, ${path}::text[], to_jsonb(${next}::text), false)
      WHERE ${id}::text = ${rowId} AND ${valueExpr(entry)} = ${oldValue}
      RETURNING ${id} AS id
    `;
  }
  const col = sql.identifier(entry.column);
  if (entry.storage.kind === "vault-blob") {
    return sql`
      UPDATE ${table}
      SET ${col} = ${next},
          ${sql.identifier(entry.storage.ivColumn)} = '',
          ${sql.identifier(entry.storage.tagColumn)} = ''
      WHERE ${id}::text = ${rowId} AND ${col} = ${oldValue}
      RETURNING ${id} AS id
    `;
  }
  return sql`
    UPDATE ${table} SET ${col} = ${next}
    WHERE ${id}::text = ${rowId} AND ${col} = ${oldValue}
    RETURNING ${id} AS id
  `;
}

export async function reencryptColumns(
  exec: Exec,
  crypto: PodFieldCrypto,
  opts: ReencryptOptions = {}
): Promise<ReencryptResult[]> {
  const currentKid = crypto.currentKid;
  if (!currentKid) {
    throw new FieldCryptoError(
      "INVALID_KEYRING",
      "SYNAP_FIELD_KEYS is not set — there is no current key to re-encrypt to"
    );
  }
  const batchSize = opts.batchSize ?? 100;
  const prefix = `senc:1:${currentKid}:`;
  const results: ReencryptResult[] = [];

  for (const entry of opts.columns ?? ENCRYPTED_COLUMNS) {
    const column = encryptedColumnName(entry);
    const table = sql.identifier(entry.table);
    const id = sql.identifier(entry.idColumn);
    const v = valueExpr(entry);
    const blob = entry.storage.kind === "vault-blob" ? entry.storage : null;
    const extra = blob
      ? sql`, ${sql.identifier(blob.ivColumn)} AS iv, ${sql.identifier(blob.tagColumn)} AS tag`
      : sql``;
    const result: ReencryptResult = {
      column,
      scanned: 0,
      rewritten: 0,
      skippedConcurrent: 0,
      failed: [],
    };
    let cursor = "";
    for (;;) {
      const rows = await exec(sql`
        SELECT ${id}::text AS id, ${v} AS value ${extra}
        FROM ${table}
        WHERE ${v} IS NOT NULL ${rowFilter(entry)}
          AND left(${v}, ${prefix.length}) <> ${prefix}
          AND ${id}::text > ${cursor}
        ORDER BY ${id}::text
        LIMIT ${batchSize}
      `);
      if (rows.length === 0) break;
      for (const r of rows) {
        const rowId = String(r.id);
        const value = String(r.value);
        cursor = rowId;
        result.scanned++;
        let next: string;
        try {
          if (blob) {
            const ref = { column: column as BlobColumn, rowId };
            const plaintext = crypto.decryptBlob(
              {
                encryptedData: value,
                iv: String(r.iv ?? ""),
                authTag: String(r.tag ?? ""),
              },
              ref
            );
            next = crypto.encryptBlob(plaintext, ref).encryptedData;
          } else {
            const ref = { column: column as TextColumn, rowId };
            next = crypto.encryptField(crypto.resolveField(value, ref), ref);
          }
        } catch (err) {
          result.failed.push({
            rowId,
            code: err instanceof FieldCryptoError ? err.code : "ERROR",
          });
          continue;
        }
        if (opts.dryRun) continue;
        const updated = await exec(writeBack(entry, rowId, value, next));
        if (updated.length === 1) result.rewritten++;
        else result.skippedConcurrent++;
      }
      if (rows.length < batchSize) break;
    }
    results.push(result);
  }
  return results;
}
