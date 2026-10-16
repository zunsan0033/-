'use strict';
// Static checks of the package: versions, unchanged parts (CSP, IndexedDB, backup format, engine cache, service worker files) and a diff against
// v1.10.20 that may contain nothing but the food budget and the version.
// usage: node static_checks.cjs --app <folder or zip> [--base <v1.10.20 folder or kakeibo_free_v1_10_20_layout_fix_netlify.zip>] [--out <folder>]
// Without --base only the checks of the new version run (the diff checks are reported as skipped). `diff` (diffutils) is used for the diff.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./lib/harness.cjs');

function udiff(a, b) {
  try { execFileSync('diff', ['-U0', a, b], { encoding: 'utf8' }); return ''; }
  catch (e) { if (e.status === 1) return e.stdout; throw e; }
}
// removed / added lines of a unified diff (without the file headers)
function changes(d) {
  const rem = [], add = [], hunks = [];
  for (const l of d.split('\n')) {
    if (l.startsWith('---') || l.startsWith('+++')) continue;
    if (l.startsWith('@@')) hunks.push(l); else if (l.startsWith('-')) rem.push(l.slice(1)); else if (l.startsWith('+')) add.push(l.slice(1));
  }
  return { rem, add, hunks };
}
const FORBIDDEN = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /https?:\/\//, /indexedDB/, /\bprompt\s*\(/, /\balert\s*\(/, /window\.confirm/, /putExpense|deleteExpense|putExpenses|withStore\s*\(/, /importScripts/];

async function main() {
  const args = H.parseArgs(process.argv.slice(2));
  const app = H.appDirFromArgs(args), base = args.base ? H.resolveAppDir(args.base, '--base') : null;
  const R = H.makeRunner('static_checks');
  const rd = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const A = f => rd(app, f);

  await R.test('ZIP / folder layout: index.html and the app files at the top', async () => {
    for (const f of ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest', '_headers', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'README.txt']) H.assert(fs.existsSync(path.join(app, f)), `${f} missing`);
  });

  await R.test('version 1.11.0 in the five places (APP_VERSION / meta / #appVersion / --kakeibo-version / APP_CACHE)', async () => {
    H.eq((A('app.js').match(/const APP_VERSION='([^']+)'/) || [])[1], '1.11.0', 'APP_VERSION');
    H.eq((A('index.html').match(/<meta name="kakeibo-version" content="([^"]+)"/) || [])[1], '1.11.0', 'meta');
    H.eq((A('index.html').match(/<span id="appVersion" class="app-version">([^<]+)<\/span>/) || [])[1], 'v1.11.0', '#appVersion');
    const css = [...A('styles.css').matchAll(/--kakeibo-version:"([^"]+)"/g)].map(m => m[1]); H.eq(css, ['1.11.0'], '--kakeibo-version (once)');
    H.eq((A('sw.js').match(/const APP_CACHE='([^']+)'/) || [])[1], 'kakeibo-app-v11100', 'APP_CACHE');
    H.assert(/^\/\/ v1\.11\.0/.test(A('sw.js')), 'sw.js starts with the v1.11.0 comment');
  });

  await R.test('kept: ENGINE_CACHE, IndexedDB name / version / store, backup format 1', async () => {
    H.assert(A('sw.js').includes("const ENGINE_CACHE='kakeibo-engine-v1';"), 'ENGINE_CACHE');
    H.assert(A('app.js').includes("const DB_NAME='kakeibo_local_v1', STORE='expenses';"), 'DB_NAME / STORE');
    H.assert(A('app.js').includes('indexedDB.open(DB_NAME,1)'), 'IndexedDB version 1');
    H.assert(A('app.js').includes("JSON.stringify({app:'kakeibo',format:1,version:APP_VERSION,exportedAt:d.toISOString(),expenses:all.map("), 'backup format 1');
    H.assert(A('app.js').includes("const FOOD_BUDGET_KEY='kakeibo_food_budget_v1'"), 'budget key');
  });

  await R.test('README: v1.11.0 first, the backup note, history kept', async () => {
    const r = A('README.txt');
    H.assert(r.startsWith('かんたん家計簿 v1.11.0'), 'README starts with v1.11.0');
    H.assert(r.includes('食費の予算はバックアップに含まれないので、機種変更のときは入力し直してください'), 'backup note');
    H.assert(r.indexOf('かんたん家計簿 v1.10.20（税額を確認した明細との対応を保存）') > 0, 'v1.10.20 history kept');
  });

  if (!base) {
    R.skip('diff against v1.10.20', '--base <v1.10.20 のフォルダかZIP> を指定すると実行します');
  } else {
    const B = f => rd(base, f);
    await R.test('same file list as v1.10.20', async () => { H.eq(fs.readdirSync(app).sort(), fs.readdirSync(base).sort()); });
    await R.test('unchanged files are byte-identical', async () => {
      for (const f of ['_headers', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'REPORT_v11019.md']) H.assert(Buffer.compare(fs.readFileSync(path.join(app, f)), fs.readFileSync(path.join(base, f))) === 0, `${f} changed`);
    });
    await R.test('CSP and the external script tag are unchanged', async () => {
      const csp = h => (h.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/) || [])[0];
      H.eq(csp(A('index.html')), csp(B('index.html')));
      const scripts = h => [...h.matchAll(/<script[^>]*>/g)].map(m => m[0]); H.eq(scripts(A('index.html')), scripts(B('index.html')));
    });
    const summary = {};
    await R.test('app.js: only the version, the test hook, the food budget block and its listeners', async () => {
      const c = changes(udiff(path.join(base, 'app.js'), path.join(app, 'app.js'))); summary['app.js'] = { removed: c.rem.length, added: c.add.length, hunks: c.hunks };
      H.eq(c.rem.length, 2, 'removed lines');
      H.assert(c.rem[0] === "  const APP_VERSION='1.10.20';" && c.add.includes("  const APP_VERSION='1.11.0';"), 'APP_VERSION');
      H.assert(/^  window\.__KAKEIBO_TEST__=Object\.freeze\(\{taxMetaOfRecord,/.test(c.rem[1]), 'test hook removed line');
      H.assert(c.add.includes(c.rem[1].replace('Object.freeze({', 'Object.freeze({foodBudgetStatus,parseFoodBudget,parseFoodBudgetInput,loadFoodBudget,saveFoodBudget,clearFoodBudget,foodBudgetKey:FOOD_BUDGET_KEY,')), 'test hook: only the new names added');
      H.eq(c.hunks.length, 5, 'hunks: version / renderHome line / food budget block / listeners / test hook');
      const bad = c.add.filter(l => !/^  window\.__KAKEIBO_TEST__=/.test(l) && FORBIDDEN.some(re => re.test(l))); H.eq(bad, [], 'no network, IndexedDB, expense writes or native dialogs in the added lines (the test hook line is checked above)');
      const ls = c.add.filter(l => /localStorage\.(setItem|removeItem|getItem|clear)/.test(l)); H.assert(ls.length && ls.every(l => /FOOD_BUDGET_KEY/.test(l)), 'localStorage is used for the budget key only');
    });
    await R.test('index.html: only the version and the new card', async () => {
      const c = changes(udiff(path.join(base, 'index.html'), path.join(app, 'index.html'))); summary['index.html'] = { removed: c.rem.length, added: c.add.length, hunks: c.hunks };
      H.eq(c.rem.map(l => l.trim()), ['<meta name="kakeibo-version" content="1.10.20" />', '<p class="eyebrow">LOCAL FIRST <span id="appVersion" class="app-version">v1.10.20</span></p>']);
      // the page without the new section is the old page with the new version
      const strip = h => h.replace(/        <section id="foodBudgetCard"[\s\S]*?<\/section>\n\n/, '');
      H.eq(strip(A('index.html')), B('index.html').replace('content="1.10.20"', 'content="1.11.0"').replace('>v1.10.20<', '>v1.11.0<'));
      H.eq(c.add.filter(l => FORBIDDEN.some(re => re.test(l))), []);
    });
    await R.test('styles.css: the old rules are kept as they were, the new rules are only appended', async () => {
      const a = A('styles.css'), b = B('styles.css').replace(':root{--kakeibo-version:"1.10.20"}', ':root{--kakeibo-version:"1.11.0"}');
      H.assert(a.startsWith(b), 'the old style sheet (with the new version value) is the beginning of the new one');
      const c = changes(udiff(path.join(base, 'styles.css'), path.join(app, 'styles.css'))); summary['styles.css'] = { removed: c.rem.length, added: c.add.length, hunks: c.hunks };
      H.eq(c.rem, [':root{--kakeibo-version:"1.10.20"}']);
      H.assert(c.add.filter(l => l.trim() && !l.startsWith('/*')).every(l => /^\.food-budget[ .]/.test(l) || l.startsWith(':root{--kakeibo-version:')), 'every new rule is scoped to .food-budget');
    });
    await R.test('sw.js: only the cache name and the comment at the top', async () => {
      const c = changes(udiff(path.join(base, 'sw.js'), path.join(app, 'sw.js'))); summary['sw.js'] = { removed: c.rem.length, added: c.add.length, hunks: c.hunks };
      H.eq(c.rem, ["const APP_CACHE='kakeibo-app-v11020-layout1';"]);
      H.eq(c.add.filter(l => !l.startsWith('//')), ["const APP_CACHE='kakeibo-app-v11100';"]);
      const assets = s => (s.match(/const ASSETS=\[[^\]]*\]/) || [])[0]; H.eq(assets(A('sw.js')), assets(B('sw.js')), 'ASSETS');
    });
    await R.test('README.txt: v1.11.0 added at the top, nothing removed', async () => {
      const a = A('README.txt'), b = B('README.txt'); H.assert(a.endsWith(b), 'the whole old README follows the new part');
      const c = changes(udiff(path.join(base, 'README.txt'), path.join(app, 'README.txt'))); summary['README.txt'] = { removed: c.rem.length, added: c.add.length, hunks: c.hunks }; H.eq(c.rem, []);
    });
    H.writeResult(args, 'diff_summary', summary);
  }

  const sum = R.finish(); H.writeResult(args, 'static_checks', sum); return sum;
}

if (require.main === module) main().then(s => process.exit(s.fail ? 1 : 0)).catch(e => { console.error(e); process.exit(2); });
module.exports = main;
