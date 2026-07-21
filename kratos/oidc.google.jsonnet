// Claim mapper — Google OIDC provider.
//
// Reads the real id_token claims via std.extVar('claims'). The pod identity
// schema is `additionalProperties: false` (traits: email required, name optional),
// so this maps ONLY email + name — mapping email_verified here would make Kratos
// reject the identity on create.
local claims = std.extVar('claims');

{
  identity: {
    traits: {
      email: claims.email,
      [if 'name' in claims && claims.name != null && claims.name != '' then 'name' else null]: claims.name,
    },
  },
}
