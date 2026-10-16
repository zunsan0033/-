'use strict';
// Shared helpers for the v1.11.0 test kit.
// Every path is taken from the command line or from the location of this kit (never from the author's machine).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const KIT_DIR = path.resolve(__dirname, '..');

function requirePlaywright() {
  try { return require('playwright'); } catch (_) { }
  try { return require('@playwright/test'); } catch (_) { }
  // a global installation (npm i -g playwright)
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return require(path.join(root, 'playwright'));
  } catch (_) { }
  throw new Error('playwright が見つかりません。`npm i -g playwright` などで入れてから実行してください');
}

// --app <dir|zip> / --base <dir|zip> / --out <dir>
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    }
  }
  return out;
}

const extracted = new Map();
// the folders extracted from ZIPs are removed when the process ends
process.on('exit', () => { for (const d of extracted.values()) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { } } });
// a directory as it is, or a ZIP extracted to a new temporary directory (the files must be at the top of the ZIP, as for Netlify)
function resolveAppDir(p, label) {
  if (!p) return null;
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`${label}: ${abs} がありません`);
  if (fs.statSync(abs).isDirectory()) return abs;
  if (/\.zip$/i.test(abs)) {
    if (extracted.has(abs)) return extracted.get(abs);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakeibo-app-'));
    execFileSync('unzip', ['-q', abs, '-d', dir]);
    extracted.set(abs, dir);
    return dir;
  }
  throw new Error(`${label}: ディレクトリかZIPを指定してください (${abs})`);
}

// the app under test: --app, else KAKEIBO_APP, else ../site next to this kit (the layout of the repository)
function appDirFromArgs(args) {
  const p = args.app || process.env.KAKEIBO_APP || (fs.existsSync(path.join(KIT_DIR, '..', 'site', 'index.html')) ? path.join(KIT_DIR, '..', 'site') : null);
  if (!p) throw new Error('テストするアプリを --app <フォルダ または kakeibo_free_v1_11_0_netlify.zip> で指定してください');
  const dir = resolveAppDir(p, '--app');
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`--app: ${dir} の直下に index.html がありません`);
  return dir;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function startServer(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, path.normalize(p));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise(r => srv.close(() => r())) }));
  });
}

async function launch() {
  const { chromium } = requirePlaywright();
  const opt = {};
  if (process.env.KAKEIBO_CHROMIUM) opt.executablePath = process.env.KAKEIBO_CHROMIUM;
  return chromium.launch(opt);
}

// iPhone-like page: 390×844, touch, Japanese, Asia/Tokyo. The OCR engine (jsDelivr) is not fetched and service workers are blocked,
// so every run uses the files under test and needs no network.
async function newPage(browser, o = {}) {
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: o.isMobile !== false, hasTouch: true,
    locale: 'ja-JP', timezoneId: o.timezoneId || 'Asia/Tokyo', serviceWorkers: 'block',
  });
  await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\//, r => r.abort());
  const page = await ctx.newPage();
  page._errors = [];
  page.on('pageerror', e => page._errors.push(String(e && e.stack || e)));
  if (o.clock) await page.clock.install({ time: o.clock });
  if (o.init) await page.addInitScript(o.init);
  return { ctx, page };
}

async function openApp(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__KAKEIBO_TEST__);
  // the first renderHome has drawn the month
  await page.waitForFunction(() => document.querySelector('#monthLabel') && document.querySelector('#monthLabel').textContent.length > 0);
}

// a very small runner: test(name, fn), then finish() prints the results and returns the counts
function makeRunner(title) {
  const results = [];
  let current = null;
  async function test(name, fn) {
    current = name; const t0 = Date.now();
    try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ok   ${name}`); }
    catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.stack || e) }); console.log(`  FAIL ${name}\n       ${String(e && e.message || e).split('\n').join('\n       ')}`); }
  }
  // a test that could not run here (reported as skipped, never as passed)
  function skip(name, reason) { results.push({ name, ok: null, skipped: true, reason }); console.log(`  skip ${name}  (${reason})`); }
  function finish() {
    const pass = results.filter(r => r.ok === true).length, fail = results.filter(r => r.ok === false).length, skipped = results.filter(r => r.skipped).length;
    console.log(`${title}: ${pass} passed, ${fail} failed, ${skipped} skipped (${results.length})`);
    return { title, pass, fail, skipped, results };
  }
  return { test, skip, finish, get current() { return current; } };
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error(`${msg || 'not equal'}\n  actual:   ${A}\n  expected: ${B}`); }
// ¥ and ￥ are the same sign (Intl gives ￥ for ja-JP in some engines)
const normYen = s => String(s == null ? '' : s).replace(/￥/g, '¥').replace(/\s+/g, ' ').trim();
const yenText = n => '¥' + Math.round(n).toLocaleString('en-US');

function writeResult(args, name, summary) {
  const dir = args.out ? path.resolve(process.cwd(), args.out) : null;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(summary, null, 2));
}

module.exports = { KIT_DIR, requirePlaywright, parseArgs, resolveAppDir, appDirFromArgs, startServer, launch, newPage, openApp, makeRunner, assert, eq, normYen, yenText, writeResult };
