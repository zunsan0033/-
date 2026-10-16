'use strict';
// Layout of 今月の食費: no horizontal scroll and nothing outside the card at phone widths, also with ¥10,000,000 and larger amounts.
// usage: node layout_food_budget.cjs --app <folder or zip> [--out <result folder>]   (screenshots are written to <out>/screens when --out is given)
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.cjs');
const KEY = 'kakeibo_food_budget_v1';

const STATES = [
  { name: 'unset', budget: null, rows: [] },
  { name: 'normal', budget: 30000, rows: [[12345, '食費']] },
  { name: 'budget-10m-unused', budget: 10000000, rows: [] },
  { name: 'budget-10m-warm', budget: 10000000, rows: [[9999999, '食費']] },
  { name: 'over-huge', budget: 10000000, rows: [[100000000, '食費'], [100000000, '食費'], [99999999, '食費']] },
  { name: 'editor-10m', budget: 10000000, rows: [[5000, '食費']], edit: '10000000' },
  { name: 'editor-error', budget: 30000, rows: [], edit: '10000001', submit: true },
];

async function main() {
  const args = H.parseArgs(process.argv.slice(2));
  const appDir = H.appDirFromArgs(args);
  const shots = args.out ? path.resolve(process.cwd(), args.out, 'screens') : null; if (shots) fs.mkdirSync(shots, { recursive: true });
  const srv = await H.startServer(appDir), browser = await H.launch();
  const R = H.makeRunner('layout_food_budget');

  for (const width of [320, 375, 390, 430]) {
    for (const st of STATES) {
      await R.test(`${width}px ${st.name}: no horizontal scroll, the card holds its contents`, async () => {
        const { ctx, page } = await H.newPage(browser, { viewport: { width, height: 844 }, clock: new Date('2026-10-16T10:00:00+09:00') });
        await H.openApp(page, srv.url);
        await page.evaluate(async ([k, b, rows]) => {
          if (b) localStorage.setItem(k, JSON.stringify({ amount: b, updatedAt: 1 })); else localStorage.removeItem(k);
          const T = window.__KAKEIBO_TEST__; let i = 0; for (const [a, c] of rows) await T.putExpense({ id: `L${i++}`, date: '2026-10-05', store: c, amount: a, category: c, items: [], source: 'manual', createdAt: i });
          await T.refreshAggregates();
        }, [KEY, st.budget, st.rows]);
        if (st.edit) { await page.click('#foodBudgetView [data-fb-edit]'); await page.fill('#foodBudgetInput', st.edit); if (st.submit) await page.click('#foodBudgetForm button[type="submit"]'); await page.evaluate(() => document.activeElement && document.activeElement.blur()); }
        await page.waitForTimeout(50);
        const m = await page.evaluate(() => {
          const card = document.querySelector('#foodBudgetCard'), cr = card.getBoundingClientRect(), bad = [];
          for (const el of card.querySelectorAll('*')) {
            if (el.closest('.hidden')) continue;
            const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
            if (r.left < cr.left - 0.5 || r.right > cr.right + 0.5) bad.push(`${el.className || el.tagName} ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(cr.left)}..${Math.round(cr.right)}`);
            if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && el.tagName !== 'INPUT') bad.push(`${el.className || el.tagName} scrolls`);
          }
          // text that does not fit its own box (a number wider than the line). A negative margin (the larger tap area of .text-btn) is the
          // element's own choice and is taken off; the element must still be inside the card (checked above)
          for (const el of card.querySelectorAll('.fb-amount,.fb-line,.fb-top,.fb-empty,.fb-actions,.fb-input-row')) { const r = el.getBoundingClientRect(); for (const c of el.children) { const q = c.getBoundingClientRect(), mr = Math.min(0, parseFloat(getComputedStyle(c).marginRight) || 0); if (q.width && q.right + mr > r.right + 0.5) bad.push(`${c.className} wider than ${el.className}`); } }
          const de = document.documentElement;
          return { scroll: Math.max(de.scrollWidth, document.body.scrollWidth) - window.innerWidth, bad, text: card.innerText.replace(/\s+/g, ' ').trim() };
        });
        if (shots && (width === 375 || width === 320)) await page.locator('#foodBudgetCard').screenshot({ path: path.join(shots, `card-${width}-${st.name}.png`) });
        if (shots && width === 375 && st.name === 'normal') await page.screenshot({ path: path.join(shots, `home-375-normal.png`) });
        H.eq(m.scroll <= 0, true, `horizontal scroll of ${m.scroll}px`);
        H.eq(m.bad, [], 'elements outside the card');
        H.eq(page._errors, []);
        await ctx.close();
      });
    }
  }

  await browser.close(); await srv.close();
  const sum = R.finish(); H.writeResult(args, 'layout_food_budget', sum); return sum;
}

if (require.main === module) main().then(s => process.exit(s.fail ? 1 : 0)).catch(e => { console.error(e); process.exit(2); });
module.exports = main;
