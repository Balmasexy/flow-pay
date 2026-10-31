BEGIN;

-- Configurable customer tier limits. NULL limits are explicitly unlimited.
CREATE TABLE IF NOT EXISTS fp_customer_tier_config (
  tier_key TEXT PRIMARY KEY CHECK (tier_key IN ('tier_1', 'tier_2', 'tier_3')),
  display_name TEXT NOT NULL,
  max_balance_minor BIGINT CHECK (max_balance_minor IS NULL OR max_balance_minor >= 0),
  daily_transaction_limit_minor BIGINT CHECK (daily_transaction_limit_minor IS NULL OR daily_transaction_limit_minor >= 0),
  per_transaction_limit_minor BIGINT CHECK (per_transaction_limit_minor IS NULL OR per_transaction_limit_minor >= 0),
  requires_bvn BOOLEAN NOT NULL DEFAULT TRUE,
  requires_nin BOOLEAN NOT NULL DEFAULT FALSE,
  requires_proof_of_address BOOLEAN NOT NULL DEFAULT FALSE,
  automatic_upgrade BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES fp_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO fp_customer_tier_config
  (tier_key, display_name, max_balance_minor, daily_transaction_limit_minor,
   per_transaction_limit_minor, requires_bvn, requires_nin, requires_proof_of_address)
VALUES
  ('tier_1', 'Basic', 50000000, 10000000, NULL, TRUE, FALSE, FALSE),
  ('tier_2', 'Enhanced', 500000000, 50000000, NULL, TRUE, TRUE, FALSE),
  ('tier_3', 'Fully Verified', NULL, NULL, 100000000, TRUE, TRUE, TRUE)
ON CONFLICT (tier_key) DO NOTHING;

-- Staff roles are separate from the legacy fp_users.role field. This preserves
-- existing customer/admin records and avoids silently granting staff access.
CREATE TABLE IF NOT EXISTS fp_role_definitions (
  role_code TEXT PRIMARY KEY CHECK (role_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_assignable BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO fp_role_definitions (role_code, display_name, description, is_assignable) VALUES
  ('system_administrator', 'System Administrator', 'Technical operations and service configuration; no automatic financial approval rights.', TRUE),
  ('compliance_kyc_officer', 'Compliance / KYC Officer', 'Reviews identity and proof-of-address verification cases.', TRUE),
  ('risk_fraud_analyst', 'Risk & Fraud Analyst', 'Investigates suspicious activity and recommends risk controls.', TRUE),
  ('finance_manager', 'Finance Manager', 'Reviews finance reports, settlement and reconciliation.', TRUE),
  ('operations_officer', 'Operations Officer', 'Monitors transaction operations and escalates exceptions.', TRUE),
  ('customer_support', 'Customer Support', 'Handles customer enquiries with restricted profile access.', TRUE),
  ('internal_auditor', 'Internal Auditor', 'Read-only review of approved audit and financial records.', TRUE),
  ('customer', 'Customer', 'Standard customer access to the customer's own account.', TRUE)
ON CONFLICT (role_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS fp_user_role_assignments (
  user_id UUID PRIMARY KEY REFERENCES fp_users(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL REFERENCES fp_role_definitions(role_code),
  assigned_by UUID NOT NULL REFERENCES fp_users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_user_role_assignments_role_idx
  ON fp_user_role_assignments(role_code, assigned_at DESC);

CREATE TABLE IF NOT EXISTS fp_admin_config_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES fp_users(id),
  target_user_id UUID REFERENCES fp_users(id),
  action TEXT NOT NULL CHECK (action IN ('tier_config_updated', 'staff_role_assigned', 'staff_role_removed')),
  entity_key TEXT NOT NULL,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_admin_config_audit_created_idx
  ON fp_admin_config_audit_events(created_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('009_customer_tiers_and_staff_roles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
