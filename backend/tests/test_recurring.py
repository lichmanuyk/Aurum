"""Posting must create one real movement, not duplicate or inactive payments."""
import asyncio
from datetime import date
from decimal import Decimal
import pytest
from app.models.enums import RecurringFrequency
from app.services.recurring_service import _advance

async def template(client, account_id, **changes):
    payload=dict(account_id=account_id,type='expense',amount='10',description='Synthetic subscription',frequency='monthly',anchor_date=str(date.today()))
    response=await client.post('/recurring',json={**payload,**changes})
    assert response.status_code==201,response.text
    return response.json()

@pytest.mark.parametrize('start,frequency,expected',[
    ('2024-01-31','monthly','2024-02-29'),('2025-01-31','monthly','2025-02-28'),
    ('2025-12-31','monthly','2026-01-31'),('2024-02-29','yearly','2025-02-28'),
    ('2025-12-29','weekly','2026-01-05')])
def test_calendar_boundaries(start,frequency,expected):
    assert str(_advance(date.fromisoformat(start),RecurringFrequency(frequency)))==expected

async def test_posting_is_atomic_and_rejects_double_click(client,account_id):
    t=await template(client,account_id)
    responses=await asyncio.gather(*(client.post(f"/recurring/{t['id']}/post") for _ in range(2)))
    assert sorted(r.status_code for r in responses)==[201,409]
    rows=(await client.get('/transactions')).json()
    assert rows['total']==1 and Decimal(rows['items'][0]['amount'])==10
    assert (await client.get('/recurring')).json()[0]['last_posted_date']==str(date.today())

async def test_inactive_post_cannot_move_money(client,account_id):
    t=await template(client,account_id)
    assert (await client.patch(f"/recurring/{t['id']}",json={'is_active':False})).status_code==200
    assert (await client.post(f"/recurring/{t['id']}/post")).status_code==409
    assert (await client.get('/transactions')).json()['total']==0

async def test_cross_currency_failed_post_preserves_schedule(client,account_id):
    target=(await client.post('/accounts',json=dict(name='Synthetic EUR',currency='EUR'))).json()['id']
    t=await template(client,account_id,type='transfer',transfer_account_id=target)
    assert (await client.post(f"/recurring/{t['id']}/post")).status_code==422
    assert (await client.get('/recurring')).json()[0]['last_posted_date'] is None
    response=await client.post(f"/recurring/{t['id']}/post",json={'destination_amount':'9.123456'})
    assert response.status_code==201,response.text
    row=(await client.get('/transactions')).json()['items'][0]
    assert Decimal(row['destination_amount'])==Decimal('9.123456')
    assert Decimal((await client.get('/cash-flow')).json()['total_expense'])==0

@pytest.mark.parametrize('field',['account_id','type','amount','description','frequency','anchor_date','is_active'])
async def test_null_required_patch_is_rejected_without_corruption(client,account_id,field):
    t=await template(client,account_id)
    before=(await client.get('/recurring')).json()[0]
    response=await client.patch(f"/recurring/{t['id']}",json={field:None})
    assert response.status_code==422,response.text
    assert (await client.get('/recurring')).json()[0]==before
