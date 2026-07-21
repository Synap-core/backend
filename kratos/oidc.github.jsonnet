// Claim mapper — GitHub OIDC provider.
//
// Reads the real id_token claims via std.extVar('claims'). GitHub may omit a
// public email, so fall back to `<login>@github.local`, and to the login when no
// name is present. Maps ONLY email + name (the identity schema is
// `additionalProperties: false`).
local claims = std.extVar('claims');
local login = if 'login' in claims && claims.login != null then claims.login else 'user';

{
  identity: {
    traits: {
      email: if 'email' in claims && claims.email != null && claims.email != '' then claims.email else login + '@github.local',
      name: if 'name' in claims && claims.name != null && claims.name != '' then claims.name else login,
    },
  },
}
