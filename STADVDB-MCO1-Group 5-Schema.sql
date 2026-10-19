-- =====================================================================
-- Berka Bank Data Warehouse - Group 5 Schema for MCO1
-- 
--
-- FACTS
--   fact_transaction  grain: one row per bank transaction
--   fact_loan         grain: one row per loan granted
--
-- DIMENSIONS 
--   dim_date              Year > Quarter > Month > Day   
--   dim_account_location  Region > District > Account   
--   dim_transaction_type  Type > Operation > K-symbol  
--   dim_loan_status       Contract Phase > Status       )
-- =====================================================================

DROP DATABASE IF EXISTS MCO1_SCHEMA;
CREATE DATABASE mco1_schema CHARACTER SET utf8mb4;
USE mco1_schema;

-- ---------------------------------------------------------------------
-- DIMENSIONS
-- ---------------------------------------------------------------------

-- Generated calendar 1993-01-01 .. 1998-12-31 (2,191 days)
CREATE TABLE dim_date (
    date_key      INT          NOT NULL,          -- YYYYMMDD
    full_date     DATE         NOT NULL,
    year_num      SMALLINT     NOT NULL,
    quarter_num   TINYINT      NOT NULL,
    month_num     TINYINT      NOT NULL,
    month_name    VARCHAR(10)  NOT NULL,
    year_month_label CHAR(7)   NOT NULL,        
    week_of_year  TINYINT      NOT NULL,
    day_of_month  TINYINT      NOT NULL,
    day_of_week   TINYINT      NOT NULL,         
    is_weekend    BOOLEAN      NOT NULL,
    PRIMARY KEY (date_key),
    UNIQUE KEY uq_dim_date_full_date (full_date)
) ENGINE=InnoDB;


CREATE TABLE dim_account_location (
    account_key     INT          NOT NULL AUTO_INCREMENT,   -- surrogate key
    account_id      INT          NOT NULL,                  
    frequency       VARCHAR(30)  NOT NULL,                  
    opening_date    DATE         NOT NULL,
    district_name   VARCHAR(50)  NOT NULL,
    region          VARCHAR(50)  NOT NULL,
    average_salary  INT,                                   
    PRIMARY KEY (account_key),
    UNIQUE KEY uq_dim_account_location_id (account_id),
    KEY idx_dim_account_location_region (region)
) ENGINE=InnoDB;

CREATE TABLE dim_transaction_type (
    txn_type_key  INT          NOT NULL AUTO_INCREMENT,
    txn_type      VARCHAR(20)  NOT NULL,     
    operation     VARCHAR(50)  NOT NULL,
    k_symbol      VARCHAR(50)  NOT NULL,
    PRIMARY KEY (txn_type_key),
    UNIQUE KEY uq_txn_type (txn_type, operation, k_symbol)
) ENGINE=InnoDB;

CREATE TABLE dim_loan_status (
    loan_status_key  INT          NOT NULL AUTO_INCREMENT,
    status_code      CHAR(1)      NOT NULL,
    status_desc      VARCHAR(60)  NOT NULL,
    contract_phase   VARCHAR(10)  NOT NULL,      -- Finished | Running
    payment_health   VARCHAR(10)  NOT NULL,      -- Good | 'Bad'
    PRIMARY KEY (loan_status_key),
    UNIQUE KEY uq_loan_status_code (status_code),
    CHECK (contract_phase IN ('Finished', 'Running')),
    CHECK (payment_health IN ('Good', 'Bad'))
) ENGINE=InnoDB;

-- 
-- FACT TABLES
-- 

CREATE TABLE fact_transaction (
    transaction_id  INT            NOT NULL,       -- source trans_id
    date_key        INT            NOT NULL,
    account_key     INT            NOT NULL,
    txn_type_key    INT            NOT NULL,
    amount          DECIMAL(18,2)  NOT NULL,
    signed_amount   DECIMAL(18,2)  NOT NULL,
    balance_after   DECIMAL(18,2)  NOT NULL,
    PRIMARY KEY (transaction_id),
    KEY idx_ft_date    (date_key),
    KEY idx_ft_account (account_key),
    KEY idx_ft_type    (txn_type_key),
    CONSTRAINT fk_ft_date    FOREIGN KEY (date_key)     REFERENCES dim_date (date_key),
    CONSTRAINT fk_ft_account FOREIGN KEY (account_key)  REFERENCES dim_account_location (account_key),
    CONSTRAINT fk_ft_type    FOREIGN KEY (txn_type_key) REFERENCES dim_transaction_type (txn_type_key),
    CONSTRAINT chk_ft_amount CHECK (amount >= 0)
) ENGINE=InnoDB;

CREATE TABLE fact_loan (
    loan_id          INT            NOT NULL,       -- source loan_id
    grant_date_key   INT            NOT NULL,
    account_key      INT            NOT NULL,
    loan_status_key  INT            NOT NULL,
    duration_months  SMALLINT       NOT NULL,       -- 12, 24, 36, 48, 60
    loan_amount      DECIMAL(18,2)  NOT NULL,
    monthly_payment  DECIMAL(18,2)  NOT NULL,
    PRIMARY KEY (loan_id),
    KEY idx_fl_date    (grant_date_key),
    KEY idx_fl_account (account_key),
    KEY idx_fl_status  (loan_status_key),
    CONSTRAINT fk_fl_date    FOREIGN KEY (grant_date_key)  REFERENCES dim_date (date_key),
    CONSTRAINT fk_fl_account FOREIGN KEY (account_key)     REFERENCES dim_account_location (account_key),
    CONSTRAINT fk_fl_status  FOREIGN KEY (loan_status_key) REFERENCES dim_loan_status (loan_status_key),
    CONSTRAINT chk_fl_amount CHECK (loan_amount > 0)
) ENGINE=InnoDB;

INSERT INTO dim_loan_status (status_code, status_desc, contract_phase, payment_health) VALUES
('A', 'Contract finished, no problems',    'Finished', 'Good'),
('B', 'Contract finished, loan not paid',  'Finished', 'Bad'),
('C', 'Contract running, OK so far',       'Running',  'Good'),
('D', 'Contract running, client in debt',  'Running',  'Bad');
