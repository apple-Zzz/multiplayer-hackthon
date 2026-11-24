#!/usr/bin/env node
// Builds the public demo site into build/: the React stage plus the recorded performances it replays.
// Only what the audience needs is copied (records, voices, scripts, logs, Bruin insights);
// private files (bids.json, policy-trace.json, rewards.json, meta.json) stay local.
//
//   node stage/build-site.mjs        then deploy the build/ folder
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = join(ROOT, 'performance');
const OUT = join(ROOT, 'build', 'performance');

const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, GENERATE_SOURCEMAP: 'false' } });
if (build.status !== 0) process.exit(build.status ?? 1);

const copy = (from, to) => { if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); } };
copy(join(P, 'decision-record.json'), join(OUT, 'decision-record.json'));
copy(join(P, 'voices'), join(OUT, 'voices'));
copy(join(P, 'runs', 'index.json'), join(OUT, 'runs', 'index.json'));
const runs = JSON.parse(readFileSync(join(P, 'runs', 'index.json'), 'utf8')).map((r) => r.id);
for (const id of runs) {
  for (const f of ['decision-record.json', 'voices', 'script.md', 'decision-log.md', 'summary.md']) copy(join(P, 'runs', id, f), join(OUT, 'runs', id, f));
}
copy(join(P, 'insights', 'aggregate.json'), join(OUT, 'insights', 'aggregate.json'));
for (const id of runs) copy(join(P, 'insights', 'runs', `${id}.json`), join(OUT, 'insights', 'runs', `${id}.json`));

const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
console.log(`Site ready in build/: ${count(join(ROOT, 'build'))} files, runs: ${runs.join(', ')}`);
