# Group 5 MCO1 OLAP Dashboard

Web dashboard over the bank data warehouse (MySQL star schema: `fact_transaction`, `fact_loan`).

- `public/` static page (vanilla JS, Apache ECharts): KPI tiles, filters and one card per OLAP report
- `api/` serverless endpoints, one parameterized report each (`r1-cash-flow` … `r7-region-profile`, plus `regions` and `health`)
- `lib/db.js` MySQL pool (config from environment variables), `lib/report.js` shared endpoint plumbing,
  `lib/demo-data.js` sample data used when no database is configured
- `scripts/check-endpoints.js` compares the endpoints with `olap_results/*.csv` (`npm run check`)

## Build the warehouse and run the OLAP reports

### Prerequisites

- MySQL 8.0.12 or newer, running locally
- Python 3
- The Python MySQL connector:

```bat
python -m pip install mysql-connector-python
```

### Import the source data

The included `MCO1 - Dataset financedataclean.sql` dump creates and selects the
`financedata` database. From **Command Prompt** at the repository root, import it with:

```bat
mysql -u root -p < "MCO1 - Dataset financedataclean.sql"
```

If you are importing a different dump without `CREATE DATABASE` and `USE` statements,
create the source database first and import into it:

```bat
mysql -u root -p -e "CREATE DATABASE financedata"
mysql -u root -p financedata < "your-source-dump.sql"
```

Check the source row counts:

```bat
mysql -u root -p financedata -e "SELECT (SELECT COUNT(*) FROM trans) AS transactions, (SELECT COUNT(*) FROM loan) AS loans"
```

Expected counts are 1,056,320 transactions and 682 loans. If your source database has
a different name, set `SRC_DB` to that name in the next step.

### Create the warehouse and configure the connection

The schema script drops and recreates `mco1_schema` every time it runs. Run it only
when you intend to recreate the empty warehouse:

```bat
mysql -u root -p < "STADVDB-MCO1-Group 5-Schema.sql"
```

The ETL and OLAP Python scripts read connection settings from `.env` in the repository
root. A local `.env` is already created with `DB_USER=root`, `SRC_DB=financedata`, and
`DWH_DB=mco1_schema`; edit it and enter your MySQL password as `DB_PASSWORD=...`.
The `.env` file is ignored by Git and should not be committed. For reference, the
shareable template is `.env.etl.example`. Existing environment variables take
precedence over values in `.env`. If you use a different MySQL user or database name,
edit those values in `.env` too.

### Run the ETL, reports, and functional tests

From the repository root, load the dimensions and facts, then run the reconciliation
checks:

```bat
python ETL.py
```

Success ends with `ETL finished: all reconciliation checks passed`. If the load fails
partway through, or you intentionally want to reload the warehouse, clear and reload
the target tables with:

```bat
python ETL.py --reset
```

The ETL writes `etl_run.log` and `etl_rejects.log`.

Run the OLAP reports and functional tests from the repository root:

```bat
python OLAP/OLAP_queries.py
python OLAP/test_OLAP.py
```

Reports are written to `olap_results/*.csv`. The tests write
`functional_test_log.csv` and check control totals including 1,056,320 transactions
and net cash flow of 197,151,288.70.

### Performance baseline

The performance script is in the repository root. Copy it into the `OLAP` folder,
then run it from there so it can import `OLAP_queries` as a module:

```bat
copy perf_baseline.py OLAP\perf_baseline.py
cd OLAP
python perf_baseline.py --module OLAP_queries --label baseline
```

## Run the dashboard locally
```
npm install
npm start
```
Open http://localhost:3000. Needs Node 22 or newer (`node --version`).
Copy `.env.example` to `.env.local` and fill it in once a database is reachable. Without it every endpoint
returns sample data and the page shows a "Demo data" badge, so the whole UI can be tried without MySQL.

### Report endpoints

Each report's SQL sits in one constant at the top of its file (R1–R4 from `OLAP/OLAP_queries_optimized.py`,
R5–R7 from `OLAP/OLAP_queries.py`), with `:name` placeholders. To swap in an optimized query, replace that
constant and keep the placeholders and output column names; the JSON response is rebuilt in a fixed column
order, so the front end does not change.

| Endpoint | Report | Parameters |
|---|---|---|
| `/api/r1-cash-flow` | R1 cash flow trend | `level` (year/quarter/month/day), `date_from`, `date_to`, `region` |
| `/api/r2-regional` | R2 regional roll-up | `year_from`, `year_to`, `txn_type` (Credit/Debit), `region` |
| `/api/r3-operation-pivot` | R3 operations by year | `measure` (amount/count), `txn_type`, `region` |
| `/api/r4-loan-portfolio` | R4 loan portfolio | `group_by` (region/status/duration/year), `phase`, `health`, `region`, `year_from`, `year_to`, `duration` |
| `/api/r5-top-accounts` | R5 top accounts | `region`, `year`, `top_n` |
| `/api/r6-transaction-mix` | R6 transaction mix | `year`, `region`, `txn_type` |
| `/api/r7-region-profile` | R7 region profile | `year_from`, `year_to`, `region` |

Every response is `{ report, params, columns, rows, ms, source }`, where `source` is `db` or `demo`.

### Check the endpoints against the report CSVs

With the server running and `.env.local` set:

```
npm run check
```

It calls every endpoint with the example parameters from `OLAP/OLAP_queries.py`, compares the rows with
`olap_results/*.csv`, checks the control totals (1,056,320 transactions, net cash flow 197,151,288.70,
682 loans, 103,261,740.00 loaned) and prints PASS or FAIL per check. Set `BASE_URL` to check another server.

## Deploy
Push to GitHub, import the repo at vercel.com/new, leave all build settings empty, click Deploy.
Then add the DB_* variables under Settings > Environment Variables and redeploy.
