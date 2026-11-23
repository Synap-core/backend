-- 0453 — a playbook or skill can be shared with a space (`space_access` rows
-- of object type `playbook` / `skill`, written by the share door). As for
-- kinds (0448), the object id has no foreign key: deleting the object removes
-- its grants. Idempotent.

DROP TRIGGER IF EXISTS trg_playbooks_forget_space_access ON playbooks;
CREATE TRIGGER trg_playbooks_forget_space_access
  AFTER DELETE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION synap_space_access_forget_object('playbook');

DROP TRIGGER IF EXISTS trg_skills_forget_space_access ON skills;
CREATE TRIGGER trg_skills_forget_space_access
  AFTER DELETE ON skills
  FOR EACH ROW EXECUTE FUNCTION synap_space_access_forget_object('skill');
