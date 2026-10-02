/**
 * Records what CPython does for every conformance case.
 *
 *   bun run conformance:record            # uses python3
 *   PYTHON=python3.14 bun run conformance:record
 *
 * Writes tests/conformance/expected.json, which tests/conformance.test.ts
 * compares the interpreter against. Re-run after adding or changing a case.
 */

import { cases } from './cases';

const python = process.env.PYTHON ?? 'python3';
const proc = Bun.spawn([python, `${import.meta.dir}/harness.py`], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
proc.stdin.write(JSON.stringify(cases));
proc.stdin.end();
const output = await new Response(proc.stdout).text();
if ((await proc.exited) !== 0) throw new Error(`${python} exited with an error`);

const recorded = JSON.parse(output);
await Bun.write(`${import.meta.dir}/expected.json`, output + '\n');
console.log(`Recorded ${Object.keys(recorded.cases).length} cases against CPython ${recorded.python}`);
