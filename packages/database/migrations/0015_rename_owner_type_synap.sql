-- Migration: 0015_rename_owner_type_synap
-- Rename agent ownerType value "provider" → "synap" for clarity.
-- "synap" = agents registered by the Synap Intelligence Service via agent sync.
-- The column is TEXT (no PG enum type was created), so a plain UPDATE suffices.

UPDATE agents SET owner_type = 'synap' WHERE owner_type = 'provider';
