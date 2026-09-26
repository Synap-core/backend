/**
 * The document read/edit floor, from its ONE home: `@synap/api`'s
 * `utils/document-edit-access.ts` (entry `@synap/api/document-access`).
 *
 * In source (tsc, vitest) this is a plain re-export. At BUILD time
 * `scripts/bundle-document-access.mjs` overwrites `dist/vendor/document-access.js`
 * with that entry bundled (its only runtime imports: `@synap/database`,
 * `drizzle-orm`, `@trpc/server`), so the deployed realtime image does not carry
 * `@synap/api` and its whole dependency tree (AI SDKs, isolated-vm, esbuild…) —
 * `@synap/api` is a devDependency. Same code, no copy.
 *
 * The honest long-term home is an access-layer package both api and realtime
 * depend on; extracting it waits on the access files' in-flight edits.
 */
// Importing the entry also REGISTERS the object-room floors
// (`utils/object-room-floors.ts`) on this process's `@synap/database`.
export { resolveDocumentRoomAccess } from "@synap/api/document-access";
