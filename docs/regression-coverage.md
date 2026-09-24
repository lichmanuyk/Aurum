# Regression coverage and boundaries

The suite checks behavior and monetary invariants, not a claimed 100% coverage.
No line/branch coverage percentage has been measured. All committed fixtures are
synthetic; browser runs use a disposable Compose project and ignore local `.env`.

| Area | Checks |
| --- | --- |
| Accounts and ledger | Native units, precise amounts, both transfer legs, archive/delete guards, bulk atomicity, splits |
| Reporting | Historical FX, missing/stale quotes, cash flow, dashboard, categories, budgets, insights, adjustments excluded from income/expense |
| Assets | Future valuations excluded, same-day valuation replacement, currency immutability, deletion and backup roundtrip |
| Crypto | Position replay, unknown opening cost, sales, portfolio grouping, pricing failures, backup, unknown-profit UI |
| Recurring | Month/year boundaries, actual destination amounts, failed-post rollback, inactive templates, concurrent duplicate clicks, null patch rejection |
| Backup/migrations | Populated-schema upgrade, references, monetary validation, old format compatibility, atomic restore |
| Import | Synthetic Monefy row lineage, ambiguous transfers, reconciliation, exact CSV decimal strings |
| Browser | Major pages at desktop/mobile widths, currency/transfer forms, balance adjustments, visible missing-FX errors, existing UI regressions |
| API client | Decimal strings, structured FX errors, non-JSON outages, empty successful responses |

## Current limits

Browser navigation smoke tests are not full create/edit/delete coverage of every
form. Exchange live data availability, backup scheduling/disaster recovery,
long-running concurrent workloads, deployment security review and exhaustive
accessibility checks are separate work. Calendar tests use explicit dates;
provider unit tests use controlled responses and do not depend on live rates.

CI defines backend, frontend and isolated browser jobs for pull requests and
pushes to `main`/`personal`. Hosted execution still depends on Actions being enabled
in the fork; the workflow file alone is not evidence of a successful GitHub run.

Run backend according to `backend/tests/README.md`; frontend with `npm test` and
`npm run build`; browser suite with `bash e2e/run.sh` after installing Playwright
Chromium. Never point these write-capable tests at the user's live application.

## Verified result (2026-09-24)

- 220 backend tests passed in a full run; the subsequently added independent
  ledger replay/restore test passed separately (221 backend tests in the suite).
- 65 frontend tests passed; production TypeScript/Vite build passed.
- 13 browser tests passed; after adding failed-API-response assertions, the three
  changed application-surface tests were run again on a fresh disposable stack.
- New regressions reproduced duplicate concurrent recurring postings, inactive
  template postings and invalid null updates; fixes passed the full backend suite.

This raises the checked suite from 250 to 299 cases. Counts are not a substitute
for the scenario matrix and limitations above.
