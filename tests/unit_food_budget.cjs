'use strict';
// Unit tests of the pure helpers of 今月の食費 (window.__KAKEIBO_TEST__), run in Chromium against the app under test.
// usage: node unit_food_budget.cjs --app <folder or kakeibo_free_v1_11_0_netlify.zip> [--out <result folder>]
const H = require('./lib/harness.cjs');

async function main() {
  const args = H.parseArgs(process.argv.slice(2));
  const appDir = H.appDirFromArgs(args);
  const srv = await H.startServer(appDir), browser = await H.launch();
  const R = H.makeRunner('unit_food_budget');
  const { page } = await H.newPage(browser);
  await H.openApp(page, srv.url);
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // a receipt with items (tax spread in proportion) and a manual record
  const rcpt = (id, date, amount, items) => ({ id, date, store: 'テスト', amount, category: 'レシート', items: items.map(([name, a, category]) => ({ name, amount: a, category })), source: 'receipt', createdAt: 1 });
  const man = (id, date, amount, category) => ({ id, date, store: category, amount, category, items: [], source: 'manual', createdAt: 1 });
  const status = (budget, rows, today) => ev(([b, r, t]) => window.__KAKEIBO_TEST__.foodBudgetStatus(b, r, t), [budget, rows, today]);
  const foodOfBars = (rows, ym) => ev(([r, m]) => window.__KAKEIBO_TEST__.categoryTotals(r.filter(x => x.date.startsWith(m)))['食費'] || 0, [rows, ym]);

  await R.test('version is 1.11.0 and the helpers are exposed', async () => {
    const v = await ev(() => { const T = window.__KAKEIBO_TEST__; return { v: T.version, k: T.foodBudgetKey, f: ['foodBudgetStatus', 'parseFoodBudget', 'parseFoodBudgetInput', 'loadFoodBudget', 'saveFoodBudget', 'clearFoodBudget'].map(n => typeof T[n]) }; });
    H.eq(v, { v: '1.11.0', k: 'kakeibo_food_budget_v1', f: ['function', 'function', 'function', 'function', 'function', 'function'] });
  });

  await R.test('未設定: no budget / invalid budgets give set:false (used is still counted)', async () => {
    const rows = [man('a', '2026-10-03', 1200, '食費')];
    for (const b of [null, undefined, 0, -1, 1.5, 10000001, '30000', { amount: '30000' }, { amount: 0 }, {}, [30000], NaN]) {
      const s = await status(b === undefined ? null : b, rows, '2026-10-16');
      H.assert(s && s.set === false, `budget ${JSON.stringify(b)} should be unset: ${JSON.stringify(s)}`);
      H.eq([s.budget, s.remaining, s.perDay, s.over, s.used], [null, null, null, false, 1200], `unset fields for ${JSON.stringify(b)}`);
    }
  });

  await R.test('設定済み: remaining, percent, days left and per day (floor)', async () => {
    const rows = [man('a', '2026-10-03', 12000, '食費'), man('b', '2026-10-10', 3001, '食費')];
    const s = await status(30000, rows, '2026-10-16');
    H.eq([s.set, s.used, s.budget, s.remaining, s.over, s.overBy, s.daysLeft, s.perDay, s.level], [true, 15001, 30000, 14999, false, 0, 16, 937, 'ok']);
    H.assert(Math.abs(s.percent - 15001 / 30000 * 100) < 1e-9, 'percent');
    const o = await status({ amount: 30000, updatedAt: 5 }, rows, '2026-10-16');
    H.eq(o.remaining, 14999, 'budget given as the stored object');
  });

  await R.test('80% は warm、79% は ok、100% ちょうどは warm（超過ではない）', async () => {
    H.eq((await status(100, [man('a', '2026-10-01', 80, '食費')], '2026-10-16')).level, 'warm');
    H.eq((await status(100, [man('a', '2026-10-01', 79, '食費')], '2026-10-16')).level, 'ok');
    const full = await status(100, [man('a', '2026-10-01', 100, '食費')], '2026-10-16');
    H.eq([full.level, full.over, full.percent], ['warm', false, 100]);
  });

  await R.test('超過: overBy, no per-day amount, bar stops at 100%', async () => {
    const s = await status(10000, [man('a', '2026-10-01', 9000, '食費'), man('b', '2026-10-15', 2345, '食費')], '2026-10-16');
    H.eq([s.used, s.remaining, s.over, s.overBy, s.perDay, s.percent, s.level, s.daysLeft], [11345, -1345, true, 1345, null, 100, 'over', 16]);
    H.eq(s.used + s.remaining, s.budget, 'used + remaining = budget');
  });

  await R.test('残りがちょうど0: remaining 0, per day ¥0, not over', async () => {
    const s = await status(5000, [man('a', '2026-10-01', 5000, '食費')], '2026-10-20');
    H.eq([s.remaining, s.over, s.overBy, s.perDay, s.percent, s.level, s.daysLeft], [0, false, 0, 0, 100, 'warm', 12]);
  });

  await R.test('税を按分した記録: the 食費 share of the total (with tax) as in the bars', async () => {
    // ¥1,100 for 食費 600 + 日用品 400 → 食費 660
    const r1 = [rcpt('r1', '2026-10-02', 1100, [['牛乳', 600, '食費'], ['洗剤', 400, '日用品']])];
    const s1 = await status(10000, r1, '2026-10-16');
    H.eq([s1.food, s1.used, s1.remaining], [660, 660, 9340]);
    // fractions: ¥1,000 for 333 / 334 / 334 → 食費 332.66… → 333; the value is exactly the bars' value
    const r2 = [rcpt('r2', '2026-10-02', 1000, [['パン', 333, '食費'], ['洗剤', 334, '日用品'], ['ラーメン', 334, '外食']])];
    const s2 = await status(10000, r2, '2026-10-16');
    H.eq(s2.food, await foodOfBars(r2, '2026-10'), 'same float as categoryTotals');
    H.eq(s2.used, Math.round(1000 * 333 / 1001));
    // a discount on the whole receipt (total smaller than the items) is spread the same way
    const r3 = [rcpt('r3', '2026-10-02', 900, [['肉', 500, '食費'], ['菓子', 500, '食費']])];
    H.eq((await status(10000, r3, '2026-10-16')).used, 900);
  });

  await R.test('食費と外食が混ざったレシート: 外食 is not counted', async () => {
    const rows = [rcpt('r', '2026-10-05', 1080, [['牛乳', 500, '食費'], ['ランチ', 500, '外食']]), man('m', '2026-10-06', 2000, '外食')];
    const s = await status(5000, rows, '2026-10-16');
    H.eq([s.food, s.used, s.remaining], [540, 540, 4460]);
  });

  await R.test('前月・翌月・前年の記録は含まない / 今月の未来の日付は含む', async () => {
    const rows = [man('p', '2026-09-30', 1000, '食費'), man('n', '2026-11-01', 2000, '食費'), man('y', '2025-10-16', 4000, '食費'), man('f', '2026-10-31', 300, '食費'), man('t', '2026-10-16', 50, '食費')];
    const s = await status(10000, rows, '2026-10-16');
    H.eq([s.ym, s.used, s.remaining], ['2026-10', 350, 9650]);
  });

  await R.test('月末と月初の残り日数 (today included)', async () => {
    const cases = [['2026-10-01', 31], ['2026-10-31', 1], ['2026-11-01', 30], ['2026-11-30', 1], ['2026-02-01', 28], ['2026-02-28', 1], ['2028-02-01', 29], ['2028-02-29', 1], ['2026-12-31', 1], ['2027-01-01', 31]];
    for (const [d, n] of cases) H.eq((await status(3100, [], d)).daysLeft, n, `days left on ${d}`);
    H.eq((await status(3100, [], '2026-10-31')).perDay, 3100, 'the last day: the whole remainder for today');
    H.eq((await status(3100, [], '2026-10-01')).perDay, 100, 'first day: 3100 / 31');
    H.eq((await status(1000, [], '2026-10-29')).perDay, 333, '1000 / 3 → 333 (floor)');
    H.eq((await status(2000, [], '2026-10-29')).perDay, 666, '2000 / 3 = 666.67 → 666 (floor, not rounded)');
  });

  await R.test('used + remaining = budget and food = bars value for random data (300 cases)', async () => {
    const out = await ev(() => {
      const T = window.__KAKEIBO_TEST__, cats = ['食費', '外食', '日用品', '未分類']; let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      const bad = [];
      for (let k = 0; k < 300; k++) {
        const rows = [];
        for (let i = 0; i < 1 + rnd(12); i++) {
          const day = `2026-${['09', '10', '11'][rnd(3)]}-${String(1 + rnd(28)).padStart(2, '0')}`;
          if (rnd(2)) rows.push({ id: `m${k}_${i}`, date: day, amount: 1 + rnd(20000), category: cats[rnd(4)], items: [], source: 'manual' });
          else { const items = []; for (let j = 0; j < 1 + rnd(5); j++) items.push({ name: 'x', amount: 1 + rnd(3000), category: cats[rnd(4)] }); const s = items.reduce((t, x) => t + x.amount, 0); rows.push({ id: `r${k}_${i}`, date: day, amount: Math.max(1, s + rnd(400) - 150), category: 'レシート', items, source: 'receipt' }); }
        }
        const budget = 1 + rnd(60000), st = T.foodBudgetStatus(budget, rows, `2026-10-${String(1 + rnd(31)).padStart(2, '0')}`);
        const bars = T.categoryTotals(rows.filter(x => x.date.startsWith('2026-10')))['食費'] || 0;
        if (st.food !== bars || st.used !== Math.round(bars) || st.used + st.remaining !== budget || (st.over ? st.perDay !== null : st.perDay !== Math.floor(st.remaining / st.daysLeft)) || st.percent < 0 || st.percent > 100) bad.push({ k, st, bars, budget });
      }
      return bad.slice(0, 3);
    });
    H.eq(out, [], 'all cases consistent');
  });

  await R.test('records without a date or of another shape do not break the calculation', async () => {
    const s = await status(1000, [null, 5, { amount: 100 }, { date: 20261001, amount: 5 }, man('ok', '2026-10-01', 100, '食費')], '2026-10-16');
    H.eq([s.used, s.remaining], [100, 900]);
    H.eq(await status(1000, null, '2026-10-16').then(x => x.used), 0, 'no records');
    H.eq(await status(1000, [], 'bad'), null, 'an invalid day gives null');
  });

  await R.test('不正な入力値: parseFoodBudgetInput', async () => {
    const got = await ev(() => { const P = window.__KAKEIBO_TEST__.parseFoodBudgetInput; return ['', '   ', null, undefined, 'abc', '1e3', '30,000', '0x10', '0', '-1', '10000001', '1.5', '１２３', '30000', ' 30000 ', '1', '10000000', '30000.0', '007'].map(v => { const r = P(v); return r.ok ? r.amount : r.error; }); });
    H.eq(got, ['予算の金額を入力してください', '予算の金額を入力してください', '予算の金額を入力してください', '予算の金額を入力してください',
      '予算は数字で入力してください', '予算は数字で入力してください', '予算は数字で入力してください', '予算は数字で入力してください',
      '予算は1〜10,000,000円の整数で入力してください', '予算は1〜10,000,000円の整数で入力してください', '予算は1〜10,000,000円の整数で入力してください', '予算は1〜10,000,000円の整数で入力してください',
      123, 30000, 30000, 1, 10000000, 30000, 7]);
  });

  await R.test('壊れたJSON・範囲外の値は未設定 (parseFoodBudget)', async () => {
    const got = await ev(() => { const P = window.__KAKEIBO_TEST__.parseFoodBudget; return [null, '', '{', 'null', '[]', '30000', '"30000"', '{"amount":"30000"}', '{"amount":0}', '{"amount":-5}', '{"amount":10000001}', '{"amount":1.5}', '{"amount":null}', '{"amt":30000}', '{"amount":30000}', '{"amount":30000,"updatedAt":1760000000000}', '{"amount":10000000,"updatedAt":"x"}', '{"amount":1}'].map(v => P(v)); });
    H.eq(got, [null, null, null, null, null, null, null, null, null, null, null, null, null, null, { amount: 30000, updatedAt: 0 }, { amount: 30000, updatedAt: 1760000000000 }, { amount: 10000000, updatedAt: 0 }, { amount: 1, updatedAt: 0 }]);
  });

  await R.test('save / load / clear through localStorage (key and JSON shape)', async () => {
    const r = await ev(() => {
      const T = window.__KAKEIBO_TEST__, K = T.foodBudgetKey; localStorage.removeItem(K);
      const before = T.loadFoodBudget(), t0 = Date.now(), ok = T.saveFoodBudget(30000), raw = localStorage.getItem(K), obj = JSON.parse(raw), loaded = T.loadFoodBudget();
      const badSave = [0, 10000001, 1.5, '30000', NaN].map(v => T.saveFoodBudget(v)), afterBad = localStorage.getItem(K);
      const cleared = T.clearFoodBudget(), after = T.loadFoodBudget(), rawAfter = localStorage.getItem(K);
      localStorage.setItem(K, '{broken'); const broken = T.loadFoodBudget(); localStorage.removeItem(K);
      return { before, ok, keys: Object.keys(obj), amount: obj.amount, tsOk: typeof obj.updatedAt === 'number' && obj.updatedAt >= t0 && obj.updatedAt <= Date.now(), loaded: loaded.amount, badSave, kept: afterBad === raw, cleared, after, rawAfter, broken };
    });
    H.eq(r, { before: null, ok: true, keys: ['amount', 'updatedAt'], amount: 30000, tsOk: true, loaded: 30000, badSave: [false, false, false, false, false], kept: true, cleared: true, after: null, rawAfter: null, broken: null });
  });

  await R.test('localStorage の例外: load → unset, save / clear → false (nothing thrown)', async () => {
    const r = await ev(() => {
      const T = window.__KAKEIBO_TEST__, S = Storage.prototype, g = S.getItem, s = S.setItem, d = S.removeItem, out = {};
      try {
        S.getItem = function () { throw new DOMException('denied', 'SecurityError'); };
        out.load = T.loadFoodBudget();
        S.getItem = g; S.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); };
        out.save = T.saveFoodBudget(20000);
        S.setItem = s; S.removeItem = function () { throw new Error('x'); };
        out.clear = T.clearFoodBudget();
      } catch (e) { out.thrown = String(e); } finally { S.getItem = g; S.setItem = s; S.removeItem = d; }
      out.stored = localStorage.getItem(T.foodBudgetKey);
      return out;
    });
    H.eq(r, { load: null, save: false, clear: false, stored: null });
  });

  await R.test('no page errors while testing', async () => { H.eq(page._errors, []); });

  await browser.close(); await srv.close();
  const sum = R.finish(); H.writeResult(args, 'unit_food_budget', sum); return sum;
}

if (require.main === module) main().then(s => process.exit(s.fail ? 1 : 0)).catch(e => { console.error(e); process.exit(2); });
module.exports = main;
