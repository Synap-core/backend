// Claim mapper — Control Plane (Synap Cloud) OIDC provider.
//
// Maps the CP id_token claims onto the pod identity schema. The schema
// (identity.schema.json) is `additionalProperties: false` with exactly two
// traits — `email` (required) and `name` (optional) — so `traits` sets ONLY
// those. Mapping anything else into traits (e.g. `email_verified`) makes Kratos
// REJECT the identity on create.
//
// `metadata_public.synap_cp` carries the verified claims the pod's blocking
// registration hook needs (apps/api/src/webhooks/kratos-registration-gate.ts).
// It is the ONLY channel: Kratos v1.3.1's web_hook ctx has no raw claims, and
// `ctx.identity` is serialised without `credentials` and `metadata_admin`
// (identity/identity.go Identity.MarshalJSON). Claims come from the id_token
// Kratos verified against this pod's client_id (provider_generic_oidc.go,
// claims_source default "id_token"); custom claims live under
// `claims.raw_claims`. Strict `== true` so a missing or string claim is never
// read as proof. `pod_owner` is a SIGN-IN-TIME SNAPSHOT used once by the
// registration hook — never read it later as authority over ownership.
//
// Do NOT reintroduce the `local claims = { email: '' }` placeholder — it must read
// std.extVar('claims'), or every federated user gets blank traits.
local claims = std.extVar('claims');
local raw = if 'raw_claims' in claims && claims.raw_claims != null then claims.raw_claims else {};

{
  identity: {
    traits: {
      email: claims.email,
      [if 'name' in claims && claims.name != null && claims.name != '' then 'name' else null]: claims.name,
    },
    metadata_public: {
      synap_cp: {
        iss: claims.iss,
        sub: claims.sub,
        email_verified: 'email_verified' in raw && raw.email_verified == true,
        pod_owner: 'synap_pod_owner' in raw && raw.synap_pod_owner == true,
      },
    },
  },
}
