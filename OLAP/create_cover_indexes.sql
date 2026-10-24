-- Step 3 (before the OPTIMIZED run): recreate the three covering indexes.
USE mco1_schema;
CREATE INDEX idx_ft_date_cover ON fact_transaction
    (date_key, txn_type_key, account_key, amount, signed_amount);
CREATE INDEX idx_ft_type_cover ON fact_transaction
    (txn_type_key, date_key, account_key, amount, signed_amount);
CREATE INDEX idx_fl_cover ON fact_loan
    (grant_date_key, loan_status_key, duration_months, account_key, loan_amount, monthly_payment);
ANALYZE TABLE fact_transaction, fact_loan;
-- Check: SHOW INDEX FROM fact_transaction;  (the two *_cover indexes must be listed)
