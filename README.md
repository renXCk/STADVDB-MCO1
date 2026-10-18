# Berka OLAP Dashboard

Web dashboard over the Berka data warehouse (MySQL star schema: `fact_transaction`, `fact_loan`).

- `public/` static page (filters + D3 chart)
- `api/` serverless endpoints, one parameterized query each
- `lib/db.js` MySQL pool (config from environment variables)

## Run locally
```
npm install
npm start
```
Open http://localhost:3000. Needs Node 22 or newer (`node --version`).
Copy `.env.example` to `.env.local` and fill it in once a database is reachable. Without it the page loads and says the database is not connected.

## Deploy
Push to GitHub, import the repo at vercel.com/new, leave all build settings empty, click Deploy.
Then add the DB_* variables under Settings > Environment Variables and redeploy.
