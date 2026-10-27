BEGIN;

CREATE OR REPLACE FUNCTION fp_validate_posted_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_id UUID;
    tx_status TEXT;
    entry_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'fp_ledger_transactions' THEN
        target_id := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        target_id := OLD.transaction_id;
    ELSE
        target_id := NEW.transaction_id;
    END IF;

    SELECT status
      INTO tx_status
      FROM fp_ledger_transactions
     WHERE id = target_id;

    IF NOT FOUND OR tx_status NOT IN ('posted', 'reversed') THEN
        RETURN NULL;
    END IF;

    SELECT COUNT(*)
      INTO entry_count
      FROM fp_ledger_entries
     WHERE transaction_id = target_id;

    IF entry_count < 2 THEN
        RAISE EXCEPTION
            'Posted or reversed transaction % requires at least two entries',
            target_id;
    END IF;

    IF EXISTS (
        SELECT currency
          FROM fp_ledger_entries
         WHERE transaction_id = target_id
         GROUP BY currency
        HAVING SUM(amount_minor) <> 0
    ) THEN
        RAISE EXCEPTION
            'Transaction % is not balanced per currency',
            target_id;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM fp_ledger_entries e
          JOIN fp_accounts a ON a.id = e.account_id
         WHERE e.transaction_id = target_id
           AND e.currency <> a.currency
    ) THEN
        RAISE EXCEPTION
            'Ledger entry currency does not match its account currency';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION fp_protect_transaction_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION
                'New ledger transactions must start as pending';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'pending'
       AND NEW.status IN ('posted', 'failed') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'Invalid ledger transaction status transition: % -> %',
        OLD.status, NEW.status;
END;
$$;

CREATE OR REPLACE FUNCTION fp_protect_posted_entries()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_id UUID;
    tx_status TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.transaction_id <> OLD.transaction_id THEN
            RAISE EXCEPTION
                'Moving ledger entries between transactions is prohibited';
        END IF;
        target_id := OLD.transaction_id;
    ELSIF TG_OP = 'DELETE' THEN
        target_id := OLD.transaction_id;
    ELSE
        target_id := NEW.transaction_id;
    END IF;

    SELECT status
      INTO tx_status
      FROM fp_ledger_transactions
     WHERE id = target_id;

    IF tx_status IN ('posted', 'reversed') THEN
        RAISE EXCEPTION
            'Entries of posted or reversed transactions are immutable';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER fp_validate_transaction_posting
AFTER INSERT OR UPDATE ON fp_ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fp_validate_posted_transaction();

CREATE CONSTRAINT TRIGGER fp_validate_entry_balance
AFTER INSERT OR UPDATE OR DELETE ON fp_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fp_validate_posted_transaction();

CREATE TRIGGER fp_protect_ledger_transaction_status
BEFORE INSERT OR UPDATE OF status ON fp_ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION fp_protect_transaction_status();

CREATE TRIGGER fp_protect_posted_ledger_entries
BEFORE INSERT OR UPDATE OR DELETE ON fp_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fp_protect_posted_entries();

INSERT INTO schema_migrations (version)
VALUES ('002_ledger_invariants')
ON CONFLICT (version) DO NOTHING;

COMMIT;
