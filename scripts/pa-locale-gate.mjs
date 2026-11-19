#!/usr/bin/env node
// Chinese-first release gate for the CORE flows; all locale keys are separately reported.
// Run from the imported QBot root (uses no network, API key or translations).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const ROOT = process.cwd();
const EN = JSON.parse(readFileSync(resolve(ROOT, 'src/locales/en.json'), 'utf8'));
const ZH = JSON.parse(readFileSync(resolve(ROOT, 'src/locales/zh.json'), 'utf8'));
const CORE = new Set([
  'onboarding','chat','sidebar','composer','botPanel','botSettings',
  'settings','approval','task','memory','computer','model','keys',
]);
const args = new Set(process.argv.slice(2));
const keys = Object.keys(EN);
const missing = keys.filter(k => typeof ZH[k] !== 'string' || !ZH[k].trim());
const coreMissing = missing.filter(k => CORE.has(k.split('.')[0]));
const coreAll = keys.filter(k => CORE.has(k.split('.')[0]));
const stats = {all: {translated: keys.length - missing.length, total: keys.length},
  core: {translated: coreAll.length - coreMissing.length, total: coreAll.length},
  missingCoreKeys: coreMissing.sort()};
if (args.has('--json')) {
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
} else {
  const format = ({translated,total}) => `${translated}/${total} (${(100*translated/Math.max(total,1)).toFixed(1)}%)`;
  console.log(`All UI catalog: ${format(stats.all)} | core Chinese UI: ${format(stats.core)}`);
  for (const k of coreMissing.slice(0,40)) console.log(`MISSING ${k}`);
  if (coreMissing.length > 40) console.log(`... and ${coreMissing.length - 40} more core keys; use --json for full list`);
}
if (!args.has('--report-only') && coreMissing.length > 0) {
  console.error('Release gate failed: visible first-release workflow contains English fallback keys.');
  process.exitCode = 1;
}
