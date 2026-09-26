"""GET /assets' capital_value equivalent: same FXConverter/date net worth
uses, explicit about what it can't convert, never a fabricated 0 or 1:1."""
from datetime import date, timedelta
from decimal import Decimal


async def make_asset(client, **fields):
    payload = dict(name='Synthetic asset', asset_class='other', currency='USD', value='100', as_of_date=str(date.today()))
    payload.update(fields)
    response = await client.post('/assets', json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def rate(client, base, quote, value, day=None):
    response = await client.post('/fx-rates/bulk', json={'items': [
        dict(base_currency=base, quote_currency=quote, rate_date=str(day or date.today()), rate=value)
    ]})
    assert response.status_code == 200, response.text


async def by_name(client, name):
    items = (await client.get('/assets')).json()
    return next(a for a in items if a['name'] == name)


async def test_capital_value_reorders_assets_a_native_amount_sort_would_get_wrong(client):
    await client.patch('/settings', json={'currency': 'USD'})
    await rate(client, 'EUR', 'USD', '1.10')
    await rate(client, 'PLN', 'USD', '0.25')
    # Native amounts alone would rank "Big PLN" first (20 > 10) — its real
    # capital equivalent (5 USD) is actually the smaller of the two.
    await make_asset(client, name='Small EUR', currency='EUR', value='10')
    await make_asset(client, name='Big PLN', currency='PLN', value='20')

    small = await by_name(client, 'Small EUR')
    big = await by_name(client, 'Big PLN')
    assert small['capital_currency'] == big['capital_currency'] == 'USD'
    assert Decimal(small['capital_value']) == Decimal('11.00')
    assert Decimal(big['capital_value']) == Decimal('5.00')
    assert Decimal(small['capital_value']) > Decimal(big['capital_value'])
    # Native fields keep their prior, currency-unaware meaning untouched.
    assert Decimal(small['current_value']) == 10 and small['currency'] == 'EUR'
    assert Decimal(big['current_value']) == 20 and big['currency'] == 'PLN'


async def test_zero_valuation_is_a_real_convertible_zero_not_missing(client):
    asset = await make_asset(client, name='Zeroed out', value='0')
    assert asset['capital_value_error'] is None
    assert Decimal(asset['capital_value']) == 0


async def test_future_only_valuation_has_no_capital_value_yet(client):
    tomorrow = str(date.today() + timedelta(days=1))
    asset = await make_asset(client, name='Not valued yet', value='500', as_of_date=tomorrow)
    fetched = await by_name(client, 'Not valued yet')
    assert Decimal(fetched['current_value']) == 0  # unchanged pre-existing fallback
    assert fetched['capital_value'] is None
    assert fetched['capital_value_error'] == 'no_valuation'


async def test_missing_fx_rate_is_explicit_and_does_not_break_other_assets(client):
    await client.patch('/settings', json={'currency': 'USD'})
    await make_asset(client, name='Has a rate', currency='EUR', value='10')
    await rate(client, 'EUR', 'USD', '1.10')
    await make_asset(client, name='No rate at all', currency='GBP', value='10')

    response = await client.get('/assets')
    assert response.status_code == 200, response.text
    items = {a['name']: a for a in response.json()}
    assert items['Has a rate']['capital_value_error'] is None
    assert Decimal(items['Has a rate']['capital_value']) == Decimal('11.00')
    assert items['No rate at all']['capital_value'] is None
    assert items['No rate at all']['capital_value_error'] == 'fx_rate_missing'


async def test_capital_value_matches_this_assets_own_contribution_to_the_net_worth_total(client):
    await client.patch('/settings', json={'currency': 'USD'})
    await rate(client, 'EUR', 'USD', '1.25')
    await make_asset(client, name='Cross-checked', currency='EUR', value='40')

    asset = await by_name(client, 'Cross-checked')
    summary = (await client.get('/net-worth/summary')).json()
    assert Decimal(asset['capital_value']) == Decimal('50.00')
    assert Decimal(summary['current']) == Decimal(asset['capital_value'])
    assert summary['reporting_currency'] == asset['capital_currency']


async def test_capital_currency_follows_the_requested_reporting_currency_override(client):
    await client.patch('/settings', json={'currency': 'USD'})
    await rate(client, 'EUR', 'USD', '1.10')
    await rate(client, 'EUR', 'PLN', '4.00')
    await make_asset(client, name='Overridden', currency='EUR', value='10')

    default_currency = await by_name(client, 'Overridden')
    assert default_currency['capital_currency'] == 'USD'
    assert Decimal(default_currency['capital_value']) == Decimal('11.00')

    overridden = (await client.get('/assets', params={'currency': 'PLN'})).json()
    overridden_asset = next(a for a in overridden if a['name'] == 'Overridden')
    assert overridden_asset['capital_currency'] == 'PLN'
    assert Decimal(overridden_asset['capital_value']) == Decimal('40.00')
    # The override is request-scoped only — stored settings/native fields stand.
    assert Decimal(overridden_asset['current_value']) == 10 and overridden_asset['currency'] == 'EUR'
