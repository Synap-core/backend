-- Unified Relations: Bridge entity_id properties with the relations graph.
--
-- property_defs.relation_def_id → when an entity_id property is set,
--   auto-create a relation row of this type.
-- property_defs.target_profile_id → optional constraint on which profile
--   the entity_id should point to (enables ERD edges in data structure viewer).
-- profile_relations.property_def_id → marks this profile relation as
--   property-backed (setting the property auto-creates the relation).

ALTER TABLE property_defs
  ADD COLUMN IF NOT EXISTS relation_def_id uuid REFERENCES relation_defs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE profile_relations
  ADD COLUMN IF NOT EXISTS property_def_id uuid REFERENCES property_defs(id) ON DELETE SET NULL;

-- Index for fast lookup: "which property_defs have auto-sync enabled?"
CREATE INDEX IF NOT EXISTS property_defs_relation_def_id_idx
  ON property_defs (relation_def_id) WHERE relation_def_id IS NOT NULL;
