/**
 * Centralized access layer.
 *
 * One DECISION core (visibility rules + the AccessContext identity), reached
 * from TWO separate boundary entries:
 *   - operator/UI  → AccessContext.operator(trpcCtx) + scopedDb(...)
 *   - AI/Hub Proto → AccessContext.agent(hubCtx)     + scopedDb(...)
 *
 * Reads: scopedDb(access).findMany(table, {...}) auto-scopes via the registry.
 * The auth mechanisms (cookie vs API key) stay separate upstream; they only
 * converge into one AccessContext here.
 *
 * VOCABULARY — two unrelated meanings of "scope" live in this package, keep
 * them straight: an API-key *scope* (`hub-protocol.read/.write`, see
 * middleware/api-key-auth.ts) is a CAPABILITY CLAIM — what a key is allowed to
 * call. `scopedDb` / `ScopedDb` here is ROW VISIBILITY — which rows an identity
 * may see. A hub route checks the claim, then reads through scopedDb; they are
 * different axes one call apart.
 */

// Importing registry.ts runs its registration side effects.
import "./registry.js";

export { AccessContext, accessFor, type Actor } from "./context.js";
export {
  scopedDb,
  ScopedDb,
  ScopedMutation,
  type ScopedFindOptions,
} from "./scoped-db.js";
export {
  registerVisibility,
  getVisibilityEntry,
  isRegistered,
  visibilityPredicate,
  type VisibilityRule,
  type VisibilityEntry,
} from "./visibility.js";
