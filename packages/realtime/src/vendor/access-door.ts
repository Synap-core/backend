/**
 * THE access door, from its ONE home: `@synap/api`'s `access/door.ts` (entry
 * `@synap/api/access-door`). Vendored exactly as `./document-access.ts`: a
 * plain re-export in source, overwritten at BUILD time by
 * `scripts/bundle-document-access.mjs` with that entry bundled, so the
 * deployed image does not carry `@synap/api`.
 */
export {
  canJoinRoom,
  canRead,
  principalFromKey,
  userPrincipal,
  type Principal,
} from "@synap/api/access-door";
