BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version       VARCHAR(100) PRIMARY KEY,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fp_users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT UNIQUE,
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'suspended', 'closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (email IS NULL OR length(trim(email)) > 0)
);

CREATE TABLE IF NOT EXISTS fp_accounts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID REFERENCES fp_users(id),
    account_type   TEXT NOT NULL
                   CHECK (account_type IN ('customer', 'system')),
    currency       CHAR(3) NOT NULL
                   CHECK (currency ~ '^[A-Z]{3}$'),
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'frozen', 'closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fp_accounts_user_idx
    ON fp_accounts(user_id);

CREATE TABLE IF NOT EXISTS fp_ledger_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    transaction_type TEXT NOT NULL
                    CHECK (length(trim(transaction_type)) > 0),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'posted', 'reversed', 'failed')),
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    posted_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS fp_ledger_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID NOT NULL
                    REFERENCES fp_ledger_transactions(id),
    account_id      UUID NOT NULL REFERENCES fp_accounts(id),
    amount_minor    BIGINT NOT NULL CHECK (amount_minor <> 0),
    currency        CHAR(3) NOT NULL
                    CHECK (currency ~ '^[A-Z]{3}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fp_ledger_entries_account_idx
    ON fp_ledger_entries(account_id, created_at);

CREATE INDEX IF NOT EXISTS fp_ledger_entries_transaction_idx
    ON fp_ledger_entries(transaction_id);

CREATE TABLE IF NOT EXISTS fp_payment_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider         TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'pending'
                     CHECK (processing_status IN ('pending', 'processed', 'failed')),
    received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_event_id)
);

INSERT INTO schema_migrations (version)
VALUES ('001_core')
ON CONFLICT (version) DO NOTHING;

COMMIT;
