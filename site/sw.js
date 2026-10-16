// v1.10.20: stable row identities keep the tax amount bound to the rows confirmed, across edits, saves, resets and backup restoration.
// v1.10.19 (2026-10-06): an item added by hand keeps its mark (added: 1) through saving, reloading and restoring a backup: its tax rate is never taken
// from the receipt, and the check is not 一致 while it is unknown (also when the item sum is the same as before)
// v1.10.18 (2026-10-06): an amount cleared while typing in the editor no longer drops the 外税 (blank is not ¥0; a calculated ¥0 keeps its evidence),
// a 取消 line after 小計 takes back its item instead of becoming a discount on the whole receipt, and 取消 of 2 of 3 uses the unit price
// v1.10.17 (2026-10-05): the 外税 of a saved record changes with its items when the rate of each item gives it (else the record stays unconfirmed),
// a 取消 line takes back the item of the same name (not one of a similar name; an unclear target is kept open, also after saving and restoring), fuel
// receipts with 単価 / 数量 / 金額 lines give one item
// v1.10.16 (2026-10-05): the screen in front follows a new day (ホーム・カレンダー・グラフ), 取消 / 返品 lines take the item back, サービス料 after 小計
// is an item, a count and unit price left in a name become the count, fuel receipts give one item, more everyday products are classified, and an empty
// date is not saved as today without asking
// v1.10.15 (2026-10-05): a tax read for other items by rate is not taken for the tax of changed items with the same sum, how complete the 小計 lines of a
// record are is kept through saving and restore, 会計番号 lines are not items, point discounts after the total are read, 手入力's date follows the day in front,
// and the page / style / script of one version only are used together
// v1.10.14 (2026-10-05): お会計 / 計 / 総計 are read as the total, points used to pay count like a discount, product names with receipt words
// are kept, category words inside other words no longer decide the category, 手入力 follows the day, and a receipt date outside 2000-2099 is refused
// v1.10.13 (2026-10-04): a change in the tax panel that does not touch the added tax keeps the baseline of the calculation (no ¥2,080 from the tax of
// one item), 小計 lines are judged with the tax of the receipt (never a tax calculated for changed counts), and every different 小計 line is kept with a record
// v1.10.12 (2026-10-04): items after a 小計 of one rate or department are read, an unsure tax is never recalculated with the counts or amounts,
// and contradicting 小計 lines are reported whatever the total was taken from (合計 / card / cash)
// v1.10.11 (2026-10-04): a tax line restated next to its 外税 / 内税 line counts once, rates keep same-amount taxes apart, coupons with other names
// on two photos are two discounts, a 小計 of one rate is not the receipt's 小計, no candidate while a class is open, a 小計 contradiction is kept
// v1.10.10 (2026-10-04): an unknown-class tax always takes part in the check, a discount in the part two photos share counts once, every 小計 line is
// looked at when a total is estimated, and a calculated total is never called the receipt's total
// v1.10.9 (2026-10-04): a total that was read is never replaced by a calculation, an invalid tax input cannot be bypassed by changing the tax class,
// a tax-inclusive 小計 gets no tax added again, and an unsure note is kept per tax
// v1.10.8 (2026-10-04): an estimate from 小計 follows the settled tax class, tax warnings are shown for estimated totals too, going back restores the
// unsure state, and an invalid tax input survives a redraw of the editor
// v1.10.7 (2026-10-04): tax and discount entered by hand count when no total was read, 内税 of several rates adds up, an invalid tax input stops the save,
// a mark on some items is not spread to all, and an estimated total is called an estimate
// v1.10.6 (2026-10-04): 内税 is never added to items priced with tax, tax and discount can be corrected by hand, and how a tax amount was obtained is kept with the record
// v1.10.5 (2026-10-03): landscape camera buttons can be tapped, a read tax amount is never rewritten, the match check uses every tax and discount read,
// the total candidate is applied as shown, a restore reaches other open tabs
const APP_CACHE='kakeibo-app-v11020-layout1';
const ENGINE_CACHE='kakeibo-engine-v1';   // OCR engine and models from jsDelivr (about 33MB), kept across app updates
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
const isEngine=u=>u.indexOf('https://cdn.jsdelivr.net/')===0;
// {cache:'reload'} so a new version never picks up stale files from the HTTP cache
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(APP_CACHE).then(c=>c.addAll(ASSETS.map(u=>new Request(u,{cache:'reload'})))))});
// older caches are removed, but the OCR engine files in them are moved to ENGINE_CACHE first (no second 33MB download)
self.addEventListener('activate',e=>{e.waitUntil((async()=>{
  const eng=await caches.open(ENGINE_CACHE);
  for(const k of await caches.keys()){
    if(k===APP_CACHE||k===ENGINE_CACHE) continue;
    try{ const old=await caches.open(k); for(const req of await old.keys()){ if(isEngine(req.url)&&!(await eng.match(req))){ const res=await old.match(req); if(res) await eng.put(req,res); } } }catch(_){ }
    await caches.delete(k);
  }
  await self.clients.claim();
})())});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const name=isEngine(e.request.url)?ENGINE_CACHE:APP_CACHE;e.respondWith(caches.open(name).then(c=>c.match(e.request).then(cached=>cached||fetch(e.request).then(res=>{if(res&&res.ok){c.put(e.request,res.clone()).catch(()=>{})}return res}))).catch(()=>{if(e.request.mode==='navigate')return caches.match('./index.html');throw new Error('offline resource unavailable')}))});
