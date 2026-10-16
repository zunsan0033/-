'use strict';
// Differential regression test: v1.10.20 and v1.11.0 are driven through the same steps (same clock, same inputs) and everything except the
// new card and the version must come out the same - screens (HTML and computed styles), receipt text reading and checks, saved records, manual
// entry, editing, deleting, calendar, graph, backup.
// usage: node regression_compare.cjs --app <v1.11.0 folder or zip> --base <v1.10.20 folder or zip> [--out <folder>]
const fs = require('fs');
const H = require('./lib/harness.cjs');

const RECEIPTS = [
  ['外税', 'スーパーマルエツ\n2026年10月14日(水) 18:22\n牛乳 ※ ¥198\n食パン ※ ¥158\n洗剤 ¥398\n小計 ¥754\n外税8%対象 ¥356\n外税8% ¥28\n外税10%対象 ¥398\n外税10% ¥39\n合計 ¥821\nお預り ¥1,000\nお釣り ¥179'],
  ['内税と値引', 'ローソン 渋谷店\n2026/10/15 12:01\nおにぎり 鮭 150\nからあげクン 238\n値引 -30\n合計 ¥358\n(内消費税等8% ¥26)'],
  ['2枚と取消', 'イオン\n2026年10月10日\nキャベツ 198\n豚肉 598\n鶏肉 498\n----- 区切り -----\n鶏肉 498\n取消 豚肉 -598\nティッシュ 298\n小計 ¥994\n合計 ¥994'],
  ['ガソリン', 'ENEOS\n2026/10/12\nレギュラー\n単価 ¥168\n30.00L × @168\n金額 ¥5,040\n合計 ¥5,040'],
  ['外食', 'すき家 新宿店\n2026/10/16\n牛丼 並 400\nみそ汁 80\n合計 ¥480'],
];
const SEED = [
  { id: 's1', date: '2026-10-01', store: 'スーパー', amount: 1100, category: 'レシート', items: [{ name: '牛乳', amount: 600, category: '食費' }, { name: '洗剤', amount: 400, category: '日用品' }], source: 'receipt', createdAt: 1, taxMeta: { exTax: 100 } },
  { id: 's2', date: '2026-10-05', store: 'ランチ', amount: 900, category: '外食', items: [], source: 'manual', createdAt: 2 },
  { id: 's3', date: '2026-09-20', store: '本屋', amount: 1500, category: '娯楽', items: [], source: 'manual', createdAt: 3 },
  { id: 's4', date: '2025-12-31', store: '年末', amount: 8000, category: '食費', items: [], source: 'manual', createdAt: 4 },
  { id: 's5', date: '2026-10-28', store: '予定', amount: 300, category: '食費', items: [], source: 'manual', createdAt: 5 },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{13}_[a-z0-9]+/g;
const norm = s => String(s).replace(UUID, '<id>').replace(/[0-9a-f]{32}/g, '<id>');
async function viewState(page, sel) {
  return page.evaluate(([s, u]) => {
    const root = document.querySelector(s); if (!root) return null; const c = root.cloneNode(true);
    const card = c.querySelector('#foodBudgetCard'); if (card) card.remove();   // the new card is compared by the other tests
    const vals = [...root.querySelectorAll('input,select,textarea')].filter(e => !e.closest('#foodBudgetCard')).map(e => `${e.id || e.dataset.k || e.name}=${e.type === 'checkbox' ? e.checked : e.value}`);
    return { html: c.innerHTML.replace(new RegExp(u, 'g'), '<id>').replace(/>\s+</g, '><'), vals };
  }, [sel, UUID.source]);
}
// computed styles of every element outside the new card (heights of the boxes that contain ホーム, and so the card, are left out)
async function styles(page) {
  return page.evaluate(() => {
    const out = [], card = document.querySelector('#foodBudgetCard');
    const props = ['display', 'position', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'backgroundImage', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderTopColor', 'borderRadius', 'gridTemplateColumns', 'gap', 'whiteSpace', 'textAlign', 'zIndex', 'opacity', 'boxShadow'];
    for (const el of document.querySelectorAll('body *')) {
      if (card && (el === card || card.contains(el))) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect(), holds = el.contains(document.querySelector('#homeView'));   // the same boxes in both versions
      out.push([el.tagName, el.id, el.className && el.className.baseVal === undefined ? el.className : '', ...props.map(p => cs[p]), Math.round(r.width), holds ? '-' : Math.round(r.height)].join('|'));
    }
    return out;
  });
}
// a saved record without what differs on every run: its id (random) and createdAt, row ids replaced by the position of the item
// (taxForRows is kept sorted by the random row id, so it is sorted again after the replacement)
function canon(x) {
  const c = JSON.parse(JSON.stringify(x)); delete c.createdAt; if (!/^s\d$/.test(c.id)) delete c.id;
  const ids = (c.items || []).map(i => i && i.rowId).filter(Boolean); let j = JSON.stringify(c);
  ids.forEach((id, i) => { j = j.split(JSON.stringify(id)).join(JSON.stringify(`row${i}`)); });
  const o = JSON.parse(j); if (o.taxMeta && Array.isArray(o.taxMeta.taxForRows)) o.taxMeta.taxForRows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return JSON.stringify(o);
}
async function records(page) {
  return (await page.evaluate(() => window.__KAKEIBO_TEST__.allExpenses())).map(canon).sort();
}

async function main() {
  const args = H.parseArgs(process.argv.slice(2));
  const appDir = H.appDirFromArgs(args);
  const R = H.makeRunner('regression_compare');
  if (!args.base) { R.skip('v1.10.20 との比較', '--base <v1.10.20 のフォルダかZIP> を指定すると実行します'); const s = R.finish(); H.writeResult(args, 'regression_compare', s); return s; }
  const baseDir = H.resolveAppDir(args.base, '--base');
  const sNew = await H.startServer(appDir), sOld = await H.startServer(baseDir), browser = await H.launch();
  const T0 = new Date('2026-10-16T10:00:00+09:00');
  const mk = async (url) => { const { ctx, page } = await H.newPage(browser, { clock: T0 }); await H.openApp(page, url); await page.clock.pauseAt(T0.getTime() + 1000); return { ctx, page }; };
  const N = await mk(sNew.url), O = await mk(sOld.url);
  const both = async fn => { await fn(O.page); await fn(N.page); };
  const same = async (label, fn) => { const [a, b] = [await fn(O.page), await fn(N.page)]; H.eq(typeof b === 'string' ? norm(b) : JSON.parse(norm(JSON.stringify(b))), typeof a === 'string' ? norm(a) : JSON.parse(norm(JSON.stringify(a))), label); };
  const step = async () => { await both(p => p.clock.runFor(400)); };
  // computed styles: the rows that differ (the version badge is the only element whose text, and so width, is meant to change)
  const sameStyles = async label => {
    await both(p => p.clock.runFor(5000)); await O.page.waitForTimeout(400);   // toasts have gone (their fade runs in real time)
    const [a, b] = [(await styles(O.page)).map(norm), (await styles(N.page)).map(norm)];   // random record ids in element ids
    H.eq(b.length, a.length, `${label}: number of elements`);
    const diff = []; a.forEach((x, i) => { if (x !== b[i] && !/^SPAN\|appVersion\|/.test(x)) diff.push({ old: x, new: b[i] }); });
    H.eq(diff, [], `${label}: computed styles`);
    const v = a.findIndex(x => /^SPAN\|appVersion\|/.test(x)); H.eq(b[v].split('|').slice(0, -2), a[v].split('|').slice(0, -2), `${label}: version badge (width aside)`);
  };

  await R.test('versions under test', async () => {
    H.eq([await O.page.evaluate(() => window.__KAKEIBO_TEST__.version), await N.page.evaluate(() => window.__KAKEIBO_TEST__.version)], ['1.10.20', '1.11.0']);
  });
  await R.test('the test hook keeps every name of v1.10.20', async () => {
    const [a, b] = [await O.page.evaluate(() => Object.keys(window.__KAKEIBO_TEST__)), await N.page.evaluate(() => Object.keys(window.__KAKEIBO_TEST__))];
    H.eq(a.filter(k => !b.includes(k)), []);
    H.eq(b.filter(k => !a.includes(k)).sort(), ['clearFoodBudget', 'foodBudgetKey', 'foodBudgetStatus', 'loadFoodBudget', 'parseFoodBudget', 'parseFoodBudgetInput', 'saveFoodBudget']);
  });

  await both(async p => { await p.evaluate(async rows => { const T = window.__KAKEIBO_TEST__; for (const r of rows) await T.putExpense(r); await T.refreshAggregates(); }, SEED); });
  await R.test('ホーム (without the new card): HTML, inputs and computed styles; bottom tabs', async () => {
    await same('home', p => viewState(p, '#homeView'));
    await same('tabs', p => p.$$eval('.bottom-nav button', b => b.map(x => x.textContent)));
    await sameStyles('home');
  });
  await R.test('the budget does not change anything else on ホーム', async () => {
    await N.page.evaluate(() => { window.__KAKEIBO_TEST__.saveFoodBudget(20000); return window.__KAKEIBO_TEST__.refreshAggregates(); });
    await same('home with a budget', p => viewState(p, '#homeView'));
    await sameStyles('home with a budget');
  });

  await R.test('pure functions give the same results (reading receipt text, classifying, totals, backup check)', async () => {
    const run = p => p.evaluate(([rc, seed]) => {
      const T = window.__KAKEIBO_TEST__, o = {};
      o.parse = rc.map(([, t]) => { const parts = t.split(/\n-----[^\n]*-----\n/); return T.mergeReceiptPages(parts.map(x => T.parseReceipt(T.pairColumnLines(x)))); });
      o.classify = ['牛乳', 'コーラ', 'ガムテープ', 'ランチパック', 'ペットボトル', 'ノートパソコン', 'ｵﾆｷﾞﾘ ｼｬｹ', 'バンドエイド', '牛丼', 'ハイボール'].map(n => T.classifyItem(n, ''));
      o.totals = T.categoryTotals(seed); o.cal = [0, 980, 12345, 123456, 1234567].map(T.calendarAmount); o.short = [999, 12345, 123456, 123456789].map(T.yenShort);
      o.backup = T.validateBackup({ app: 'kakeibo', format: 1, expenses: seed, learning: { 牛乳: '食費' } });
      o.badBackup = [T.validateBackup({ app: 'kakeibo', format: 2, expenses: [] }), T.validateBackup({})];
      return JSON.stringify(o);
    }, [RECEIPTS, SEED]);
    await same('pure', run);
  });

  for (const [name, text] of RECEIPTS) {
    await R.test(`レシートの文字を読み取って確認・保存: ${name}`, async () => {
      await both(async p => { await p.click('.bottom-nav button[data-view="scanView"]'); await p.evaluate(() => { document.querySelector('#pastePanel').open = true; }); await p.fill('#pasteText', text); await p.click('#pasteReadBtn'); });
      await step();
      await same('confirm screen', p => viewState(p, '#confirmView'));
      await both(p => p.click('#saveReceiptBtn')); await step();
      await both(async p => { const ok = p.locator('#confirmDialog:not(.hidden) #confirmOk'); if (await ok.count()) await ok.click(); }); await step();
      await same('after save', async p => ({ active: await p.evaluate(() => document.querySelector('.view.active').id), toast: await p.textContent('#toast') }));
      await same('records', records);
      await same('home', p => viewState(p, '#homeView'));
    });
  }

  await R.test('手入力 (食費・外食) and the screens after it', async () => {
    for (const [cat, amt] of [['食費', 1234], ['外食', 2000]]) {
      await both(async p => { await p.click('.bottom-nav button[data-view="manualView"]'); await p.fill('#manualStore', cat); await p.selectOption('#manualCategory', cat); await p.fill('#manualAmount', String(amt)); await p.click('#manualForm button[type="submit"]'); });
      await step();
    }
    await same('records', records); await same('home', p => viewState(p, '#homeView')); await same('manual', p => viewState(p, '#manualView'));
  });

  await R.test('編集 (a saved receipt from 最近の支出) and 削除', async () => {
    await both(p => p.click('#recentList .edit-btn')); await step();
    await same('calendar with the editor', p => viewState(p, '#calendarView'));
    await both(p => p.click('#cancelExpenseEditBtn')); await step();
    await both(async p => { await p.click('.bottom-nav button[data-view="homeView"]'); }); await step();
    await both(async p => { await p.click('#recentList .delete-btn'); await p.click('#confirmOk'); }); await step(); await step();
    await same('records after delete', records); await same('home after delete', p => viewState(p, '#homeView'));
  });

  await R.test('カレンダー, グラフ (月別・年別), レシート screen with learning', async () => {
    await both(p => p.click('.bottom-nav button[data-view="calendarView"]')); await step();
    await same('calendar', p => viewState(p, '#calendarView'));
    await both(p => p.click('#prevMonth')); await step(); await same('calendar prev', p => viewState(p, '#calendarView'));
    await both(p => p.click('.bottom-nav button[data-view="graphView"]')); await step();
    await same('graph monthly', p => viewState(p, '#graphView'));
    await both(p => p.click('.graph-tabs button[data-graph-mode="yearly"]')); await step();
    await same('graph yearly', p => viewState(p, '#graphView'));
    await both(p => p.click('.bottom-nav button[data-view="scanView"]')); await step();
    await same('scan', p => viewState(p, '#scanView'));
    await sameStyles('all screens');
  });

  await R.test('バックアップの書き出し: same JSON except version / exportedAt', async () => {
    const exp = async p => { await p.click('.bottom-nav button[data-view="homeView"]'); await p.clock.runFor(200); await p.evaluate(() => { document.querySelector('#backupPanel').open = true; }); const [d] = await Promise.all([p.waitForEvent('download'), p.click('#exportBackupBtn')]); const j = JSON.parse(fs.readFileSync(await d.path(), 'utf8')); const v = j.version; delete j.version; delete j.exportedAt; j.expenses = j.expenses.map(canon).sort(); return { v, j }; };
    const a = await exp(O.page), b = await exp(N.page);
    H.eq([a.v, b.v], ['1.10.20', '1.11.0']); H.eq(b.j, a.j);
  });

  await R.test('no page errors in either version', async () => { H.eq([O.page._errors, N.page._errors], [[], []]); });

  await browser.close(); await sNew.close(); await sOld.close();
  const sum = R.finish(); H.writeResult(args, 'regression_compare', sum); return sum;
}

if (require.main === module) main().then(s => process.exit(s.fail ? 1 : 0)).catch(e => { console.error(e); process.exit(2); });
module.exports = main;
