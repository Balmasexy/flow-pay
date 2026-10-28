BEGIN;

-- Additive identity link: existing customers and financial records are preserved.
-- Populate auth_subject only after a verified identity-to-customer mapping is reviewed.
ALTER TABLE fp_users
    ADD COLUMN IF NOT EXISTS auth_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS fp_users_auth_subject_unique
    ON fp_users(auth_subject)
    WHERE auth_subject IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('003_auth_subject')
ON CONFLICT (version) DO NOTHING;

COMMIT;
