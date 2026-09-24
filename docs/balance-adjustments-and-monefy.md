# Ledger precision, balance adjustments and Monefy review

> Historical stage report. For the current implementation, validation and limitations, see [release review](release-review.md). The preview instance mentioned below now contains user data and must never be used for destructive E2E tests.

Implemented after Multi-Currency v1, in the same local feature branch.

## Ledger semantics

Transactions.amount, destination_amount, reporting_amount_override and split amounts now use NUMERIC(18,6). The 12-integer-digit range is unchanged. Ordinary income/expense and transfer amounts remain positive. Supported non-zero-minor currencies can preserve up to six fractional digits; JPY/KRW still require integer native units. Valuations, budgets, goals and recurring template amounts retain their existing currency precision. Recurring transfer posting accepts a six-digit destination amount.

Native transaction and account displays retain significant fractional digits instead of silently rounding to cents. CSV import and duplicate keys preserve six digits; split validation uses integer arithmetic. Native/identity reporting and same-currency imported reporting overrides retain exact amounts. Reference FX conversions still round to target currency minor units. The UI's compact aggregate/chart formatting does not alter stored values.

`type=adjustment` records a signed, nonzero change to a single account. `adjustment_reason` is required: `opening_balance`, `reconciliation` or `migration`. No category, split, transfer destination or reporting override is allowed. Adjustments affect native balances and Net Worth, and are excluded from income/expense/Cash Flow/category reports/budgets. They cannot be recurring templates. The UI explains that the entered amount is a delta, not a replacement balance.

Migration: `f0a100000002`, after `f0a100000001`. Existing decimals are expanded without rounding. The existing transaction type column is VARCHAR(10), sufficient for ADJUSTMENT. Automatic downgrade is blocked because restoring the old numeric scale would lose facts.

Backup format is now **3**, accepting v1, v2 and v3 on restore. New adjustment reasons and sub-cent amounts roundtrip; old readers reject the newer version instead of truncating it. The earlier multicurrency-v1 documents describe the preceding stage; this document supersedes their ledger precision and backup version statements.

## Conservative Monefy converter

`backend/scripts/monefy_import.py` is a standalone read-only CLI. It accepts a source CSV, `--visible-numbered-through N`, and `--output /private/path/review.json`. The output must be outside the repository and must not already exist. The current user's visibility rule was supplied explicitly; it is a CLI option, not a universal assumption about Monefy.

- Positional parsing preserves the two same-named currency columns.
- Source SHA256 and CSV row numbers provide traceability.
- No duplicate removal: identical rows may represent distinct purchases.
- InitialBalance becomes an opening_balance adjustment.
- Normal rows retain native amounts and per-operation reporting overrides.
- Transfer pairing groups exact reporting amount/currency/date, excludes same-account pairs and contradictory same-currency amounts. For repeated groups, pairing is accepted only if all valid assignments describe the same financial movements and descriptions. Search is bounded; ambiguous or unmatched rows remain pending.
- Numbered visible accounts and archived accounts preserve their history. Account names are not used to invent crypto quantities, goals or asset valuations. Account type initially remains generic checking; domain reclassification is a separate reviewed step.
- Output is a **review envelope**, not directly importable JSON: summary, per-account source/preview/pending balances, row lineage, pending transfer records and a nested preview_backup. Every source row belongs exactly once to the preview or pending set. Source balance = preview balance + pending delta for every account.
- No missing counterpart, fee, daily market FX rate or reconciliation adjustment is guessed. No automatic database restore or network access.
- `ready_for_final_import` remains false pending independent balances and unresolved transfer decisions. The tool is a preparation stage, not an unattended final migration.

## Validation

- 167 backend tests passed, including signed adjustments, invalid writes/bulk atomicity, six-digit transfers/splits, backup rollback, old-format compatibility and synthetic Monefy matching.
- 60 frontend tests passed; production build and Docker build passed.
- The supplied private CSV was additionally restored into temporary `aurum_test`, checked against exact native control balances and reporting income/expense totals, exported and restored again. All exact monetary fields and source notes survived. The temporary DB was dropped and private container input removed. No real fixture or account amounts are committed.
- All 10 Playwright tests passed, including create/edit of a signed six-digit opening balance and its exclusion from cash flow, plus existing regression tests. The suite requires fresh synthetic transaction fixtures.
- Original project `aurum` user data was not migrated. Updated UI preview runs as independent project `aurum-fx-e2e` on port 3101 with synthetic data.

Remaining migration inputs: independently confirmed Monefy balances at the export cutoff and decisions for unresolved transfer rows. Capital Movements and semantic reclassification of former account-based goals/crypto remain separate domain work.

## Explicitly confirmed finalization

The CLI now also accepts `--confirmed-balances`, `--as-of` and `--backup-output` together. The private confirmed-balances JSON maps every visible account name to an exact `amount` string and `currency`. Missing/extra accounts, mismatched currencies and a date before the source history are rejected.

When the user explicitly chooses preservation without reconstructing unknown counterparties, each unmatched source leg becomes a signed `migration` adjustment on its original date. Its source category, native/reporting amounts, description and CSV row identity remain in its notes and audit. Separate `reconciliation` adjustments on the confirmed date bring visible balances to user-confirmed values; original operations are never rewritten. Archived balances remain those derived from the CSV unless separately confirmed in a later workflow.

Every original row is covered exactly once by final transaction lineage, excluding the separately listed reconciliation entries. The final audit proves each account's source balance plus reconciliation delta equals its final balance. The CLI writes an importable backup v3 and a separate audit outside Git; it still never connects to a database.

Validation after finalization: 169 backend tests passed. The deployment check compares every monetary and source field through backup export, all account balances and archive flags, reporting income/expense totals, and reads every transaction page through the API. Personal confirmation files and exports remain outside the repository.
