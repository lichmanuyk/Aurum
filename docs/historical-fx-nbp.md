# Historical FX: NBP adapter

Settings → Historical exchange rates now downloads official NBP tables A/B.
Full history starts seven days before the earliest ledger, asset valuation or
crypto trade. Latest-rates refresh requests the last 14 days. These are explicit
user actions; no background scheduler is installed.

- GET `/api/fx-rates/nbp/plan`: required currencies (including archived accounts), dates.
- POST `/api/fx-rates/nbp`: inclusive interval of at most 93 days, no future dates.
- GET `/api/fx-rates/coverage`: missing daily conversion ranges, using the actual converter.

The UI processes intervals newest first. Each interval is atomic and retryable;
completed intervals survive a later failure. Only NBP-owned existing quotations
are updated. Manual/custom rates remain untouched. Source table identifiers are
stored and included in reporting metadata and backup v3.

NBP JSON `mid` is PLN per one currency unit, including IDR. Table A is published
on business days; BYN comes from weekly table B. Resolution tries direct/inverse,
then USD/PLN pivots with both legs on the same publication date. Previous quotes
are allowed up to seven days; future quotations are never used. Unsupported or
missing quotes remain explicit gaps rather than zero values. Transaction amounts,
account balances and imported transaction-specific reporting overrides are unchanged.

The visible settings table shows the latest 100 quotes; all stored quotes remain
available through the API and full backup. Provider requests send only table/date
parameters, never ledger records, account names or amounts.

Validation: 178 backend tests, 60 frontend tests, production frontend build;
real browser download and chart rendering; independent Decimal replay of every
historical capital point and unchanged-business-data comparison. Private financial
verification artifacts and backups are stored outside the repository.

Official references:
- https://api.nbp.pl/en.html
- https://nbp.pl/statystyka-i-sprawozdawczosc/kursy/informacja-o-terminach-publikacji-kursow-walut/
