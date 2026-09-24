"""Synthetic end-to-end monetary invariants; no personal finance fixtures."""
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from app.services.fx_service import FXConverter


async def account(client, currency):
    response = await client.post('/accounts', json={'name': f'Test {currency}', 'currency': currency})
    assert response.status_code == 201, response.text
    return response.json()['id']


async def rate(client, day, base='EUR', quote='PLN', value='4'):
    response = await client.post('/fx-rates/bulk', json={'items': [dict(base_currency=base, quote_currency=quote, rate_date=str(day), rate=value)]})
    assert response.status_code == 200, response.text


async def tx(client, source, **fields):
    payload = dict(account_id=source, type='expense', amount='100', date=str(date.today()), description='Synthetic')
    payload.update(fields)
    response = await client.post('/transactions', json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def test_native_transfer_and_atomic_patch(client):
    eur, pln = await account(client, 'EUR'), await account(client, 'PLN')
    await tx(client, eur, type='income', amount='200')
    transfer = await tx(client, eur, type='transfer', transfer_account_id=pln, destination_amount='431.27')
    balances = {a['id']: Decimal(a['balance']) for a in (await client.get('/accounts')).json()}
    assert balances[eur] == 100 and balances[pln] == Decimal('431.27')
    incoming = (await client.get('/transactions', params={'account_id': pln})).json()
    assert incoming['items'][0]['id'] == transfer['id']
    assert incoming['items'][0]['transfer_account']['currency'] == 'PLN'
    failed = await client.patch(f"/transactions/{transfer['id']}", json={'destination_amount': None})
    assert failed.status_code == 422
    assert Decimal((await client.get('/transactions', params={'account_id': pln})).json()['items'][0]['destination_amount']) == Decimal('431.27')
    assert (await client.patch(f'/accounts/{eur}', json={'currency': 'USD'})).status_code == 409
    assert (await client.delete(f'/accounts/{pln}')).status_code == 409


async def test_missing_rate_does_not_block_native_data(client):
    eur = await account(client, 'EUR')
    await tx(client, eur)
    await client.patch('/settings', json={'currency': 'PLN'})
    response = await client.get('/cash-flow')
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'FX_RATE_MISSING'
    assert (await client.get('/accounts')).status_code == 200
    assert (await client.get('/backup/export')).status_code == 200


async def test_same_day_exchanges_keep_actual_amounts_independent_of_daily_fx(client):
    usd, pln = await account(client, 'USD'), await account(client, 'PLN')
    await rate(client, date.today(), base='USD', value='4.3')
    official = (await client.get('/fx-rates')).json()
    await tx(client, usd, type='income', amount='300')
    first = await tx(client, usd, type='transfer', transfer_account_id=pln, destination_amount='360')
    second = await tx(client, usd, type='transfer', transfer_account_id=pln, destination_amount='380')
    assert (await client.get('/fx-rates')).json() == official

    async def check_amounts():
        balances = {a['id']: Decimal(a['balance']) for a in (await client.get('/accounts')).json()}
        assert balances[usd] == 100 and balances[pln] == 740
        backup = (await client.get('/backup/export')).json()
        transfers = {t['id']: t for t in backup['transactions']}
        for transfer, received in ((first, '360'), (second, '380')):
            assert Decimal(transfers[transfer['id']]['amount']) == 100
            assert Decimal(transfers[transfer['id']]['destination_amount']) == Decimal(received)
        return backup

    await check_amounts()
    await rate(client, date.today(), base='USD', value='4.5')
    backup = await check_amounts()
    assert (await client.post('/backup/import', json=backup)).status_code == 200
    await check_amounts()


async def test_historical_flow_reports_budget_and_override(client, categories):
    eur = await account(client, 'EUR')
    await client.patch('/settings', json={'currency': 'PLN'})
    category = categories['Groceries']['id']
    await rate(client, '2025-01-03', value='4')
    await rate(client, '2025-01-17', value='4.5')
    await rate(client, date.today(), value='5')
    await tx(client, eur, date='2025-01-03', category_id=category)
    await tx(client, eur, date='2025-01-17', category_id=category)
    budget = await client.post('/budgets', json={'category_id': category, 'monthly_limit': '900', 'currency': 'PLN'})
    assert budget.status_code == 201
    cf = (await client.get('/cash-flow')).json()
    assert Decimal(cf['total_expense']) == 850
    dash = (await client.get('/dashboard/summary', params={'year': 2025, 'month': 1})).json()
    assert Decimal(dash['spent']) == 850
    status = (await client.get('/budgets/status', params={'year': 2025, 'month': 1})).json()['items'][0]
    assert Decimal(status['spent']) == 850 and status['currency'] == 'PLN'
    custom = await tx(client, eur, date='2025-01-17', amount='10', reporting_amount_override='43.12', reporting_currency_override='PLN', reporting_override_source='manual')
    assert Decimal((await client.get('/cash-flow')).json()['total_expense']) == Decimal('893.12')
    assert (await client.patch(f"/transactions/{custom['id']}", json={'amount': '11'})).status_code == 422
    await client.patch('/settings', json={'currency': 'EUR'})
    assert (await client.get('/budgets')).json()[0]['currency'] == 'PLN'


async def test_stock_revalues_native_balance_and_old_asset(client):
    today, yesterday = date.today(), date.today() - timedelta(days=1)
    eur = await account(client, 'EUR')
    await client.patch('/settings', json={'currency': 'PLN'})
    await rate(client, yesterday, value='4')
    await rate(client, today, value='4.5')
    await tx(client, eur, type='income', date=str(yesterday))
    asset = await client.post('/assets', json={'name': 'Synthetic asset', 'asset_class': 'investments', 'currency': 'EUR', 'value': '200', 'as_of_date': str(yesterday)})
    assert asset.status_code == 201
    await client.patch(f'/accounts/{eur}', json={'is_archived': True})
    nw = await client.get('/net-worth/summary', params={'range': 'all'})
    assert nw.status_code == 200, nw.text
    values = [Decimal(p['value']) for p in nw.json()['series']]
    assert values == [Decimal('1200'), Decimal('1350')]
    assert Decimal(nw.json()['current']) == sum(Decimal(i['amount']) for i in nw.json()['breakdown'])
    await tx(client, eur, type='income', amount='999', date=str(today + timedelta(days=1)))
    assert Decimal((await client.get('/net-worth/summary', params={'range': 'all'})).json()['current']) == 1350


async def test_goal_currency_and_backup_roundtrip(client):
    goal = await client.post('/goals', json={'name': 'Synthetic goal', 'target_amount': '1000', 'currency': 'EUR'})
    assert goal.status_code == 201
    await rate(client, date.today())
    eur, pln = await account(client, 'EUR'), await account(client, 'PLN')
    await tx(client, eur, type='transfer', transfer_account_id=pln, destination_amount='431.27')
    exported = (await client.get('/backup/export')).json()
    assert exported['aurum_backup_version'] == 4
    assert (await client.post('/backup/import', json=exported)).status_code == 200
    again = (await client.get('/backup/export')).json()
    for key in ('goals', 'transactions', 'fx_rates', 'app_settings'):
        assert again[key] == exported[key]
    await client.patch('/settings', json={'currency': 'PLN'})
    assert (await client.get('/goals')).json()[0]['currency'] == 'EUR'
    corrupt = {**again, 'fx_rates': again['fx_rates'] * 2}
    assert (await client.post('/backup/import', json=corrupt)).status_code == 422
    assert (await client.get('/goals')).json()[0]['currency'] == 'EUR'


async def test_recurring_actual_destination_and_precision(client):
    eur, pln = await account(client, 'EUR'), await account(client, 'PLN')
    r = await client.post('/recurring', json=dict(account_id=eur, transfer_account_id=pln, type='transfer', amount='100', description='Synthetic recurring', frequency='monthly', anchor_date=str(date.today())))
    assert r.status_code == 201, r.text
    url = f"/recurring/{r.json()['id']}/post"
    assert (await client.post(url)).status_code == 422
    assert (await client.post(url, json={'destination_amount': '431.27'})).status_code == 201
    assert Decimal((await client.get('/accounts')).json()[1]['balance']) in (Decimal('-100'), Decimal('431.27'), Decimal(0))
    jpy = await account(client, 'JPY')
    bad = await client.post('/transactions', json=dict(account_id=jpy, type='expense', amount='1.23', description='Invalid precision', date=str(date.today())))
    assert bad.status_code == 422


async def test_fx_resolution_policy():
    day = date(2025, 1, 1)
    rows = [SimpleNamespace(base_currency=a, quote_currency=b, rate_date=day, rate=Decimal(value)) for a,b,value in [('EUR','USD','1.1'), ('PLN','USD','0.25')]]
    fx = FXConverter(rows, 'PLN')
    assert fx.convert(Decimal(100), 'EUR', day) == Decimal('440.00')
    assert fx.convert(Decimal(100), 'EUR', day + timedelta(days=7)) == Decimal('440.00')
    assert fx.convert(Decimal(100), 'PLN', day) == 100
    for missing in (day - timedelta(days=1), day + timedelta(days=8)):
        with pytest.raises(HTTPException) as e:
            fx.convert(Decimal(100), 'EUR', missing)
        assert e.value.status_code == 409


async def test_split_rounding_is_nonnegative_and_conserves_parent():
    fx = FXConverter([], 'PLN')
    transaction = SimpleNamespace(amount=Decimal('.04'), reporting_amount_override=Decimal('.02'), reporting_currency_override='PLN', date=date.today(), splits=[SimpleNamespace(category_id=i, amount=Decimal('.01')) for i in range(4)])
    values = [v for _,v in fx.splits(transaction)]
    assert sum(values) == Decimal('.02') and min(values) >= 0


async def test_crypto_historical_cost_and_display_switch(client, monkeypatch):
    from app.services import crypto_service
    from tests.test_crypto import _point
    calls = []
    async def prices(ids, currency):
        calls.append(currency)
        return {'bitcoin': _point('150')}
    monkeypatch.setattr(crypto_service, '_fetch_market_data', prices)
    await client.patch('/settings', json={'currency': 'PLN'})
    await rate(client, '2025-01-01', value='4')
    await rate(client, date.today(), value='5')
    holding = await client.post('/crypto/holdings', json={'coingecko_id': 'bitcoin', 'symbol': 'btc', 'name': 'Synthetic BTC', 'quantity': '2', 'price_per_unit': '100', 'quote_currency': 'EUR', 'date': '2025-01-01', 'network': 'Bitcoin'})
    assert holding.status_code == 201, holding.text
    body = holding.json()
    assert Decimal(body['cost_basis']) == 800
    assert Decimal(body['value']) == 1500
    assert body['quote_currency'] == 'EUR' and calls == ['eur']
    sold = await client.post(f"/crypto/holdings/{body['asset_id']}/transactions", json={'type': 'sell', 'quantity': '1', 'price_per_unit': '150', 'quote_currency': 'EUR', 'date': str(date.today())})
    assert sold.status_code == 201
    assert Decimal(sold.json()['cost_basis']) == 400
    await client.patch('/settings', json={'currency': 'EUR'})
    refreshed = await client.post('/crypto/refresh')
    assert refreshed.status_code == 200, refreshed.text
    item = refreshed.json()['holdings'][0]
    assert Decimal(item['cost_basis']) == 100
    assert Decimal(item['value']) == 150
    assert calls == ['eur', 'eur']
    backup = (await client.get('/backup/export')).json()
    assert backup['crypto_holdings'][0]['network'] == 'Bitcoin'
    assert backup['crypto_transactions'][0]['quote_currency'] == 'EUR'
    assert (await client.post('/backup/import', json=backup)).status_code == 200


async def test_crypto_missing_fx_preserves_native_write(client, monkeypatch):
    from app.services import crypto_service
    from tests.test_crypto import _point, _fake_fetch
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('150')}))
    await client.patch('/settings', json={'currency': 'PLN'})
    result = await client.post('/crypto/holdings', json={'coingecko_id': 'bitcoin', 'symbol': 'btc', 'name': 'Synthetic BTC', 'quantity': '1', 'price_per_unit': '100', 'quote_currency': 'EUR', 'date': str(date.today())})
    assert result.status_code == 201, result.text
    assert result.json()['valuation_error']['code'] == 'FX_RATE_MISSING'
    assert result.json()['cost_basis'] is None
    assert Decimal(result.json()['quantity']) == 1


async def test_v1_unresolved_transfer_survives_backup_without_invented_amount(client):
    eur, pln = await account(client, 'EUR'), await account(client, 'PLN')
    await tx(client, eur, type='transfer', transfer_account_id=pln, destination_amount='431.27')
    backup = (await client.get('/backup/export')).json()
    backup['aurum_backup_version'] = 1
    for transaction in backup['transactions']:
        transaction.pop('destination_amount')
    assert (await client.post('/backup/import', json=backup)).status_code == 200
    response = await client.get('/accounts')
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'TRANSFER_AMOUNT_UNRESOLVED'
    preserved = (await client.get('/backup/export')).json()
    assert preserved['transactions'][0]['destination_amount'] is None
    assert (await client.post('/backup/import', json=preserved)).status_code == 200


async def test_reports_splits_and_budget_agree(client, categories):
    eur = await account(client, 'EUR')
    await client.patch('/settings', json={'currency': 'PLN'})
    today = date.today()
    await rate(client, today, value='4.3127')
    parent = categories['Groceries']['id']
    child = (await client.post('/categories', json={'name': 'Synthetic child', 'kind': 'expense', 'color': '#123456', 'parent_id': parent})).json()['id']
    await tx(client, eur, amount='100', splits=[{'category_id':parent,'amount':'33.33'}, {'category_id':child,'amount':'66.67'}])
    ranking = await client.get('/reports/category-ranking')
    assert ranking.status_code == 200, ranking.text
    assert Decimal(ranking.json()['total_amount']) == Decimal('431.27')
    assert sum(Decimal(x['amount']) for x in ranking.json()['items'][0]['children']) == Decimal('431.27')


async def test_eight_year_stock_history_batches_queries(client, test_sessionmaker):
    from sqlalchemy import event
    from app.models.transaction import Transaction
    from app.models.fx import FXRate
    from app.models.enums import TransactionType
    from time import perf_counter
    eur = await account(client, 'EUR')
    await client.patch('/settings', json={'currency': 'PLN'})
    start = date.today() - timedelta(days=2920)
    async with test_sessionmaker() as session:
        session.add_all(FXRate(base_currency='EUR', quote_currency='PLN', rate_date=start + timedelta(days=i), rate=Decimal('4'), source='synthetic') for i in range(2921))
        session.add_all(Transaction(account_id=eur, type=TransactionType.INCOME, amount=Decimal('1'), description='Synthetic load test', date=start + timedelta(days=i % 2921)) for i in range(12000))
        await session.commit()
    queries = []
    engine = test_sessionmaker.kw['bind'].sync_engine
    def count(*args):
        queries.append(1)
    event.listen(engine, 'before_cursor_execute', count)
    try:
        begin = perf_counter()
        response = await client.get('/net-worth/summary', params={'range': 'all'})
        elapsed = perf_counter() - begin
        assert response.status_code == 200, response.text
        assert Decimal(response.json()['current']) == 48000
        assert len(response.json()['series']) == 2921
        assert len(queries) <= 12, len(queries)
        print(f'12k transactions / 8 years: {elapsed:.3f}s, {len(queries)} SQL statements')
    finally:
        event.remove(engine, 'before_cursor_execute', count)


async def test_fixed_budget_currencies_do_not_require_unrelated_fx(client, categories):
    eur, pln = await account(client, 'EUR'), await account(client, 'PLN')
    groceries = categories['Groceries']['id']
    other = (await client.post('/categories', json={'name': 'Synthetic PLN budget', 'kind': 'expense', 'color': '#123456'})).json()['id']
    for category, currency in [(groceries, 'EUR'), (other, 'PLN')]:
        assert (await client.post('/budgets', json={'category_id': category, 'currency': currency, 'monthly_limit': '100'})).status_code == 201
    await tx(client, eur, amount='10', category_id=groceries)
    await tx(client, pln, amount='20', category_id=other)
    result = await client.get('/budgets/status', params={'year': date.today().year, 'month': date.today().month})
    assert result.status_code == 200, result.text
    assert {row['currency']: Decimal(row['spent']) for row in result.json()['items']} == {'EUR': 10, 'PLN': 20}


async def test_split_precision_follows_native_currency(client, categories):
    jpy = await account(client, 'JPY')
    result = await client.post('/transactions', json={'account_id': jpy, 'type': 'expense', 'amount': '1', 'date': str(date.today()), 'description': 'Invalid fractional yen', 'splits': [{'category_id': categories['Groceries']['id'], 'amount': '0.5'}, {'category_id': categories['Groceries']['id'], 'amount': '0.5'}]})
    assert result.status_code == 422
