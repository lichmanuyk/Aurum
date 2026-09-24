"""Migration uses synthetic exports only. No real financial fixtures in Git."""
import csv
import io
from decimal import Decimal
import pytest
from scripts.monefy_import import HEADER, build_review, read_rows


def csv_bytes(rows):
    stream = io.StringIO(newline='')
    writer = csv.writer(stream)
    writer.writerow(HEADER)
    writer.writerows(rows)
    return stream.getvalue().encode()


def row(account='01. Synthetic',category='Income',amount='1',currency='USD',converted='4',day='01.01.2025'):
    return [day,account,category,amount,currency,converted,'PLN','Synthetic note']


async def test_lossless_preview_visibility_duplicates_and_initial_balance(client):
    raw = csv_bytes([row(category='InitialBalance',amount='10',converted='40'),row(),row(),
                     row(category='ExpenseTransfer',amount='-1',converted='-4'),
                     row(account='Old',category='IncomeTransfer',amount='4',currency='PLN',converted='4')])
    review = build_review(raw,14)
    assert review['summary']['matched_transfer_pairs'] == 1
    assert review['summary']['pending_transfer_rows'] == 0
    assert review['summary']['duplicate_rows_preserved'] == 1
    assert review['summary']['visible_accounts'] == review['summary']['archived_accounts'] == 1
    assert review['preview_backup']['transactions'][0]['type'] == 'adjustment'
    result = await client.post('/backup/import',json=review['preview_backup'])
    assert result.status_code == 200, result.text
    assert len((await client.get('/accounts')).json()) == 1
    accounts = (await client.get('/accounts',params={'include_archived':True})).json()
    assert {a['name']: Decimal(a['balance']) for a in accounts} == {'01. Synthetic':11,'Old':4}
    cash = (await client.get('/cash-flow')).json()
    assert Decimal(cash['total_income']) == 8


def test_ambiguous_or_different_date_transfers_remain_pending():
    raw = csv_bytes([row(account='A',category='ExpenseTransfer',amount='-1',converted='-4'),
                     row(account='B',category='ExpenseTransfer',amount='-1',converted='-4'),
                     row(account='C',category='IncomeTransfer',amount='1',converted='4'),
                     row(account='D',category='IncomeTransfer',amount='1',converted='4')])
    review = build_review(raw,14)
    assert review['summary']['matched_transfer_pairs'] == 0
    assert review['summary']['pending_transfer_rows'] == 4
    assert all(Decimal(a['source_balance']) == Decimal(a['pending_delta']) for a in review['accounts'])


def test_repeated_equivalent_transfers_preserved_without_arbitrary_facts():
    raw = csv_bytes([row(account='A',category='ExpenseTransfer',amount='-1',converted='-4')]*2 +
                    [row(account='B',category='IncomeTransfer',amount='1',converted='4')]*2)
    review = build_review(raw,14)
    assert review['summary']['matched_transfer_pairs'] == 2
    assert review['summary']['pending_transfer_rows'] == 0
    assert len(review['lineage']) == 2
    assert all(Decimal(a['pending_delta']) == 0 for a in review['accounts'])


def test_same_currency_mismatch_does_not_invent_exchange():
    raw = csv_bytes([row(category='ExpenseTransfer',amount='-1',converted='-4'),
                    row(account='02. Destination',category='IncomeTransfer',amount='1.001',converted='4')])
    assert build_review(raw,14)['summary']['pending_transfer_rows'] == 2


def test_csv_schema_and_account_currency_validation():
    with pytest.raises(ValueError):
        read_rows(b'date,account\n')
    with pytest.raises(ValueError):
        read_rows(csv_bytes([row(),row(currency='EUR')]))
    with pytest.raises(ValueError):
        read_rows(csv_bytes([row(amount='NaN')]))
    with pytest.raises(ValueError):
        read_rows(csv_bytes([row(amount='1.0000001')]))


async def test_finalization_retains_orphans_and_reconciles_without_rewriting_history(client):
    from datetime import date
    from scripts.monefy_import import finalize_review
    raw = csv_bytes([row(amount='1.001',converted='4.004'),
                     row(category='ExpenseTransfer',amount='-0.1',converted='-0.4')])
    targets={'01. Synthetic':{'amount':'0.90','currency':'USD'}}
    backup, audit=finalize_review(raw,14,targets,date(2025,1,2))
    assert audit['summary']['preserved_unmatched_legs']==1
    assert audit['summary']['reconciliation_count']==1
    assert len(audit['lineage'])==2
    assert Decimal(backup['transactions'][0]['amount'])==Decimal('1.001')
    assert Decimal(audit['reconciliations'][0]['delta'])==Decimal('-0.001')
    assert (await client.post('/backup/import',json=backup)).status_code==200
    accounts=(await client.get('/accounts')).json()
    assert Decimal(accounts[0]['balance'])==Decimal('0.90')
    cash=(await client.get('/cash-flow')).json()
    assert Decimal(cash['total_income'])==Decimal('4.004')
    assert Decimal(cash['total_expense'])==0
    exported=(await client.get('/backup/export')).json()
    assert len(exported['transactions'])==3
    assert (await client.post('/backup/import',json=exported)).status_code==200


def test_finalization_rejects_missing_targets_currency_changes_and_backdating():
    from datetime import date
    from scripts.monefy_import import finalize_review
    raw=csv_bytes([row()])
    for targets, day in [({},date(2025,1,2)),({'01. Synthetic':{'amount':'1','currency':'EUR'}},date(2025,1,2)),
                         ({'01. Synthetic':{'amount':'1','currency':'USD'}},date(2024,1,1))]:
        with pytest.raises(ValueError):
            finalize_review(raw,14,targets,day)
