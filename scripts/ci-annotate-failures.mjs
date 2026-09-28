import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';

const MAX = 20;
const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const lines = `${run.stdout ?? ''}`.split(/\r?\n/);

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const unquote = (s) => s.trim().replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');

const failures = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  let error = '';
  let parent = false;
  for (let j = i + 1; j < lines.length && j < i + 40; j++) {
    if (/^\s*(not )?ok \d+ - /.test(lines[j]) || /^\s*# /.test(lines[j])) break;
    const f = /^\s*failureType:\s*(.*)$/.exec(lines[j]);
    if (f && /subtestsFailed/.test(f[1])) parent = true;
    const e = /^\s*error:\s*(.*)$/.exec(lines[j]);
    if (e) {
      if (/^[|>][-+]?$/.test(e[1].trim())) {
        // A block scalar: keep the whole message (assert.fail texts carry the useful detail after their first line).
        const lead = (line) => /^(\s*)/.exec(line)[1].length;
        const indent = lead(lines[j + 1] ?? '');
        const block = [];
        for (let k = j + 1; k < lines.length && block.length < 60; k++) {
          if (lines[k].trim() !== '' && lead(lines[k]) < indent) break;
          block.push(lines[k].slice(indent));
        }
        error = block.join('\n').trim();
      } else error = unquote(e[1]);
    }
  }
  if (!parent) failures.push({ name: m[2].trim(), error: error || '(no error text)' });
}

const shown = failures.slice(0, MAX);
for (const f of shown) {
  console.log(`::error title=${escProp(f.name)}::${esc(f.error.slice(0, 1500))}`);
}
const summary = [
  '## Failing tests (diagnostic re-run)',
  `exit status: ${run.status} | failures: ${failures.length}${failures.length > MAX ? ` (first ${MAX} annotated)` : ''}`,
  '',
  ...failures.map((f) => `- \`${f.name}\`: ${f.error.slice(0, 3000).replace(/\n/g, '\n  ')}`),
  ...(failures.length === 0 ? ['No failing test parsed from TAP output.', '', '```', (run.stdout ?? '').slice(-3000), (run.stderr ?? '').slice(-2000), '```'] : []),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);
if (failures.length === 0) console.log(`::warning title=ci-annotate-failures::no failing test parsed (exit ${run.status}); ${esc((run.stderr ?? '').slice(-300))}`);
