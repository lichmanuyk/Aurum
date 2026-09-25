"""Savings goals: contribution rules.

The contribution log accepts negative amounts on purpose (taking money back
out of a goal is still an entry in its running total), which is exactly why
zero has to be rejected explicitly rather than by a `gt=0` constraint.
"""
from httpx import AsyncClient
from datetime import date, timedelta

from tests.helpers import money


async def _goal(client: AsyncClient) -> dict:
    return (await client.post("/goals", json={"name": "Emergency fund", "target_amount": "1000"})).json()


async def test_zero_contribution_is_rejected(client: AsyncClient):
    goal = await _goal(client)

    resp = await client.post(f"/goals/{goal['id']}/contributions", json={"amount": "0", "date": "2026-01-15"})

    assert resp.status_code == 422
    assert money((await client.get("/goals")).json()[0]["current_amount"]) == money(0)


async def test_negative_contribution_is_allowed(client: AsyncClient):
    """Withdrawing from a goal is a legitimate entry — the zero check must not
    turn into a positive-only constraint."""
    goal = await _goal(client)
    await client.post(f"/goals/{goal['id']}/contributions", json={"amount": "250", "date": "2026-01-15"})

    resp = await client.post(f"/goals/{goal['id']}/contributions", json={"amount": "-100", "date": "2026-02-01"})

    assert resp.status_code == 201
    assert money(resp.json()["current_amount"]) == money("150")


async def test_goal_progress_does_not_move_cash_and_asset_value_starts_on_its_date(client, account_id):
    today = date.today()
    opening = await client.post('/transactions', json={
        'account_id': account_id, 'type': 'adjustment', 'amount': '1000',
        'adjustment_reason': 'opening_balance', 'description': 'Opening cash', 'date': str(today),
    })
    assert opening.status_code == 201, opening.text
    goal = await client.post('/goals', json={'name': 'Synthetic goal', 'currency': 'USD', 'target_amount': '500'})
    assert goal.status_code == 201, goal.text
    contributed = await client.post(f"/goals/{goal.json()['id']}/contributions", json={'amount': '300', 'date': str(today)})
    assert contributed.status_code == 201, contributed.text
    assert money(contributed.json()['current_amount']) == 300
    assert money((await client.get('/accounts')).json()[0]['balance']) == 1000
    assert money((await client.get('/net-worth/summary')).json()['current']) == 1000
    assert money((await client.get('/cash-flow')).json()['total_expense']) == 0

    asset = await client.post('/assets', json={
        'name': 'Synthetic asset', 'asset_class': 'other', 'currency': 'USD',
        'value': '200', 'as_of_date': str(today),
    })
    assert asset.status_code == 201, asset.text
    asset_id = asset.json()['id']
    assert money((await client.get('/net-worth/summary')).json()['current']) == 1200
    future = await client.post(f'/assets/{asset_id}/valuations', json={
        'value': '250', 'as_of_date': str(today + timedelta(days=1)),
    })
    assert future.status_code == 200, future.text
    assert money(future.json()['current_value']) == 200
    assert money((await client.get('/net-worth/summary')).json()['current']) == 1200
    current = await client.post(f'/assets/{asset_id}/valuations', json={'value': '220', 'as_of_date': str(today)})
    assert current.status_code == 200, current.text
    assert money((await client.get('/net-worth/summary')).json()['current']) == 1220
    assert money((await client.get('/accounts')).json()[0]['balance']) == 1000
