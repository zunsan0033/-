'use strict';
// Runs every test of the kit and prints a summary.
// usage: node run_all.cjs --app <v1.11.0 folder or kakeibo_free_v1_11_0_netlify.zip> [--base <v1.10.20 folder or zip>] [--out <result folder>]
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.cjs');

const SUITES = ['static_checks', 'unit_food_budget', 'browser_food_budget', 'layout_food_budget', 'regression_compare'];

(async () => {
  const args = H.parseArgs(process.argv.slice(2));
  const app = H.appDirFromArgs(args);
  console.log(`app:  ${app}\nbase: ${args.base ? H.resolveAppDir(args.base, '--base') : '(none: the comparison with v1.10.20 is skipped)'}\n`);
  const all = [];
  for (const name of SUITES) {
    console.log(`== ${name}`);
    try { all.push(await require(path.join(__dirname, `${name}.cjs`))()); }
    catch (e) { console.log(`  ERROR ${e && e.stack || e}`); all.push({ title: name, pass: 0, fail: 1, skipped: 0, results: [{ name: 'suite', ok: false, error: String(e) }] }); }
    console.log('');
  }
  const lines = all.map(s => `| ${s.title} | ${s.pass} | ${s.fail} | ${s.skipped || 0} |`);
  const total = all.reduce((t, s) => ({ pass: t.pass + s.pass, fail: t.fail + s.fail, skipped: t.skipped + (s.skipped || 0) }), { pass: 0, fail: 0, skipped: 0 });
  const md = ['| suite | passed | failed | skipped |', '|---|---|---|---|', ...lines, `| total | ${total.pass} | ${total.fail} | ${total.skipped} |`].join('\n');
  console.log(md);
  if (args.out) { const d = path.resolve(process.cwd(), args.out); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'summary.md'), `app: ${app}\n\n${md}\n`); }
  process.exit(total.fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
