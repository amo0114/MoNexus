-- Actor evidence must identify an active administrator at the time of each
-- legal lifecycle transition, even when SQL bypasses the application layer.
CREATE OR REPLACE FUNCTION value_policy_enforce_actor_role()
RETURNS trigger AS $$
DECLARE
  actor_id INTEGER;
  actor_role TEXT;
  actor_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    actor_id := NEW."createdByUserId";
  ELSIF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    actor_id := NEW."approvedByUserId";
  ELSIF OLD.status = 'approved' AND NEW.status = 'scheduled' THEN
    actor_id := NEW."scheduledByUserId";
  ELSIF OLD.status = 'scheduled' AND NEW.status = 'active' THEN
    actor_id := NEW."activatedByUserId";
  ELSIF OLD.status = 'active' AND NEW.status = 'retired' THEN
    actor_id := NEW."retiredByUserId";
  ELSE
    RETURN NEW;
  END IF;

  SELECT role, status INTO actor_role, actor_status
    FROM "User" WHERE id = actor_id;
  IF actor_role IS DISTINCT FROM 'admin' OR actor_status IS DISTINCT FROM '正常' THEN
    RAISE EXCEPTION 'value_policy_actor_must_be_active_admin'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER value_policy_actor_role_guard
BEFORE INSERT OR UPDATE ON "ValuePolicy"
FOR EACH ROW EXECUTE FUNCTION value_policy_enforce_actor_role();
