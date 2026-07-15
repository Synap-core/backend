-- Application admission is a property of an exact issuer + client
-- connection, never an issuer-wide switch. Keeping it issuer-wide would make
-- approving one browser app change unrelated legacy federation flows.

ALTER TABLE "trusted_issuers"
  DROP CONSTRAINT IF EXISTS "trusted_issuers_application_admission_mode_check";

ALTER TABLE "trusted_issuers"
  DROP COLUMN IF EXISTS "application_admission_mode";
