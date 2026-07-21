// Claim mapper — Control Plane (Synap Cloud) OIDC provider.
//
// Maps the CP id_token claims onto the pod identity schema. The schema
// (identity.schema.json) is `additionalProperties: false` with exactly two
// traits — `email` (required) and `name` (optional) — so this mapper sets ONLY
// those. Mapping anything else (e.g. `email_verified`) makes Kratos REJECT the
// identity on create.
//
// SECURITY: create-or-link trusts the CP's `email`. The CP only issues id_tokens
// for verified emails in production (`requireEmailVerification`), so the
// verification gate is enforced upstream at the issuer, not here.
//
// Do NOT reintroduce the `local claims = { email: '' }` placeholder — it must read
// std.extVar('claims'), or every federated user gets blank traits.
local claims = std.extVar('claims');

{
  identity: {
    traits: {
      email: claims.email,
      [if 'name' in claims && claims.name != null && claims.name != '' then 'name' else null]: claims.name,
    },
  },
}
