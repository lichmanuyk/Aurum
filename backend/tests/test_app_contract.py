"""Every major read surface remains usable on a freshly migrated empty ledger."""
import pytest

@pytest.mark.parametrize('path',[
    '/accounts','/categories','/tags','/transactions','/assets','/goals','/budgets',
    '/budgets/status?year=2026&month=9','/recurring','/settings','/backup/export',
    '/dashboard/summary?year=2026&month=9','/cash-flow','/reports/category-ranking',
    '/net-worth/summary?range=all','/advice','/insights/alerts','/fx-rates',
    '/fx-rates/preflight','/fx-rates/coverage','/crypto/portfolios','/crypto/holdings',
    '/crypto/history?range=all'])
async def test_read_surfaces_on_empty_ledger(client,path):
    response=await client.get(path)
    assert response.status_code==200,response.text
