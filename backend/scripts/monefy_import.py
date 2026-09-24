"""Conservative Monefy CSV migration. Never connects to or modifies a database.

CSV has two identically named currency columns, so parsing is positional.
Unresolved transfers remain outside the preview; source rows and exact control
balances remain in the review report. A review is not an importable backup.
"""
import argparse
import csv
import hashlib
import io
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from itertools import permutations
from pathlib import Path

HEADER = ['date', 'account', 'category', 'amount', 'currency', 'converted amount', 'currency', 'description']
TRANSFER_TYPES = {'ExpenseTransfer', 'IncomeTransfer'}


@dataclass(frozen=True)
class Row:
    number: int
    day: date
    account: str
    category: str
    amount: Decimal
    currency: str
    converted: Decimal
    reporting: str
    description: str


def read_rows(raw: bytes) -> list[Row]:
    reader = csv.reader(io.StringIO(raw.decode('utf-8-sig'), newline=''))
    if next(reader, None) != HEADER:
        raise ValueError('Unexpected Monefy CSV header')
    rows = []
    currencies = {}
    for number, fields in enumerate(reader, 2):
        if len(fields) != 8:
            raise ValueError(f'CSV row {number}: expected 8 columns')
        day, account, category, amount, currency, converted, reporting, description = fields
        row = Row(number, datetime.strptime(day, '%d.%m.%Y').date(), account, category,
                  Decimal(amount), currency, Decimal(converted), reporting, description)
        if not account or not category or not re.fullmatch('[A-Z]{3}', currency) or not re.fullmatch('[A-Z]{3}', reporting):
            raise ValueError(f'CSV row {number}: missing identity or invalid currency')
        for value in (row.amount, row.converted):
            if not value.is_finite() or value == 0 or abs(value) >= Decimal('1000000000000') or value % Decimal('.000001'):
                raise ValueError(f'CSV row {number}: invalid amount or unsupported precision')
        if row.amount * row.converted <= 0:
            raise ValueError(f'CSV row {number}: contradictory amount signs')
        if category == 'ExpenseTransfer' and row.amount >= 0 or category == 'IncomeTransfer' and row.amount <= 0:
            raise ValueError(f'CSV row {number}: contradictory transfer direction')
        if currency == reporting and row.amount != row.converted:
            raise ValueError(f'CSV row {number}: contradictory same-currency amounts')
        if account in currencies and currencies[account] != currency:
            raise ValueError(f'CSV row {number}: account changes currency')
        currencies[account] = currency
        rows.append(row)
    if not rows:
        raise ValueError('Empty Monefy export')
    return rows


def pair_transfers(rows):
    groups = defaultdict(lambda: [[], []])
    for row in rows:
        if row.category in TRANSFER_TYPES:
            groups[row.day, abs(row.converted), row.reporting][row.category == 'IncomeTransfer'].append(row)
    pairs, unresolved = [], []
    for outgoing, incoming in groups.values():
        # Bound search. No order-based pairing of ambiguous bank facts.
        if len(outgoing) != len(incoming) or len(outgoing) > 6:
            unresolved.extend(outgoing + incoming)
            continue
        outcomes = {}
        for candidate in permutations(incoming):
            if any(a.account == b.account or (a.currency == b.currency and -a.amount != b.amount)
                   for a, b in zip(outgoing, candidate)):
                continue
            signature = tuple(sorted((a.account, str(-a.amount), b.account, str(b.amount), a.description, b.description)
                                     for a, b in zip(outgoing, candidate)))
            outcomes.setdefault(signature, list(zip(outgoing, candidate)))
            if len(outcomes) > 1:
                break
        if len(outcomes) == 1:
            pairs.extend(next(iter(outcomes.values())))
        else:
            unresolved.extend(outgoing + incoming)
    return sorted(pairs, key=lambda pair: pair[0].number), sorted(unresolved, key=lambda row: row.number)


def build_review(raw: bytes, visible_through: int):
    rows = read_rows(raw)
    source_hash = hashlib.sha256(raw).hexdigest()
    accounts = sorted({r.account for r in rows})
    account_ids = {name: i for i, name in enumerate(accounts, 1)}
    currencies = {r.account: r.currency for r in rows}
    def visible(name):
        match = re.match(r'^(\d{2})\. ', name)
        return bool(match and 1 <= int(match[1]) <= visible_through)
    category_keys = sorted({(r.category, 'income' if r.amount > 0 else 'expense') for r in rows
                            if r.category not in TRANSFER_TYPES | {'InitialBalance'}})
    category_ids = {key: i for i, key in enumerate(category_keys, 1)}
    reporting = {r.reporting for r in rows}
    if len(reporting) != 1:
        raise ValueError('Choose a reporting currency explicitly for a mixed-reporting export')
    primary = next(iter(reporting))
    pairs, unresolved = pair_transfers(rows)
    transactions = []
    lineage = []
    def append(row, kind, amount, source_rows, **extra):
        ident = len(transactions) + 1
        transactions.append(dict(id=ident, account_id=account_ids[row.account], category_id=None,
            transfer_account_id=None, type=kind, amount=str(amount), description=row.description[:255] or row.category,
            merchant=None, notes=f'Monefy SHA256 {source_hash}; CSV rows {", ".join(str(r.number) for r in source_rows)}\n' +
            '\n'.join(r.description for r in source_rows if r.description), date=row.day.isoformat(), tag_ids=[], **extra))
        lineage.append(dict(transaction_id=ident, source_rows=[r.number for r in source_rows]))
    for row in rows:
        if row.category in TRANSFER_TYPES:
            continue
        if row.category == 'InitialBalance':
            append(row, 'adjustment', row.amount, [row], adjustment_reason='opening_balance')
        else:
            kind = 'income' if row.amount > 0 else 'expense'
            append(row, kind, abs(row.amount), [row], reporting_amount_override=str(abs(row.converted)),
                   reporting_currency_override=row.reporting, reporting_override_source='monefy')
            transactions[-1]['category_id'] = category_ids[row.category, kind]
    for source, destination in pairs:
        append(source, 'transfer', -source.amount, [source, destination], destination_amount=str(destination.amount))
        transactions[-1]['transfer_account_id'] = account_ids[destination.account]
        transactions[-1]['description'] = source.description[:255] or f'{source.account} → {destination.account}'[:255]
    backup = dict(aurum_backup_version=3, exported_at=datetime.now(timezone.utc).isoformat(), app_version='1.1.8',
        accounts=[dict(id=account_ids[name], name=name, type='checking', currency=currencies[name], color=None,
                       is_archived=not visible(name)) for name in accounts],
        categories=[dict(id=category_ids[key], name=key[0], kind=key[1], icon=None, color='#898781',
                         sort_order=i, is_default=False, parent_id=None) for i,key in enumerate(category_keys)],
        transactions=transactions, assets=[], asset_valuations=[], fx_rates=[],
        app_settings=dict(currency=primary, idle_cash_threshold_currency=primary))
    source_balances, preview_balances = defaultdict(Decimal), defaultdict(Decimal)
    for row in rows:
        source_balances[row.account] += row.amount
    for tx in transactions:
        name = accounts[tx['account_id'] - 1]
        preview_balances[name] += Decimal(tx['amount']) * (-1 if tx['type'] in ('expense','transfer') else 1)
        if tx['type'] == 'transfer':
            preview_balances[accounts[tx['transfer_account_id'] - 1]] += Decimal(tx['destination_amount'])
    controls = [dict(account=name, currency=currencies[name], archived=not visible(name),
                     source_balance=str(source_balances[name]), preview_balance=str(preview_balances[name]),
                     pending_delta=str(source_balances[name]-preview_balances[name])) for name in accounts]
    pending_rows = {r.number for r in unresolved}
    consumed = [n for entry in lineage for n in entry['source_rows']]
    if len(set(consumed)) != len(consumed) or set(consumed) & pending_rows or set(consumed) | pending_rows != {r.number for r in rows}:
        raise AssertionError('Every source row must be accounted for exactly once')
    pending_balances = defaultdict(Decimal)
    for row in unresolved:
        pending_balances[row.account] += row.amount
    assert all(source_balances[name] == preview_balances[name] + pending_balances[name] for name in accounts)
    duplicates = Counter((r.day,r.account,r.category,r.amount,r.currency,r.converted,r.reporting,r.description) for r in rows)
    summary = dict(source_sha256=source_hash, source_rows=len(rows), period=[str(min(r.day for r in rows)),str(max(r.day for r in rows))],
        visible_accounts=sum(visible(a) for a in accounts), archived_accounts=sum(not visible(a) for a in accounts),
        matched_transfer_pairs=len(pairs), pending_transfer_rows=len(unresolved), preview_transactions=len(transactions),
        duplicate_rows_preserved=sum(n-1 for n in duplicates.values()),
        ready_for_final_import=False,
        limitations=['Current balances need external reconciliation.', 'Pending transfer rows must be resolved.',
                     'Account balances are fiat ledger facts, not reconstructed crypto holdings or investment valuations.',
                     'No market FX history inferred from transaction-specific converted amounts.'])
    return dict(summary=summary, accounts=controls, lineage=lineage,
                pending_transfers=[{**r.__dict__, 'day':str(r.day),'amount':str(r.amount),'converted':str(r.converted)} for r in unresolved],
                preview_backup=backup)


def finalize_review(raw: bytes, visible_through: int, targets: dict, as_of: date):
    """Explicit migration policy: preserve orphan legs, then reconcile confirmed balances.

    No counterparty is invented. Reconciliation is a separate dated delta;
    source transactions and their amounts are never edited to force a balance.
    """
    review = build_review(raw, visible_through)
    rows = read_rows(raw)
    if as_of < max(row.day for row in rows):
        raise ValueError('Reconciliation date precedes source history')
    backup = review['preview_backup']
    accounts = {a['name']: a for a in backup['accounts']}
    visible = {name for name, a in accounts.items() if not a['is_archived']}
    if set(targets) != visible:
        raise ValueError('Provide exactly one confirmed balance for every visible account')
    for name, target in targets.items():
        amount = Decimal(target['amount'])
        if target['currency'] != accounts[name]['currency']:
            raise ValueError(f'Confirmed currency differs from source account: {name}')
        if not amount.is_finite() or abs(amount) >= Decimal('1000000000000') or amount % Decimal('.000001'):
            raise ValueError('Invalid confirmed balance')
    migrations, reconciliations = [], []
    def adjustment(account, amount, day, reason, description, notes):
        ident = len(backup['transactions']) + 1
        backup['transactions'].append(dict(id=ident, account_id=account['id'], category_id=None,
            transfer_account_id=None, type='adjustment', amount=str(amount), adjustment_reason=reason,
            description=description, merchant=None, notes=notes, date=str(day), tag_ids=[]))
        return ident
    for row in review['pending_transfers']:
        ident = adjustment(accounts[row['account']], Decimal(row['amount']), row['day'], 'migration',
            row['description'][:255] or f"Monefy {row['category']}: unmatched legacy movement",
            f"Monefy SHA256 {review['summary']['source_sha256']}; CSV row {row['number']}. "
            'Original transfer leg preserved without an inferred counterparty. Source: ' + json.dumps(row, ensure_ascii=False))
        migrations.append(dict(transaction_id=ident, source_row=row['number']))
        review['lineage'].append(dict(transaction_id=ident, source_rows=[row['number']]))
    for control in review['accounts']:
        name = control['account']
        source = Decimal(control['source_balance'])
        target = Decimal(targets[name]['amount']) if name in targets else source
        delta = target - source
        if delta:
            ident = adjustment(accounts[name], delta, as_of, 'reconciliation', 'Confirmed balance reconciliation',
                f'User-confirmed balance as of {as_of}: {target} {control["currency"]}. '
                f'Source CSV balance: {source}. Separate delta: {delta}; original entries preserved.')
            reconciliations.append(dict(transaction_id=ident, account=name, currency=control['currency'],
                                        source_balance=str(source), confirmed_balance=str(target), delta=str(delta)))
        control.update(final_balance=str(target), reconciliation_delta=str(delta), independently_confirmed=name in targets)
    consumed = [n for entry in review['lineage'] for n in entry['source_rows']]
    if len(consumed) != len(rows) or set(consumed) != {r.number for r in rows}:
        raise AssertionError('Final migration must retain every source row exactly once')
    balances = defaultdict(Decimal)
    for tx in backup['transactions']:
        balances[tx['account_id']] += Decimal(tx['amount']) * (-1 if tx['type'] in ('expense', 'transfer') else 1)
        if tx['type'] == 'transfer':
            balances[tx['transfer_account_id']] += Decimal(tx['destination_amount'])
    assert all(balances[accounts[c['account']]['id']] == Decimal(c['final_balance']) for c in review['accounts'])
    review.pop('preview_backup')
    review['summary'].update(ready_for_final_import=True, final_transactions=len(backup['transactions']),
        pending_transfer_rows=0, source_unmatched_transfer_rows=len(migrations),
        preserved_unmatched_legs=len(migrations), reconciliation_count=len(reconciliations), reconciliation_date=str(as_of),
        limitations=['Archived balances retained from source, not independently confirmed.',
                     'Unmatched transfer legs are explicit migration adjustments, not inferred transfers.',
                     'Account balances remain fiat ledger facts; asset reclassification and market FX history are separate.'])
    review.update(migration_adjustments=migrations, reconciliations=reconciliations)
    return backup, review


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='Private JSON review path outside the repository')
    parser.add_argument('--visible-numbered-through', type=int, required=True)
    parser.add_argument('--confirmed-balances', type=Path, help='Explicitly finalize using account-name keyed amounts and currencies')
    parser.add_argument('--as-of', type=date.fromisoformat, help='Date of confirmed balances; required for finalization')
    parser.add_argument('--backup-output', type=Path, help='Private importable backup path; required for finalization')
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    if any(p and p.resolve().is_relative_to(repository) for p in (args.output, args.backup_output)):
        parser.error('Personal migration reviews must be written outside the repository')
    if bool(args.confirmed_balances) != bool(args.backup_output) or bool(args.confirmed_balances) != bool(args.as_of):
        parser.error('Finalization requires --confirmed-balances, --as-of and --backup-output together')
    if args.output.exists() or (args.backup_output and args.backup_output.exists()):
        parser.error('Output already exists; choose new paths')
    raw = args.source.read_bytes()
    if args.confirmed_balances:
        backup, review = finalize_review(raw, args.visible_numbered_through,
            json.loads(args.confirmed_balances.read_text()), args.as_of)
        args.backup_output.parent.mkdir(parents=True, exist_ok=True)
        with args.backup_output.open('x', encoding='utf-8') as f:
            json.dump(backup, f, ensure_ascii=False, indent=2)
    else:
        review = build_review(raw, args.visible_numbered_through)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as f:
        json.dump(review, f, ensure_ascii=False, indent=2)
    print(json.dumps(review['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
