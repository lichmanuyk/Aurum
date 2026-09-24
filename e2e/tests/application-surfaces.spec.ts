import { test, expect } from '@playwright/test';

for (const width of [1440,375]) {
  test(`major application pages render without runtime errors at ${width}px`, async ({page}) => {
    test.setTimeout(90000);
    await page.setViewportSize({width,height:900});
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('response',r=>{if(r.url().includes('/api/') && r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
    for(const path of ['/', '/accounts','/transactions','/categories','/cash-flow','/reports','/budget','/recurring','/goals','/net-worth','/crypto','/roi','/transactions/import','/advice','/settings']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),path).toBeTruthy();
    }
    expect(errors).toEqual([]);
  });
}

test('missing historical FX is visible and links to settings',async({page})=>{
  await page.route('**/api/net-worth/summary?*',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{code:'FX_RATE_MISSING',base_currency:'EUR',quote_currency:'USD',date:'2026-01-02'}})}));
  await page.goto('/net-worth');
  const alert=page.getByRole('alert').filter({hasText:'EUR → USD'});
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('link')).toHaveAttribute('href','/settings');
});
