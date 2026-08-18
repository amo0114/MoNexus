-- Idempotency records are part of the immutable governance evidence. They
-- must not be rewritten or removed after the transaction commits.
CREATE OR REPLACE FUNCTION value_policy_governance_command_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'value_policy_governance_command_immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ValuePolicyGovernanceCommand_append_only"
BEFORE UPDATE OR DELETE ON "ValuePolicyGovernanceCommand"
FOR EACH ROW EXECUTE FUNCTION value_policy_governance_command_append_only();
