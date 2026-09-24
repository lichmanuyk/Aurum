# Crypto opening balances

Holdings can now start from a confirmed quantity without a fabricated purchase.
An omitted purchase price creates an `opening` transaction with null unit price;
buy/sell entries still require a strictly positive price. Opening balances add
quantity, preserve unknown cost through later buys and partial sales, and reset
that uncertainty only after the entire position has been closed. Cost and profit
are shown as unknown; market value remains independently available.

The add form supports unknown purchase cost; the history and transaction editor
recognize opening balances. Portfolio cost/profit totals are not shown when an
active holding has unknown cost. Backup v4 preserves nullable cost and accepts
v1–v3 imports. Migration f0a100000003 makes the stored unit price nullable.

CoinGecko requests use the configured Demo key when available and otherwise try
the public API. Failures retain cached prices; no account identifiers or quantities
are sent to the price provider. The existing daily-on-open and manual refresh
cadence is unchanged; this is not a continuously running exchange connection.

When replacing a ledger proxy account with real crypto holdings, retain every old
transaction. On the migration date, add one explicit migration adjustment to
remove the proxy balance and archive the now-empty account. Add independently
valued holdings on that same date. This preserves the previous capital history
(as recorded contributions, not reconstructed market prices) and avoids current
double counting. The valuation change on the migration date is not trading profit.
Private source screenshots, quantities, migration audit and backups stay outside Git.

Tests cover unknown cost through purchases, partial/full sales, reopening,
validation and backup roundtrip. Historical fills are still needed to reconstruct
actual acquisition cost and past market-value history.
