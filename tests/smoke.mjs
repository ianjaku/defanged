// Runs the built package under Node: every entry point, a tool call, a module, the worker.
// `node tests/smoke.mjs` after `bun run build`.
import assert from 'node:assert/strict';
import { createInterpreter, runPython, generateToolsPrompt, tool, NameError } from '../dist/index.js';
import { json } from '../dist/json.js';
import { collections } from '../dist/collections.js';
import { itertools } from '../dist/itertools.js';
import { functools } from '../dist/functools.js';
import { string } from '../dist/string.js';
import { random } from '../dist/random.js';
import { createWorkerInterpreter } from '../dist/worker.js';

assert.equal(await runPython('sum(x * x for x in range(10))'), 285);
assert.equal(await runPython('fetch(quarter="Q1", limit=5)', { fetch: (quarter, limit = 10) => `${quarter}/${limit}` }), 'Q1/5');

const it = createInterpreter({
  modules: [json, collections, itertools, functools, string, random],
  tools: { double: tool({ params: { n: 'int' }, handler: ({ n }) => n * 2 }) },
});
assert.equal(await it.run(`
import json, random, string
from collections import Counter
from itertools import islice, count
from functools import reduce
random.seed(42)
json.dumps([Counter("abracadabra").most_common(1), list(islice(count(), 3)), reduce(lambda a, b: a + b, [1, 2, 3]), string.digits[:3], random.randint(1, 100), double(n=21)])
`), '[[["a", 5]], [0, 1, 2], 6, "012", 82, 42]');
await assert.rejects(it.run('nope'), NameError);
assert.match(generateToolsPrompt({ double: (n) => n }), /- double\(n\)/);

const w = createWorkerInterpreter({ tools: { double: (n) => n * 2 }, timeoutMs: 500 });
assert.equal(await w.run('double(4)'), 8);
await assert.rejects(w.run('import re\nre.match(r"(a+)+$", "a" * 40 + "b")'), (e) => e.name === 'TimeoutError');
await w.terminate();

console.log('smoke ok', process.version);
