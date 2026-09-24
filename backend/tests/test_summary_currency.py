import asyncio
from datetime import date, timedelta
from decimal import Decimal

import pytest
from tests.test_multicurrency import account, rate, tx
from tests.test_crypto import _fake_fetch, _point
from app.services import crypto_service


async def test_dashboard_uses_historical_rates_without_changing_primary_or_ledger(client, categories):
    await client.patch('/settings', json={'currency': 'PLN'})
    eur = await account(client, 'EUR')
    for day, value in [('2025-01-03', '4'), ('2025-01-17', '5')]:
        await rate(client, day, value=value)
        await rate(client, day, base='USD', value='2')
        await tx(client, eur, date=day, category_id=categories['Groceries']['id'])
    await rate(client, date.today(), value='9')
    before = (await client.get('/backup/export')).json()
    for currency, expected in [('PLN', '900'), ('USD', '450'), ('EUR', '200')]:
        result = await client.get('/dashboard/summary', params={'year': 2025, 'month': 1, 'currency': currency})
        assert result.status_code == 200, result.text
        body = result.json()
        assert body['reporting_currency'] == currency
        assert Decimal(body['spent']) == Decimal(expected)
        assert sum(Decimal(x['amount']) for x in body['spending_by_category']) == Decimal(expected)
    after = (await client.get('/backup/export')).json()
    for key in ('app_settings', 'accounts', 'transactions', 'fx_rates'):
        assert before[key] == after[key]
    default = (await client.get('/dashboard/summary', params={'year': 2025, 'month': 1})).json()
    assert default['reporting_currency'] == 'PLN' and Decimal(default['spent']) == 900


async def test_net_worth_currency_is_request_scoped_even_for_concurrent_reads(client):
    await client.patch('/settings', json={'currency': 'PLN'})
    eur = await account(client, 'EUR')
    yesterday = date.today() - timedelta(days=1)
    await tx(client, eur, type='income', date=str(yesterday))
    for day, value in [(yesterday, '4'), (date.today(), '5')]:
        await rate(client, day, value=value)
        await rate(client, day, base='USD', value='2')
    responses = await asyncio.gather(*(client.get('/net-worth/summary', params={'range': 'all', 'currency': c}) for c in ('EUR', 'USD', 'PLN')))
    for response, currency, values in zip(responses, ('EUR', 'USD', 'PLN'), ([100, 100], [200, 250], [400, 500])):
        assert response.status_code == 200, response.text
        body = response.json()
        assert body['reporting_currency'] == currency
        assert [Decimal(p['value']) for p in body['series']] == values
        assert Decimal(body['current']) == sum(Decimal(x['amount']) for x in body['breakdown'])
    assert (await client.get('/settings')).json()['currency'] == 'PLN'


async def test_crypto_display_conversion_keeps_native_quotes_and_quantities(client, monkeypatch):
    await client.patch('/settings', json={'currency': 'PLN'})
    await rate(client, date.today(), base='USD', value='4')
    await rate(client, date.today(), value='5')
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('50000')}))
    created = await client.post('/crypto/holdings', json={'coingecko_id': 'bitcoin', 'symbol': 'BTC', 'name': 'Bitcoin',
        'quantity': '0.5', 'price_per_unit': None, 'quote_currency': 'USD', 'date': str(date.today())})
    assert created.status_code == 201, created.text
    before = (await client.get('/backup/export')).json()
    for currency, value in [('PLN', 100000), ('USD', 25000), ('EUR', 20000)]:
        body = (await client.get('/crypto/holdings', params={'currency': currency})).json()['holdings'][0]
        assert body['currency'] == currency and body['quote_currency'] == 'USD'
        assert Decimal(body['quantity']) == Decimal('0.5') and Decimal(body['value']) == value
        assert body['cost_basis'] is None and body['profit_loss'] is None
        history = (await client.get('/crypto/history', params={'range': 'all', 'currency': currency})).json()
        assert history['reporting_currency'] == currency and Decimal(history['current']) == value
    after = (await client.get('/backup/export')).json()
    for key in ('app_settings', 'crypto_holdings', 'crypto_transactions', 'asset_valuations'):
        assert before[key] == after[key]


@pytest.mark.parametrize('path', ['/dashboard/summary', '/net-worth/summary', '/crypto/holdings', '/crypto/history'])
async def test_invalid_display_currency_is_rejected(client, path):
    assert (await client.get(path, params={'currency': 'INVALID'})).status_code == 422
