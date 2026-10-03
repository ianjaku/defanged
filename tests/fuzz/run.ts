/**
 * Differential fuzzing: random programs through CPython and defanged, diffed.
 *
 *   bun run fuzz                      # 300 programs, seed from the clock
 *   bun run fuzz --count 2000 --seed 7
 *   PYTHON=python3.14 bun run fuzz
 *
 * Every probe whose output differs is printed as a one-line repro. The exit
 * code is the number of distinct failing probes (capped at 1), so CI can
 * gate on it.
 */

import { createInterpreter } from '../../src';
import { Generator, Rng } from './generate';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const count = Number(args.get('count') ?? 300);
const seed = Number(args.get('seed') ?? (Date.now() % 1_000_000));
const probes = Number(args.get('probes') ?? 25);
const python = process.env.PYTHON ?? 'python3';

const programs: { name: string; code: string }[] = [];
for (let i = 0; i < count; i++) {
  programs.push({ name: `${seed}/${i}`, code: new Generator(new Rng(seed * 1_000_003 + i)).program(probes) });
}

const proc = Bun.spawn([python, '-W', 'ignore', `${import.meta.dir}/../conformance/harness.py`], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
proc.stdin.write(JSON.stringify(programs));
proc.stdin.end();
const output = await new Response(proc.stdout).text();
if ((await proc.exited) !== 0) throw new Error(`${python} failed (exit ${await proc.exited})`);
const recorded = JSON.parse(output);

interface Outcome { stdout: string; error: { type: string; message: string } | null }

async function run(code: string): Promise<Outcome> {
  const lines: string[] = [];
  const it = createInterpreter({ onPrint: (line) => lines.push(line), timeoutMs: 5000, maxIterations: 2_000_000 });
  let error: Outcome['error'] = null;
  try {
    await it.run(code);
  } catch (e: any) {
    error = { type: e.constructor?.pyName ?? e.name, message: String(e.baseMessage ?? e.message).replace(/^KeyError: /, '') };
  }
  return { stdout: lines.map((l) => l + '\n').join(''), error };
}

/** The probe source for line `n` of a program. */
function probeSource(code: string, n: number): string {
  const m = new RegExp(`print\\(${n}, repr\\(([\\s\\S]*?)\\)\\)\\nexcept`).exec(code);
  return m ? m[1] : '?';
}

/** Differences the README documents as deliberate, or that sit outside the supported subset. */
function knownDeviation(want: string, got: string): boolean {
  const w = want.replace(/^\d+ /, '');
  const g = got.replace(/^\d+ /, '');
  // None counts as 0 in + - *, so whatever CPython raised there, we went on.
  if (/^TypeError unsupported operand type\(s\) for [-+*]: .*'NoneType'/.test(w)) return true;
  if (/^TypeError can't multiply sequence by non-int of type 'NoneType'/.test(w)) return true;
  // d.get(k, default) returns default for a None value.
  if (/^None$/.test(w) && !/Error/.test(g)) return true;
  // No complex numbers.
  if (/\dj\)$/.test(w) || /complex/.test(w)) return true;
  // No bytes type: str(x, encoding) and friends.
  if (/bytes-like|decoding to str/.test(w)) return true;
  return false;
}

let failures = 0;
const seen = new Set<string>();
for (const { name, code } of programs) {
  const want: Outcome = recorded.cases[name];
  const got = await run(code);
  const wantLines = want.stdout.split('\n');
  const gotLines = got.stdout.split('\n');
  const n = Math.max(wantLines.length, gotLines.length);
  for (let i = 0; i < n; i++) {
    if (wantLines[i] === gotLines[i]) continue;
    const probe = Number((wantLines[i] ?? gotLines[i] ?? '').split(' ')[0]);
    const src = probeSource(code, probe);
    if (knownDeviation(wantLines[i] ?? '', gotLines[i] ?? '')) continue;
    // Sets iterate in insertion order here and in hash order in CPython, so a
    // sort over a set meets its incomparable pair in a different order.
    if (/\bset\(/.test(src) && /not supported between instances/.test(wantLines[i] ?? '') && /not supported between instances/.test(gotLines[i] ?? '')) continue;
    // Sorting a mixed-type list fails on the pair CPython's timsort compares first; the JS sort meets another pair.
    if (/\b(sorted|sort|min|max)\(/.test(src) && /not supported between instances/.test(wantLines[i] ?? '') && /not supported between instances/.test(gotLines[i] ?? '')) continue;
    // One report per distinct kind of difference, so a systematic one does not flood the output.
    const shape = (line: string | undefined) => (line ?? '').replace(/^\d+ /, '').replace(/-?\d+(\.\d+)?(e[+-]?\d+)?/g, 'N').replace(/'[^']*'/g, 'S').replace(/\(.*\)/, '(..)').slice(0, 32);
    const key = shape(wantLines[i]) + ' || ' + shape(gotLines[i]);
    if (seen.has(key)) break;
    seen.add(key);
    failures++;
    console.log(`\n[${name}] ${src}\n  cpython : ${wantLines[i] ?? '<nothing>'}\n  defanged: ${gotLines[i] ?? '<nothing>'}`);
    if (args.has('all')) continue;
    break;
  }
  if ((want.error === null) !== (got.error === null) || (want.error && got.error && (want.error.type !== got.error.type || want.error.message !== got.error.message))) {
    failures++;
    console.log(`\n[${name}] program ended differently\n  cpython : ${JSON.stringify(want.error)}\n  defanged: ${JSON.stringify(got.error)}`);
  }
}
console.log(`\n${count} programs x ${probes} probes, seed ${seed}: ${failures} distinct differences`);
process.exit(failures > 0 ? 1 : 0);
