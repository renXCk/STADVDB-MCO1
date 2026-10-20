# Group 5 MCO1 OLAP Dashboard

Web dashboard over the Berka data warehouse (MySQL star schema: `fact_transaction`, `fact_loan`).

- `public/` static page (filters + D3 chart)
- `api/` serverless endpoints, one parameterized query each
- `lib/db.js` MySQL pool (config from environment variables)

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
Copy `.env.example` to `.env.local` and fill it in once a database is reachable. Without it the page loads and says the database is not connected.

## Deploy
Push to GitHub, import the repo at vercel.com/new, leave all build settings empty, click Deploy.
Then add the DB_* variables under Settings > Environment Variables and redeploy.
