"""Assets retain their own currency and dated value through edits and restore."""
from datetime import date,timedelta
from decimal import Decimal

async def test_future_valuation_does_not_change_current_capital(client):
    response=await client.post('/assets',json=dict(name='Synthetic equipment',asset_class='other',currency='USD',value='100',as_of_date=str(date.today())))
    assert response.status_code==201,response.text
    a=response.json();aid=a['id']
    assert (await client.post(f'/assets/{aid}/valuations',json=dict(value='999',as_of_date=str(date.today()+timedelta(days=1))))).status_code==200
    assert Decimal((await client.get('/assets')).json()[0]['current_value'])==100
    assert Decimal((await client.get('/net-worth/summary')).json()['current'])==100
    assert (await client.patch(f'/assets/{aid}',json={'currency':'EUR'})).status_code==409
    backup=(await client.get('/backup/export')).json()
    assert (await client.post('/backup/import',json=backup)).status_code==200
    assert Decimal((await client.get('/net-worth/summary')).json()['current'])==100

async def test_asset_valuation_upsert_and_delete(client):
    a=(await client.post('/assets',json=dict(name='Synthetic asset',asset_class='other',value='100',currency='USD'))).json()
    for amount in ['200','250']:
        response=await client.post(f"/assets/{a['id']}/valuations",json=dict(value=amount,as_of_date=str(date.today())))
        assert response.status_code==200,response.text
    backup=(await client.get('/backup/export')).json()
    assert len(backup['asset_valuations'])==1 and Decimal(backup['asset_valuations'][0]['value'])==250
    assert (await client.delete(f"/assets/{a['id']}")).status_code==204
    assert Decimal((await client.get('/net-worth/summary')).json()['current'])==0
    assert not (await client.get('/backup/export')).json()['asset_valuations']
