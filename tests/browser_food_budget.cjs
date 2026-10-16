'use strict';
// Browser tests of 今月の食費 (Playwright + Chromium, 390×844 like an iPhone, Asia/Tokyo, clock fixed to a known day).
// usage: node browser_food_budget.cjs --app <folder or kakeibo_free_v1_11_0_netlify.zip> [--out <result folder>]
const H = require('./lib/harness.cjs');
const KEY = 'kakeibo_food_budget_v1';
const DAY = '2026-10-16T10:00:00+09:00';

const num = s => { const m = H.normYen(s).match(/-?[\d,]+/); return m ? Number(m[0].replace(/,/g, '')) : NaN; };
async function cardText(page) { return H.normYen(await page.locator('#foodBudgetCard').innerText()); }
async function card(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#foodBudgetCard'), q = s => c.querySelector(s), t = e => e ? e.textContent.replace(/￥/g, '¥').replace(/\s+/g, ' ').trim() : null;
    const nw = [...c.querySelectorAll('.fb-line .fb-nw')].map(t), fill = q('.fb-fill');
    return {
      visible: !q('#foodBudgetView').classList.contains('hidden'), editing: !q('#foodBudgetForm').classList.contains('hidden'),
      empty: t(q('.fb-empty')), label: t(q('.fb-label')), amount: t(q('.fb-amount')), lines: [...c.querySelectorAll('.fb-line')].map(t), nw,
      width: fill ? fill.style.width : null, fillColor: fill ? getComputedStyle(fill).backgroundColor : null,
      cls: ['is-set', 'is-warm', 'is-over'].filter(k => c.classList.contains(k)), aria: q('.fb-bar') ? q('.fb-bar').getAttribute('aria-valuenow') : null,
    };
  });
}
async function barAmount(page, cat) {
  return page.evaluate(c => { const r = [...document.querySelectorAll('#categoryBars .bar-row')].find(x => x.querySelector('span').textContent === c); return r ? r.querySelector('strong').textContent : null; }, cat);
}
const usedOf = c => num(c.nw[0]);
async function stored(page) { return page.evaluate(k => localStorage.getItem(k), KEY); }
async function expenses(page) { return page.evaluate(async () => (await window.__KAKEIBO_TEST__.allExpenses()).sort((a, b) => a.id < b.id ? -1 : 1)); }
async function seed(page, rows) { await page.evaluate(async r => { const T = window.__KAKEIBO_TEST__; for (const x of r) await T.putExpense(x); await T.refreshAggregates(); }, rows); }
async function setBudget(page, v) {
  await page.click('#foodBudgetView [data-fb-edit]');
  await page.fill('#foodBudgetInput', String(v));
  await page.click('#foodBudgetForm button[type="submit"]');
}
async function cssVar(page, name) { return page.evaluate(n => { const d = document.createElement('div'); d.style.color = `var(${n})`; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; }, name); }
async function manual(page, category, amount, name) {
  await page.click('.bottom-nav button[data-view="manualView"]');
  await page.fill('#manualStore', name || category);
  await page.selectOption('#manualCategory', category);
  await page.fill('#manualAmount', String(amount));
  await page.click('#manualForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#homeView').classList.contains('active'));
  await page.waitForTimeout(150);
}
const rcpt = (id, date, amount, items) => ({ id, date, store: 'テスト', amount, category: 'レシート', items: items.map(([name, a, category]) => ({ name, amount: a, category })), source: 'receipt', createdAt: 1 });
const man = (id, date, amount, category) => ({ id, date, store: category, amount, category, items: [], source: 'manual', createdAt: 1 });

async function main() {
  const args = H.parseArgs(process.argv.slice(2));
  const appDir = H.appDirFromArgs(args);
  const srv = await H.startServer(appDir), browser = await H.launch();
  const R = H.makeRunner('browser_food_budget');
  const fresh = async (o = {}) => { const { ctx, page } = await H.newPage(browser, Object.assign({ clock: new Date(DAY) }, o)); page._dialogs = 0; page.on('dialog', d => { page._dialogs++; d.dismiss().catch(() => { }); }); await H.openApp(page, srv.url); return { ctx, page }; };

  // ---- one session through the main flow ----
  const { ctx, page } = await fresh();
  const WARM = await cssVar(page, '--warm'), DANGER = await cssVar(page, '--danger'), ACCENT = await cssVar(page, '--accent');

  await R.test('placement: between hero-card and カテゴリ別, existing order unchanged', async () => {
    const order = await page.evaluate(() => [...document.querySelector('#homeView').children].map(e => e.id || e.className.split(' ')[0] + ':' + ((e.querySelector('h2') || {}).textContent || '')));
    H.eq(order, ['hero-card:', 'foodBudgetCard', 'section-block:カテゴリ別', 'section-block:最近の支出', 'backupPanel']);
  });

  await R.test('予算が未設定: only the explanation and 予算を設定', async () => {
    const c = await card(page);
    H.eq([c.visible, c.editing, c.empty, c.label, c.lines, c.cls], [true, false, '食費の予算を決めると、今月あといくら使えるかを表示します', null, [], []]);
    const buttons = await page.$$eval('#foodBudgetView button', b => b.map(x => x.textContent));
    H.eq(buttons, ['予算を設定']);
  });

  await R.test('editor: number field (inputmode numeric), 保存・キャンセル, no 予算を解除 while unset', async () => {
    await page.click('#foodBudgetView [data-fb-edit]');
    const f = await page.evaluate(() => { const i = document.querySelector('#foodBudgetInput'); return { type: i.type, im: i.inputMode, focus: document.activeElement === i, val: i.value, clear: document.querySelector('#foodBudgetClearBtn').classList.contains('hidden'), btns: [...document.querySelectorAll('#foodBudgetForm button')].filter(b => !b.classList.contains('hidden')).map(b => b.textContent) }; });
    H.eq(f, { type: 'number', im: 'numeric', focus: true, val: '', clear: true, btns: ['保存', 'キャンセル'] });
    H.eq((await card(page)).visible, false, 'the display is replaced by the editor');
  });

  await R.test('invalid input: error in the card, nothing saved, no alert/prompt', async () => {
    const tries = [['', '予算の金額を入力してください'], ['0', '予算は1〜10,000,000円の整数で入力してください'], ['-5', '予算は1〜10,000,000円の整数で入力してください'], ['10000001', '予算は1〜10,000,000円の整数で入力してください'], ['1.5', '予算は1〜10,000,000円の整数で入力してください']];
    for (const [v, msg] of tries) {
      await page.fill('#foodBudgetInput', v); await page.click('#foodBudgetForm button[type="submit"]');
      const e = await page.evaluate(() => { const e = document.querySelector('#foodBudgetError'); return { shown: !e.classList.contains('hidden'), text: e.textContent, inCard: !!e.closest('#foodBudgetCard'), invalid: document.querySelector('#foodBudgetInput').getAttribute('aria-invalid'), editing: !document.querySelector('#foodBudgetForm').classList.contains('hidden') }; });
      H.eq(e, { shown: true, text: msg, inCard: true, invalid: 'true', editing: true }, `input "${v}"`);
      H.eq(await stored(page), null, `nothing stored for "${v}"`);
    }
    // a value the number field itself cannot read (badInput)
    await page.fill('#foodBudgetInput', ''); await page.focus('#foodBudgetInput'); await page.keyboard.type('1e');
    await page.click('#foodBudgetForm button[type="submit"]');
    H.eq(await page.textContent('#foodBudgetError'), '予算は数字で入力してください');
    H.eq(await stored(page), null);
    // typing again clears the message
    await page.fill('#foodBudgetInput', '3'); H.eq(await page.evaluate(() => document.querySelector('#foodBudgetError').classList.contains('hidden')), true);
    H.eq(page._dialogs, 0, 'no native dialog');
  });

  await R.test('キャンセル: nothing saved, the card is back', async () => {
    await page.fill('#foodBudgetInput', '12345'); await page.click('#foodBudgetCancelBtn');
    const c = await card(page); H.eq([c.visible, c.editing, c.empty !== null], [true, false, true]); H.eq(await stored(page), null);
  });

  let before;
  await R.test('予算を設定すると表示される (30,000円, no records yet)', async () => {
    before = await expenses(page);
    await setBudget(page, 30000);
    const c = await card(page);
    H.eq([c.visible, c.editing, c.label, c.amount, c.lines, c.width, c.cls, c.aria], [true, false, '今月の食費 残り', '¥30,000', ['使った ¥0 ／ 予算 ¥30,000', 'あと16日・1日あたり ¥1,875'], '0%', ['is-set'], '0']);
    const s = JSON.parse(await stored(page)); H.eq(Object.keys(s), ['amount', 'updatedAt']); H.eq(s.amount, 30000); H.assert(Math.abs(s.updatedAt - new Date(DAY).getTime()) < 120000, 'updatedAt is now');
    H.eq(H.normYen(await page.textContent('#toast')), '食費の予算を保存しました');
    H.eq(c.fillColor, ACCENT, 'below 80%: accent colour');
  });

  await R.test('setting the budget writes no expense (IndexedDB unchanged)', async () => { H.eq(await expenses(page), before); });

  let foodId;
  await R.test('手入力で食費を足すと残りが減る', async () => {
    await manual(page, '食費', 1234, 'スーパー');
    const c = await card(page);
    H.eq([c.amount, c.lines], ['¥28,766', ['使った ¥1,234 ／ 予算 ¥30,000', 'あと16日・1日あたり ¥1,797']]);
    H.eq(usedOf(c), num(await barAmount(page, '食費')), 'same as the 食費 bar');
    foodId = (await expenses(page)).find(x => x.category === '食費').id;
  });

  await R.test('外食を足しても変わらない', async () => {
    await manual(page, '外食', 2000, 'ランチ');
    const c = await card(page);
    H.eq([c.amount, c.nw[0]], ['¥28,766', '使った ¥1,234']);
    H.eq(H.normYen(await barAmount(page, '外食')), '¥2,000');
  });

  await R.test('カテゴリ別の食費の金額と一致する (receipts with tax and discounts, a future day this month)', async () => {
    await seed(page, [
      rcpt('t1', '2026-10-02', 1080, [['牛乳', 500, '食費'], ['ランチ', 500, '外食']]),
      rcpt('t2', '2026-10-03', 1000, [['パン', 333, '食費'], ['洗剤', 334, '日用品'], ['ラーメン', 334, '外食']]),
      rcpt('t3', '2026-10-28', 2160, [['肉', 1499, '食費'], ['野菜', 501, '食費']]),
      man('p1', '2026-09-30', 5000, '食費'), man('n1', '2026-11-01', 7000, '食費'),
    ]);
    const c = await card(page), bar = num(await barAmount(page, '食費'));
    H.eq(usedOf(c), bar, 'card used = 食費 bar');
    const expect = await page.evaluate(() => { const T = window.__KAKEIBO_TEST__; return T.allExpenses().then(a => Math.round(T.categoryTotals(a.filter(x => x.date.startsWith('2026-10')))['食費'])); });
    H.eq(usedOf(c), expect); H.eq(num(c.amount), 30000 - expect, 'remaining = budget - used'); H.eq(usedOf(c) + num(c.amount), 30000);
  });

  await R.test('記録を消すと戻る (delete from 最近の支出)', async () => {
    const usedBefore = usedOf(await card(page));
    await page.click(`#recentList .delete-btn[data-id="${foodId}"]`);
    await page.click('#confirmOk');
    await page.waitForFunction(id => !document.querySelector(`#recentList .delete-btn[data-id="${id}"]`), foodId);
    await page.waitForTimeout(100);
    const c = await card(page);
    H.eq(usedOf(c), usedBefore - 1234); H.eq(usedOf(c), num(await barAmount(page, '食費')));
  });

  await R.test('80%以上は --warm、超過したら --danger と「¥xx オーバー」(1日あたりは出さない)', async () => {
    const used = usedOf(await card(page));
    await setBudget(page, Math.ceil(used / 0.85));   // about 85%
    let c = await card(page); H.eq([c.cls, c.fillColor], [['is-set', 'is-warm'], WARM]);
    await setBudget(page, used - 500);
    c = await card(page);
    H.eq([c.cls, c.fillColor, c.label, c.amount, c.width, c.aria], [['is-set', 'is-over'], DANGER, '今月の食費', '¥500 オーバー', '100%', '100']);
    H.eq(c.lines, [`使った ${H.yenText(used)} ／ 予算 ${H.yenText(used - 500)}`, 'あと16日']);
    H.assert(!/1日あたり/.test(await cardText(page)), 'no per-day amount when over');
    await setBudget(page, used);   // exactly used: 残り ¥0, 1日あたり ¥0
    c = await card(page); H.eq([c.amount, c.lines[1], c.cls], ['¥0', 'あと16日・1日あたり ¥0', ['is-set', 'is-warm']]);
    await setBudget(page, 30000);
  });

  await R.test('変更: the editor shows the current amount and 予算を解除', async () => {
    await page.click('#foodBudgetView [data-fb-edit]');
    H.eq(await page.inputValue('#foodBudgetInput'), '30000');
    H.eq(await page.evaluate(() => document.querySelector('#foodBudgetClearBtn').classList.contains('hidden')), false);
    await page.click('#foodBudgetCancelBtn');
  });

  await R.test('the editor survives a redraw of ホーム (draft kept)', async () => {
    await page.click('#foodBudgetView [data-fb-edit]'); await page.fill('#foodBudgetInput', '45678');
    await page.evaluate(async () => { document.dispatchEvent(new Event('visibilitychange')); await window.__KAKEIBO_TEST__.refreshAggregates(); });
    H.eq([await page.inputValue('#foodBudgetInput'), (await card(page)).editing, (await card(page)).visible], ['45678', true, false]);
    await page.click('#foodBudgetCancelBtn');
    H.eq(JSON.parse(await stored(page)).amount, 30000);
  });

  await R.test('再読み込みしても予算が残る', async () => {
    await page.reload(); await H.openApp(page, srv.url);
    const c = await card(page); H.eq([c.label, num(c.nw[1])], ['今月の食費 残り', 30000]);
    H.eq(usedOf(c), num(await barAmount(page, '食費')));
  });

  await R.test('予算を解除できる (askConfirm; キャンセル keeps it)', async () => {
    await page.click('#foodBudgetView [data-fb-edit]'); await page.click('#foodBudgetClearBtn');
    H.eq(await page.evaluate(() => !document.querySelector('#confirmDialog').classList.contains('hidden')), true, 'in-app confirmation');
    await page.click('#confirmCancel');
    H.eq(JSON.parse(await stored(page)).amount, 30000, 'cancelled: kept');
    await page.click('#foodBudgetClearBtn'); await page.click('#confirmOk');
    const c = await card(page);
    H.eq([c.visible, c.editing, c.empty, c.cls], [true, false, '食費の予算を決めると、今月あといくら使えるかを表示します', []]);
    H.eq(await stored(page), null); H.eq(H.normYen(await page.textContent('#toast')), '食費の予算を解除しました');
    H.eq(page._dialogs, 0, 'no native dialog');
  });

  await R.test('budget changes never touched the expenses (only the test seeds / manual entries / delete did)', async () => {
    const all = await expenses(page); H.eq(all.length, 6); H.assert(all.every(x => !('budget' in x) && !('foodBudget' in x)));
  });

  await R.test('書き込みに失敗: toast error and the previous state stays', async () => {
    await setBudget(page, 20000);
    await page.evaluate(k => { const s = Storage.prototype.setItem; Storage.prototype.setItem = function (a, b) { if (a === k) throw new DOMException('full', 'QuotaExceededError'); return s.call(this, a, b); }; window.__restoreSet = () => { Storage.prototype.setItem = s; }; }, KEY);
    await page.click('#foodBudgetView [data-fb-edit]'); await page.fill('#foodBudgetInput', '45000'); await page.click('#foodBudgetForm button[type="submit"]');
    const t = await page.evaluate(() => { const t = document.querySelector('#toast'); return { error: t.classList.contains('error'), text: t.textContent }; });
    H.eq(t.error, true); H.assert(/予算を保存できませんでした/.test(t.text), t.text);
    const c = await card(page); H.eq([c.visible, c.editing, num(c.nw[1])], [true, false, 20000]);
    H.eq(JSON.parse(await stored(page)).amount, 20000);
    // removing fails too
    await page.evaluate(k => { window.__restoreSet(); const d = Storage.prototype.removeItem; Storage.prototype.removeItem = function (a) { if (a === k) throw new Error('x'); return d.call(this, a); }; window.__restoreDel = () => { Storage.prototype.removeItem = d; }; }, KEY);
    await page.click('#foodBudgetView [data-fb-edit]'); await page.click('#foodBudgetClearBtn'); await page.click('#confirmOk');
    const t2 = await page.evaluate(() => { const t = document.querySelector('#toast'); return { error: t.classList.contains('error'), text: t.textContent }; });
    H.eq(t2.error, true); H.assert(/予算を解除できませんでした/.test(t2.text), t2.text);
    H.eq(num((await card(page)).nw[1]), 20000); H.eq(JSON.parse(await stored(page)).amount, 20000);
    await page.evaluate(() => window.__restoreDel());
  });

  await R.test('a broken stored value is shown as 未設定', async () => {
    for (const v of ['{broken', '{"amount":0}', '{"amount":10000001}', '{"amount":"3000"}', '[]']) {
      await page.evaluate(([k, x]) => localStorage.setItem(k, x), [KEY, v]); await page.reload(); await H.openApp(page, srv.url);
      H.eq((await card(page)).empty, '食費の予算を決めると、今月あといくら使えるかを表示します', v);
    }
    H.eq(page._errors, [], 'no page errors');
  });

  await R.test('backup: the budget is not exported; restore leaves it as it is', async () => {
    await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ amount: 25000, updatedAt: 1 })), KEY); await page.reload(); await H.openApp(page, srv.url);
    await page.click('#backupPanel summary');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBackupBtn')]);
    const fs = require('fs'), json = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    H.eq(Object.keys(json), ['app', 'format', 'version', 'exportedAt', 'expenses', 'learning', 'learningLabels', 'nameLearning']);
    H.eq([json.format, json.version], [1, '1.11.0']);
    H.assert(!/budget|kakeibo_food_budget_v1/i.test(JSON.stringify(json)), 'no budget in the backup');
    // restore a backup that has new records: the budget stays 25,000 and the card follows the new records
    json.expenses.push(man('restored-1', '2026-10-05', 999, '食費'));
    const os = require('os'), path = require('path'), file = path.join(os.tmpdir(), `kakeibo-test-${process.pid}.json`); fs.writeFileSync(file, JSON.stringify(json));
    const usedBefore = usedOf(await card(page));
    await page.setInputFiles('#importBackupInput', file); await page.click('#confirmOk');
    await page.waitForFunction(() => /復元しました/.test(document.querySelector('#toast').textContent));
    await page.waitForTimeout(100); fs.unlinkSync(file);
    const c = await card(page); H.eq([num(c.nw[1]), usedOf(c)], [25000, usedBefore + 999]); H.eq(JSON.parse(await stored(page)).amount, 25000);
  });

  await R.test('another tab sets or clears the budget: this card follows (storage event)', async () => {
    const other = await ctx.newPage(); await H.openApp(other, srv.url);
    await other.evaluate(() => window.__KAKEIBO_TEST__.saveFoodBudget(12000));
    await page.waitForFunction(() => /予算 ￥12,000|予算 ¥12,000/.test(document.querySelector('#foodBudgetCard').textContent));
    await other.evaluate(() => window.__KAKEIBO_TEST__.clearFoodBudget());
    await page.waitForFunction(() => !!document.querySelector('#foodBudgetCard .fb-empty'));
    await other.close();
  });

  await R.test('no page errors and no native dialogs in the session', async () => { H.eq(page._errors, []); H.eq(page._dialogs, 0); });
  await ctx.close();

  // ---- the month changes while the app is open ----
  await R.test('時計をずらして月をまたぐと新しい月に切り替わる (midnight timer, app in front)', async () => {
    const { ctx: c2, page: p } = await fresh({ clock: new Date('2026-10-31T23:58:00+09:00') });
    await p.evaluate(k => localStorage.setItem(k, JSON.stringify({ amount: 5000, updatedAt: 1 })), KEY);
    await seed(p, [man('o1', '2026-10-10', 1000, '食費'), man('o2', '2026-10-31', 200, '外食'), man('n1', '2026-11-01', 300, '食費'), man('n2', '2026-11-20', 1100, '食費')]);
    let c = await card(p);
    H.eq([c.amount, c.lines], ['¥4,000', ['使った ¥1,000 ／ 予算 ¥5,000', 'あと1日・1日あたり ¥4,000']]);
    H.eq(await p.textContent('#monthLabel'), '2026年10月の支出');
    await p.clock.fastForward('03:00');   // 0:01 on 11/1: the midnight timer and the minute check have run
    await p.waitForFunction(() => document.querySelector('#monthLabel').textContent === '2026年11月の支出');
    c = await card(p);
    H.eq([c.amount, c.lines], ['¥3,600', ['使った ¥1,400 ／ 予算 ¥5,000', 'あと30日・1日あたり ¥120']]);
    H.eq(usedOf(c), num(await barAmount(p, '食費')));
    H.eq(JSON.parse(await stored(p)).amount, 5000, 'the budget is used again in the new month');
    H.eq(p._errors, []); await c2.close();
  });

  await R.test('月をまたぐ (the app comes back to the front: focus / pageshow) and 年をまたぐ', async () => {
    const { ctx: c3, page: p } = await fresh({ clock: new Date('2026-12-31T22:00:00+09:00') });
    await p.evaluate(k => localStorage.setItem(k, JSON.stringify({ amount: 31000, updatedAt: 1 })), KEY);
    await seed(p, [man('d1', '2026-12-05', 6000, '食費'), man('j1', '2027-01-01', 500, '食費')]);
    H.eq((await card(p)).lines[1], 'あと1日・1日あたり ¥25,000');
    // the device slept over New Year: the clock is paused before midnight and then moved on without running any timer
    await p.clock.pauseAt(new Date('2026-12-31T23:00:00+09:00'));
    await p.clock.setSystemTime(new Date('2027-01-01T08:00:00+09:00'));
    H.eq([await p.textContent('#monthLabel'), await p.evaluate(() => new Date().getFullYear())], ['2026年12月の支出', 2027], 'no timer has redrawn the page yet');
    await p.evaluate(() => window.dispatchEvent(new Event('focus')));
    await p.waitForFunction(() => document.querySelector('#monthLabel').textContent === '2027年1月の支出', null, { polling: 50 });
    const c = await card(p);
    H.eq([c.amount, c.lines], ['¥30,500', ['使った ¥500 ／ 予算 ¥31,000', 'あと31日・1日あたり ¥983']]);
    H.eq(p._errors, []); await c3.close();
  });

  await R.test('another view is in front when the month changes: ホーム shows the new month when opened', async () => {
    const { ctx: c4, page: p } = await fresh({ clock: new Date('2026-11-30T23:59:00+09:00') });
    await p.evaluate(k => localStorage.setItem(k, JSON.stringify({ amount: 3100, updatedAt: 1 })), KEY);
    await seed(p, [man('a', '2026-11-03', 3000, '食費')]);
    await p.click('.bottom-nav button[data-view="graphView"]');
    await p.clock.fastForward('02:00');
    await p.click('.bottom-nav button[data-view="homeView"]');
    await p.waitForFunction(() => document.querySelector('#monthLabel').textContent === '2026年12月の支出');
    const c = await card(p); H.eq([c.amount, c.lines[1]], ['¥3,100', 'あと31日・1日あたり ¥100']);
    await c4.close();
  });

  await browser.close(); await srv.close();
  const sum = R.finish(); H.writeResult(args, 'browser_food_budget', sum); return sum;
}

if (require.main === module) main().then(s => process.exit(s.fail ? 1 : 0)).catch(e => { console.error(e); process.exit(2); });
module.exports = main;
