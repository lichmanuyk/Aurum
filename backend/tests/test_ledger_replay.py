"""An independent decimal ledger oracle catches drift across mixed movements."""
from datetime import date
from decimal import Decimal
from random import Random

async def test_mixed_ledger_replay_and_backup(client,account_id):
    other=(await client.post('/accounts',json={'name':'Synthetic reserve','currency':'USD'})).json()['id']
    balances={account_id:Decimal(0),other:Decimal(0)}
    income=expense=Decimal(0)
    rng=Random(417)
    for index in range(40):
        amount=Decimal(rng.randint(1,1000000))/Decimal(1000000)
        source,target=(account_id,other) if index%2 else (other,account_id)
        kind=['income','expense','transfer','adjustment'][index%4]
        payload=dict(account_id=source,type=kind,amount=str(amount),description='Synthetic replay',date=str(date.today()))
        if kind=='transfer':payload.update(transfer_account_id=target,destination_amount=str(amount));balances[target]+=amount
        if kind=='adjustment':payload['adjustment_reason']='reconciliation'
        response=await client.post('/transactions',json=payload)
        assert response.status_code==201,response.text
        balances[source]+=amount if kind in ('income','adjustment') else -amount
        if kind=='income':income+=amount
        if kind=='expense':expense+=amount
    for restored in (False,True):
        if restored:
            backup=(await client.get('/backup/export')).json()
            assert (await client.post('/backup/import',json=backup)).status_code==200
        actual={a['id']:Decimal(a['balance']) for a in (await client.get('/accounts')).json()}
        assert actual==balances
        flow=(await client.get('/cash-flow')).json()
        assert Decimal(flow['total_income'])==income and Decimal(flow['total_expense'])==expense
