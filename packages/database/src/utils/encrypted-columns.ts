/**
 * Every pod cell that holds a field-encrypted secret — the ONE list that the
 * encrypt/decrypt doors (`FieldRef.column` is typed from it), the audit and
 * the re-encrypt sweeper (`field-crypto-sweep.ts`, CLI
 * `dist/scripts/field-crypto.js`) all read. A value encrypted into a cell
 * missing here can never be audited or rotated, so
 * `field-crypto.registry.tripwire.test.ts` fails on any call site naming a
 * column that is not listed (and on a listed column nobody encrypts), and
 * `field-crypto-sweep.pglite.test.ts` checks every entry against the real
 * migrated schema.
 *
 * `column` is the cell's NAME (it goes into the AAD:
 * `synap/pod/<table>.<column>/<rowId>`). For a plain text column it is the SQL
 * column; for a value nested in a JSONB blob it names the field, and
 * `storage.jsonColumn` + `storage.path` say where it lives.
 *
 * `legacy` is the format the cell held before the keyring (`SYNAP_FIELD_KEYS`)
 * — what is written while the keyring is unset, and what the doors still read:
 *   - `service-key`  JSON `{e, i|iv, t}`, AES-256-GCM under
 *                    sha256(SYNAP_SERVICE_ENCRYPTION_KEY), no AAD;
 *   - `server-vault` base64 ciphertext in the column + `iv` + `auth_tag`
 *                    columns, AES-256-GCM under the hex VAULT_SERVER_KEY, no AAD;
 *   - `plaintext`    stored in clear.
 */

/** Audit label for values in a cell's pre-keyring encrypted format. */
export const LEGACY_KID = "legacy";
/** Audit label for values that are not encrypted at all. */
export const PLAINTEXT_KID = "plaintext";
/** Labels a SYNAP_FIELD_KEYS kid may not use (they would blur the audit). */
export const RESERVED_KIDS: readonly string[] = [LEGACY_KID, PLAINTEXT_KID];

export type LegacyFormat = "service-key" | "server-vault" | "plaintext";

export const ENCRYPTED_COLUMNS = [
  {
    // The pod's credential for each registered intelligence service.
    table: "intelligence_services",
    column: "api_key",
    idColumn: "id",
    legacy: "service-key",
    storage: { kind: "text" },
  },
  {
    table: "ai_providers",
    column: "encrypted_api_key",
    idColumn: "id",
    legacy: "service-key",
    storage: { kind: "text" },
  },
  {
    table: "ai_provider_credentials",
    column: "encrypted_api_key",
    idColumn: "id",
    legacy: "service-key",
    storage: { kind: "text" },
  },
  {
    // Server-mode vault secrets only: `client` rows are encrypted by the
    // user's own key and are not this door's to read or rotate. An envelope
    // lives in `encrypted_data`; `iv`/`auth_tag` are then empty strings.
    table: "secrets",
    column: "encrypted_data",
    idColumn: "id",
    legacy: "server-vault",
    storage: {
      kind: "vault-blob",
      ivColumn: "iv",
      tagColumn: "auth_tag",
      filter: { column: "encryption_mode", equals: "server" },
    },
  },
  {
    // The shared token a sync peer presents and that we present to it.
    table: "sync_peers",
    column: "auth_token",
    idColumn: "id",
    legacy: "plaintext",
    storage: { kind: "text" },
  },
  {
    // The CP-pushed OIDC client secret (`pod_settings.settings`
    // `.federationOidcClient.clientSecret`).
    table: "pod_settings",
    column: "federation_oidc_client_secret",
    idColumn: "id",
    legacy: "plaintext",
    storage: {
      kind: "json",
      jsonColumn: "settings",
      path: ["federationOidcClient", "clientSecret"],
    },
  },
] as const;

export type EncryptedColumnEntry = (typeof ENCRYPTED_COLUMNS)[number];

/** `"<table>.<column>"` of a registered cell (distributes per entry). */
type ColumnName<E> = E extends {
  table: infer T extends string;
  column: infer C extends string;
}
  ? `${T}.${C}`
  : never;

export type EncryptedColumn = ColumnName<EncryptedColumnEntry>;

/** Cells stored as one string (text column or JSON field). */
export type TextColumn = ColumnName<
  Exclude<EncryptedColumnEntry, { storage: { kind: "vault-blob" } }>
>;
/** Cells stored as a server-vault blob (`encrypted_data` + `iv` + `auth_tag`). */
export type BlobColumn = ColumnName<
  Extract<EncryptedColumnEntry, { storage: { kind: "vault-blob" } }>
>;

export function encryptedColumnName(
  entry: EncryptedColumnEntry
): EncryptedColumn {
  return `${entry.table}.${entry.column}` as EncryptedColumn;
}

/** The registry entry of a cell name; throws on an unregistered name. */
export function encryptedColumnEntry(
  column: EncryptedColumn
): EncryptedColumnEntry {
  const entry = ENCRYPTED_COLUMNS.find(
    (e) => encryptedColumnName(e) === column
  );
  if (!entry) {
    throw new Error(`"${column}" is not in ENCRYPTED_COLUMNS`);
  }
  return entry;
}
