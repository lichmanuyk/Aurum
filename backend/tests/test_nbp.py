"""NBP fixtures are public-shaped synthetic quotations; no network in tests."""
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace
import pytest
import httpx
from fastapi import HTTPException
from app.services import nbp_service
from app.services.nbp_service import parse_tables
from app.services.fx_service import FXConverter


def document(table='A', day='2025-01-02', rates=None):
    return [{'table':table,'no':f'001/{table}/NBP/2025','effectiveDate':day,
             'rates':rates or [{'code':'EUR','mid':Decimal('4.25')},{'code':'IDR','mid':Decimal('0.00025')},{'code':'USD','mid':Decimal('4')}]}]


def test_nbp_one_unit_normalization_and_pln_cross():
    rows=parse_tables(document(),'A',{'EUR','USD','IDR'},date(2025,1,1),date(2025,1,3))
    bycode={r['base_currency']:r for r in rows}
    assert bycode['IDR']['rate']==Decimal('.00025')
    assert bycode['PLN']['quote_currency']=='USD' and bycode['PLN']['rate']==Decimal('.25')
    fx=FXConverter([SimpleNamespace(**r) for r in rows],'USD')
    assert fx.convert(Decimal('100'),'EUR',date(2025,1,2))==Decimal('106.25')
    assert len(fx.metadata())==2
    assert all(item['source'].startswith('NBP:A:') for item in fx.metadata())


@pytest.mark.parametrize('payload', [document(day='2026-01-01'),document(table='B'),document(rates=[{'code':'EUR','mid':0}]),document()*2])
def test_reject_invalid_response_before_any_write(payload):
    with pytest.raises(ValueError):
        parse_tables(payload,'A',{'EUR'},date(2025,1,1),date(2025,1,3))


async def test_nbp_import_idempotent_protects_manual_and_roundtrips(client,monkeypatch):
    rows=parse_tables(document(),'A',{'EUR','USD','IDR'},date(2025,1,1),date(2025,1,3))
    async def fetch(*args):return rows
    monkeypatch.setattr(nbp_service,'fetch_rates',fetch)
    manual={'base_currency':'EUR','quote_currency':'PLN','rate_date':'2025-01-02','rate':'9','source':'manual'}
    assert (await client.post('/fx-rates/bulk',json={'items':[manual]})).status_code==200
    payload=dict(start_date='2025-01-01',end_date='2025-01-03',currencies=['EUR','USD','IDR'])
    for _ in range(2):
        response=await client.post('/fx-rates/nbp',json=payload)
        assert response.status_code==200,response.text
        assert response.json()['saved']==2 and response.json()['protected']==1
    rates=(await client.get('/fx-rates')).json()
    assert len(rates)==3
    assert Decimal(next(r for r in rates if r['base_currency']=='EUR')['rate'])==9
    backup=(await client.get('/backup/export')).json()
    assert (await client.post('/backup/import',json=backup)).status_code==200
    assert len((await client.get('/fx-rates')).json())==3


async def test_nbp_request_limits_and_failure_do_not_write(client,monkeypatch):
    bad=[dict(start_date='2025-01-01',end_date='2025-05-01',currencies=['EUR']),
         dict(start_date=str(date.today()),end_date=str(date.today()+timedelta(days=1)),currencies=['EUR'])]
    for payload in bad:
        assert (await client.post('/fx-rates/nbp',json=payload)).status_code==422
    async def fail(*args):raise HTTPException(502,'Synthetic unavailable')
    monkeypatch.setattr(nbp_service,'fetch_rates',fail)
    assert (await client.post('/fx-rates/nbp',json=dict(start_date='2025-01-01',end_date='2025-01-03',currencies=['EUR']))).status_code==502
    assert (await client.get('/fx-rates')).json()==[]


async def test_plan_includes_archived_and_pre_history_window(client,account_id):
    foreign=(await client.post('/accounts',json={'name':'Synthetic archive','currency':'BYN'})).json()['id']
    await client.patch(f'/accounts/{foreign}',json={'is_archived':True})
    await client.post('/transactions',json={'account_id':account_id,'type':'income','amount':'1','date':'2025-01-02','description':'Synthetic'})
    result=(await client.get('/fx-rates/nbp/plan')).json()
    assert 'BYN' in result['currencies'] and 'USD' in result['currencies']
    assert result['start_date']=='2024-12-26'
    coverage=(await client.get('/fx-rates/coverage')).json()
    assert not coverage['complete'] and next(i for i in coverage['items'] if i['currency']=='BYN')['missing_days']>0


async def test_plan_and_coverage_never_demand_byn_rub_history_without_real_usage(client, account_id):
    """The Dashboard's rate-overview card (see
    docs/tasks/fx-rate-overview.md) wants BYN/RUB over a short recent
    window regardless of accounts — but the full-history plan/coverage
    check must not be told they're needed for years back just because of
    that card, when nothing in the ledger actually uses either."""
    await client.post('/transactions', json={'account_id': account_id, 'type': 'income', 'amount': '1', 'date': '2025-01-02', 'description': 'Synthetic'})
    plan = (await client.get('/fx-rates/nbp/plan')).json()
    assert 'BYN' not in plan['currencies'] and 'RUB' not in plan['currencies']
    coverage = (await client.get('/fx-rates/coverage')).json()
    assert not any(item['currency'] in ('BYN', 'RUB') for item in coverage['items'])


async def test_nbp_latest_still_refreshes_byn_and_rub_with_no_account_in_either(client, monkeypatch):
    captured = {}
    async def fetch(currencies, start, end):
        captured['currencies'] = set(currencies)
        return []
    monkeypatch.setattr(nbp_service, 'fetch_rates', fetch)
    response = await client.post('/fx-rates/nbp/latest')
    assert response.status_code == 200, response.text
    assert {'BYN', 'RUB'} <= captured['currencies']


async def test_nbp_http_404_is_missing_and_mid_parses_without_binary_float(monkeypatch):
    real=httpx.AsyncClient
    async def handler(request):
        if '/B/' in str(request.url):return httpx.Response(404)
        return httpx.Response(200,text='[{"table":"A","no":"001/A/NBP/2025","effectiveDate":"2025-01-02","rates":[{"code":"IDR","mid":0.00027197}]}]')
    monkeypatch.setattr(nbp_service.httpx,'AsyncClient',lambda **kwargs:real(transport=httpx.MockTransport(handler),**kwargs))
    rows=await nbp_service.fetch_rates(['IDR','BYN'],date(2025,1,1),date(2025,1,3))
    assert len(rows)==1 and rows[0]['rate']==Decimal('.00027197')
