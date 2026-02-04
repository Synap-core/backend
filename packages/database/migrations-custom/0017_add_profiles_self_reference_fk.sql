-- Add self-reference foreign key for profiles.parent_profile_id
-- This enables profile inheritance (e.g., "webinar" extends "event")

ALTER TABLE profiles
  ADD CONSTRAINT profiles_parent_profile_id_fkey
  FOREIGN KEY (parent_profile_id)
  REFERENCES profiles(id)
  ON DELETE SET NULL;
