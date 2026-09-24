import { expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CryptoStatsRow } from './CryptoStatsRow';
import { makeHolding } from '@/test/cryptoFixtures';

it('does not report market value as profit when acquisition cost is unknown',()=>{
 const container=document.createElement('div');const root=createRoot(container);
 try {
  flushSync(()=>root.render(<CryptoStatsRow holdings={[makeHolding({value:'9999',cost_basis:null,profit_loss:null,avg_buy_price:null})]} isLoading={false} hidden={false} range="all" performance90d={undefined} isPerformance90dLoading={false}/>));
  expect(container.textContent).not.toContain('9999');
  expect(container.textContent).toMatch(/Цена покупки неизвестна|Purchase cost unknown/);
 } finally {flushSync(()=>root.unmount());}
});
