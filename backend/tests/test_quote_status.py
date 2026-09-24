from datetime import date, timedelta, datetime, timezone

import pytest
from app.models.crypto import CryptoSyncState
from tests.test_multicurrency import account, rate
from tests.test_crypto import _add_bitcoin, _fake_fetch, _point
from app.services import crypto_service


@pytest.mark.parametrize('age,status', [(0, 'current'), (2, 'previous'), (7, 'previous'), (8, 'missing'), (-1, 'missing')])
async def test_fx_status_uses_publication_date_not_download_time(client, age, status):
    await client.patch('/settings', json={'currency': 'PLN'})
    await account(client, 'EUR')
    await rate(client, date.today() - timedelta(days=age), value='4.3')
    response = await client.get('/fx-rates/status')
    assert response.status_code == 200
    item = next(x for x in response.json()['fx'] if x['currency'] == 'EUR')
    assert item['status'] == status
    assert (item['rate_date'] is None) == (status == 'missing')
    if status != 'missing':
        assert item['rate_date'] == str(date.today() - timedelta(days=age))
        assert item['saved_at'] and item['sources'] == ['manual']


async def test_fx_status_resolves_same_date_pivot(client):
    await client.patch('/settings', json={'currency': 'USD'})
    await account(client, 'EUR')
    day = date.today() - timedelta(days=2)
    await rate(client, day, value='4.3')
    await rate(client, day, base='USD', value='4')
    item = next(x for x in (await client.get('/fx-rates/status')).json()['fx'] if x['currency'] == 'EUR')
    assert item['status'] == 'previous' and item['rate_date'] == str(day)


async def test_crypto_status_is_read_only_and_reports_staleness(client, monkeypatch, test_sessionmaker):
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('50000')}))
    await _add_bitcoin(client)
    async with test_sessionmaker() as session:
        state = await session.get(CryptoSyncState, 1)
        state.last_synced_at = datetime.now(timezone.utc) - timedelta(hours=25)
        await session.commit()
    async def forbidden(*args):
        raise AssertionError('Status must not refresh prices')
    monkeypatch.setattr(crypto_service, '_fetch_market_data', forbidden)
    status = (await client.get('/fx-rates/status')).json()['crypto']
    assert status['status'] == 'stale' and status['missing_prices'] == 0


async def test_incomplete_crypto_refresh_does_not_claim_full_success(client, monkeypatch):
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('50000')}))
    await _add_bitcoin(client)
    before = (await client.get('/fx-rates/status')).json()['crypto']['last_synced_at']
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({}))
    refresh = (await client.post('/crypto/refresh')).json()
    assert refresh['error_key'] == 'incomplete' and not refresh['synced']
    assert datetime.fromisoformat(refresh['last_synced_at']) == datetime.fromisoformat(before)
    assert float(refresh['holdings'][0]['current_price']) == 50000


async def test_adding_coin_does_not_refresh_other_coins_timestamp(client, monkeypatch):
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('50000')}))
    await _add_bitcoin(client)
    before = (await client.get('/fx-rates/status')).json()['crypto']['last_synced_at']
    await _add_bitcoin(client)
    assert (await client.get('/fx-rates/status')).json()['crypto']['last_synced_at'] == before


async def test_automatic_nbp_refresh_is_recent_and_preserves_manual_rates(client, monkeypatch):
    from app.services import nbp_service
    await client.patch('/settings', json={'currency': 'PLN'})
    await account(client, 'EUR')
    await rate(client, date.today(), value='4.3')
    before = (await client.get('/fx-rates')).json()
    async def fetch(currencies, start, end):
        assert 'EUR' in currencies
        assert end == date.today() and start == end - timedelta(days=14)
        return [dict(base_currency='EUR', quote_currency='PLN', rate_date=end, rate='4.9', source='NBP:A:test')]
    monkeypatch.setattr(nbp_service, 'fetch_rates', fetch)
    result = await client.post('/fx-rates/nbp/latest')
    assert result.status_code == 200 and result.json()['protected'] == 1
    assert (await client.get('/fx-rates')).json() == before
