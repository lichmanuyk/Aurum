from decimal import Decimal
from datetime import date
import httpx
from app.services import crypto_service
from tests.test_crypto import _fake_fetch, _point

async def test_opening_unknown_cost_survives_trades_and_backup(client, monkeypatch):
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('100')}))
    response = await client.post('/crypto/holdings', json=dict(coingecko_id='bitcoin', symbol='BTC', name='Bitcoin', quantity='2', date='2026-01-01'))
    assert response.status_code == 201, response.text
    h=response.json(); aid=h['asset_id']
    assert Decimal(h['value']) == 200 and h['cost_basis'] is None and h['profit_loss'] is None
    trades=(await client.get(f'/crypto/holdings/{aid}/transactions')).json()
    assert trades[0]['type']=='opening' and trades[0]['price_per_unit'] is None
    for kind,qty in [('buy','1'),('sell','1')]:
        response=await client.post(f'/crypto/holdings/{aid}/transactions', json=dict(type=kind, quantity=qty, price_per_unit='80', date='2026-01-02'))
        assert response.status_code==201,response.text
        assert response.json()['cost_basis'] is None
    backup=(await client.get('/backup/export')).json()
    assert backup['aurum_backup_version']==7
    assert (await client.post('/backup/import',json=backup)).status_code==200
    h=(await client.get('/crypto/holdings')).json()['holdings'][0]
    assert Decimal(h['quantity'])==2 and h['profit_loss'] is None
    response=await client.post(f'/crypto/holdings/{aid}/transactions',json=dict(type='sell',quantity='2',price_per_unit='90',date='2026-01-03'))
    assert response.status_code==201
    response=await client.post(f'/crypto/holdings/{aid}/transactions',json=dict(type='buy',quantity='1',price_per_unit='80',date='2026-01-04'))
    assert Decimal(response.json()['cost_basis'])==80

async def test_buy_cannot_omit_price_and_opening_cannot_invent_it(client,monkeypatch):
    monkeypatch.setattr(crypto_service,'_fetch_market_data',_fake_fetch({'bitcoin':_point('100')}))
    h=(await client.post('/crypto/holdings',json=dict(coingecko_id='bitcoin',symbol='BTC',name='Bitcoin',quantity='1',date='2026-01-01'))).json()
    for payload in [dict(type='buy',quantity='1'),dict(type='opening',quantity='1',price_per_unit='100')]:
        response=await client.post(f"/crypto/holdings/{h['asset_id']}/transactions",json={**payload,'date':'2026-01-02'})
        assert response.status_code==422,response.text

async def test_opening_quantity_tracks_live_capital_and_retains_last_price_on_outage(client, monkeypatch):
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('100')}))
    created = await client.post('/crypto/holdings', json=dict(
        coingecko_id='bitcoin', symbol='BTC', name='Bitcoin', quantity='2', date=str(date.today())))
    assert created.status_code == 201, created.text
    holding = created.json()
    assert Decimal(holding['quantity']) == 2
    assert holding['cost_basis'] is None and holding['profit_loss'] is None
    assert Decimal(holding['value']) == 200
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 200

    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('125')}))
    refreshed = (await client.post('/crypto/refresh')).json()
    assert refreshed['synced'] is True
    assert Decimal(refreshed['holdings'][0]['quantity']) == 2
    assert Decimal(refreshed['holdings'][0]['value']) == 250
    assert refreshed['holdings'][0]['cost_basis'] is None
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 250

    async def unavailable(*_args):
        raise httpx.ConnectError('simulated CoinGecko outage')

    monkeypatch.setattr(crypto_service, '_fetch_market_data', unavailable)
    failed = (await client.post('/crypto/refresh')).json()
    assert failed['synced'] is False and failed['error_key'] == 'unreachable'
    assert Decimal(failed['holdings'][0]['value']) == 250
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 250
