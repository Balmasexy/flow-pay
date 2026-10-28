BEGIN;

-- Additive identity mapping. Existing users remain intact and unlinked until
-- their verified identity-provider subject is explicitly mapped.
ALTER TABLE fp_users
    ADD COLUMN IF NOT EXISTS auth_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS fp_users_auth_subject_unique
    ON fp_users(auth_subject)
    WHERE auth_subject IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('003_auth_subject')
ON CONFLICT (version) DO NOTHING;

COMMIT;
