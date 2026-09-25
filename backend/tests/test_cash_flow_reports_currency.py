"""Display currency for Cash Flow and Reports (see
docs/tasks/cash-flow-reports-display-currency.md) — both routes already ran
through get_reporting_session's `currency` query-param override (see
api/deps.py) once this change swapped them off plain get_session, the same
mechanism dashboard/net-worth/crypto already use. These tests exercise that
end to end: real historical conversion, an explicit missing-rate error
(never 0 or 1:1), and that same-day currency exchanges keep their own
recorded rate independent of the daily published one and of whatever
currency the two report pages happen to be viewed in.
"""
from datetime import date
from decimal import Decimal

import pytest
from tests.test_multicurrency import account, rate, tx


async def test_cash_flow_uses_historical_rates_and_respects_currency_param(client, categories):
    await client.patch('/settings', json={'currency': 'PLN'})
    eur = await account(client, 'EUR')
    for day, value in [('2025-01-03', '4'), ('2025-01-17', '5')]:
        await rate(client, day, value=value)
        await rate(client, day, base='USD', value='2')
        await tx(client, eur, date=day, category_id=categories['Groceries']['id'])
    await rate(client, date.today(), value='9')
    before = (await client.get('/backup/export')).json()

    default = (await client.get('/cash-flow', params={'start_date': '2025-01-01', 'end_date': '2025-01-31'})).json()
    assert default['reporting_currency'] == 'PLN' and Decimal(default['total_expense']) == 900

    for currency, expected in [('PLN', '900'), ('USD', '450'), ('EUR', '200')]:
        result = await client.get('/cash-flow', params={'start_date': '2025-01-01', 'end_date': '2025-01-31', 'currency': currency})
        assert result.status_code == 200, result.text
        body = result.json()
        assert body['reporting_currency'] == currency
        assert Decimal(body['total_expense']) == Decimal(expected)
        assert sum(Decimal(p['expense']) for p in body['points']) == Decimal(expected)

    after = (await client.get('/backup/export')).json()
    for key in ('app_settings', 'accounts', 'transactions', 'fx_rates'):
        assert before[key] == after[key]


async def test_reports_category_spending_and_ranking_respect_currency_param(client, categories):
    await client.patch('/settings', json={'currency': 'PLN'})
    eur = await account(client, 'EUR')
    groceries = categories['Groceries']['id']
    for day, value in [('2025-01-03', '4'), ('2025-01-17', '5')]:
        await rate(client, day, value=value)
        await rate(client, day, base='USD', value='2')
        await tx(client, eur, date=day, category_id=groceries)
    await rate(client, date.today(), value='9')

    for currency, expected in [('PLN', '900'), ('USD', '450'), ('EUR', '200')]:
        spending = await client.get('/reports/category-spending', params={
            'category_id': groceries, 'start_date': '2025-01-01', 'end_date': '2025-01-31', 'currency': currency,
        })
        assert spending.status_code == 200, spending.text
        assert spending.json()['reporting_currency'] == currency
        assert Decimal(spending.json()['total_amount']) == Decimal(expected)

        ranking = await client.get('/reports/category-ranking', params={
            'kind': 'expense', 'start_date': '2025-01-01', 'end_date': '2025-01-31', 'currency': currency,
        })
        assert ranking.status_code == 200, ranking.text
        assert ranking.json()['reporting_currency'] == currency
        assert Decimal(ranking.json()['total_amount']) == Decimal(expected)
        matching = next(item for item in ranking.json()['items'] if item['category_id'] == groceries)
        assert Decimal(matching['amount']) == Decimal(expected)


@pytest.mark.parametrize('path,needs_category', [
    ('/cash-flow', False),
    ('/reports/category-spending', True),
    ('/reports/category-ranking', False),
])
async def test_missing_historical_rate_is_an_explicit_error_not_zero_or_one_to_one(client, categories, path, needs_category):
    await client.patch('/settings', json={'currency': 'PLN'})
    eur = await account(client, 'EUR')
    await tx(client, eur, date=str(date.today()), category_id=categories['Groceries']['id'])
    # No FX rate exists for today at all — every one of these must surface
    # the same explicit error, never silently report 0 or an unconverted 1:1.
    params = {'category_id': categories['Groceries']['id']} if needs_category else {}
    response = await client.get(path, params=params)
    assert response.status_code == 409, response.text
    assert response.json()['detail']['code'] == 'FX_RATE_MISSING'


@pytest.mark.parametrize('path,extra', [
    ('/cash-flow', {}),
    ('/reports/category-ranking', {}),
])
async def test_invalid_currency_query_param_is_rejected(client, path, extra):
    response = await client.get(path, params={**extra, 'currency': 'INVALID'})
    assert response.status_code == 422


async def test_two_same_day_exchanges_keep_their_own_rate_regardless_of_report_currency(client, categories):
    """Two currency exchanges (transfers with an explicit destination_amount)
    on the same day, at different actual rates — a classic FX-model edge
    case (see test_multicurrency.py's own version of this). Requesting Cash
    Flow/Reports in a different display currency must not disturb either
    transfer's own recorded rate, and must not derive a new global FX rate
    from either of them."""
    await client.patch('/settings', json={'currency': 'PLN'})
    usd, pln = await account(client, 'USD'), await account(client, 'PLN')
    await rate(client, date.today(), base='USD', value='4')
    await tx(client, usd, type='income', amount='1000')
    first = await tx(client, usd, type='transfer', transfer_account_id=pln, destination_amount='360')
    second = await tx(client, usd, type='transfer', transfer_account_id=pln, destination_amount='380')
    # An ordinary expense, in a *third* currency, is what Cash Flow/Reports
    # actually aggregate — the two transfers above are deliberately excluded
    # from both (see cash_flow_service.py/reports_service.py: only
    # income/expense contribute), so this is what a currency switch should
    # visibly move.
    eur = await account(client, 'EUR')
    await rate(client, date.today(), base='EUR', value='5')
    await tx(client, eur, category_id=categories['Groceries']['id'])
    before_fx_rates = (await client.get('/fx-rates')).json()

    for currency in ('PLN', 'USD', 'EUR'):
        cash_flow = await client.get('/cash-flow', params={'currency': currency})
        assert cash_flow.status_code == 200, cash_flow.text
        ranking = await client.get('/reports/category-ranking', params={'kind': 'expense', 'currency': currency})
        assert ranking.status_code == 200, ranking.text

    assert (await client.get('/fx-rates')).json() == before_fx_rates
    backup = (await client.get('/backup/export')).json()
    transfers = {row['id']: row for row in backup['transactions']}
    assert Decimal(transfers[first['id']]['destination_amount']) == Decimal('360')
    assert Decimal(transfers[second['id']]['destination_amount']) == Decimal('380')
    balances = {row['id']: Decimal(row['balance']) for row in (await client.get('/accounts')).json()}
    # 1000 income, minus each transfer's own native (source-leg) amount —
    # unaffected by destination_amount, which only sets what PLN receives.
    assert balances[usd] == 800 and balances[pln] == 740
