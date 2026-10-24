-- Step 1 (before the BASELINE run): remove the three covering indexes so the original queries run
-- on the schema's own indexes only. Run in MySQL Workbench against mco1_schema.
USE mco1_schema;
DROP INDEX idx_ft_date_cover ON fact_transaction;
DROP INDEX idx_ft_type_cover ON fact_transaction;
DROP INDEX idx_fl_cover      ON fact_loan;
ANALYZE TABLE fact_transaction, fact_loan;
-- If a DROP says the index does not exist, that is fine: it was already removed.
