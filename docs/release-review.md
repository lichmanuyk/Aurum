# Multi-currency and migration: release review

This feature targets `personal` in the fork. Keep `main` aligned with upstream.
The existing branch is `feat/multicurrency`; no reset, force push or upstream PR
is needed. Organize the accumulated work in dependency order:

1. Backend money model, reports, FX ingestion and migrations, with regression tests.
2. Native-currency forms, historical-rate settings and crypto opening-balance UI.
3. Standalone Monefy conversion and synthetic converter tests.
4. Browser regressions against a disposable stack.
5. Design, validation and operational notes.

## Current behavior

- Ledger amounts preserve six decimal places; transfers store both actual legs.
- Adjustments change balances without creating income/expense.
- Historical reporting uses dated FX, with explicit missing-rate errors.
- Official NBP ingestion preserves manual rates and supports USD/PLN cross rates.
- Crypto opening balances preserve quantities with unknown acquisition cost.
- Backup v4 accepts v1–v3 and validates money/history before atomic restore.
- Private conversion inputs, exported backups and screenshots stay outside Git.

Earlier documents retain the results of individual implementation stages; their
older test counts, backup versions and deployment descriptions are historical.
See [FX provider](historical-fx-nbp.md), [crypto openings](crypto-opening-balances.md)
and [Monefy migration](balance-adjustments-and-monefy.md).

## Validation and review boundaries

Backend regression tests use disposable `aurum_test`; populated migrations use a
separate temporary database. Browser tests require synthetic data and a dedicated
Compose project. Never point them at an instance containing personal data.

The PR remains draft pending review. Known follow-up work:
- Move new inline Russian/English UI strings into the shared translation catalog.
- Add scheduled backups and quote freshness indicators as separate features.
- Historic crypto purchase cost remains unknown until real trade records are supplied.
- The existing frontend bundle-size warning is not a build failure.

No merge, upstream submission or production deployment is part of publishing this
PR. Future changes should use one scoped branch/PR from `personal`, with commits
and test results recorded at each completed step.

## Publication checks (2026-09-24)

- Backend: 180 tests passed against disposable PostgreSQL databases.
- Frontend: 60 tests passed; TypeScript and production build passed.
- Playwright: all 10 tests passed on a newly created synthetic stack at port 3102.
- Personal source/export paths and known private financial identifiers were checked
  against all changed/new text files; no matches. No screenshots or input CSVs
  are included in the commits.
