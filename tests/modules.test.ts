/**
 * The opt-in modules: how a host registers them, and the paths CPython
 * cannot check (tool calls inside their callbacks).
 */

import { describe, test, expect } from 'bun:test';
import { createInterpreter, runPython } from '../src';
import { collections } from '../src/collections';
import { functools } from '../src/functools';
import { itertools } from '../src/itertools';
import { json } from '../src/json';
import { random } from '../src/random';
import { string } from '../src/string';

const later = <T>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), 0));
const tools = [{ name: 'double', handler: (n: number) => later(n * 2) }, { name: 'label', handler: (v: any) => later(`<${v}>`) }];

describe('registering modules', () => {
  test('a module is importable only on interpreters that were given it', async () => {
    await expect(runPython('import json')).rejects.toThrow("No module named 'json'");
    expect(await createInterpreter({ modules: [json] }).run('import json\njson.dumps([1])')).toBe('[1]');
    await expect(createInterpreter({ modules: [json] }).run('import itertools')).rejects.toThrow("No module named 'itertools'");
  });

  test('all import forms work for a registered module', async () => {
    const it = createInterpreter({ modules: [json, itertools, collections] });
    expect(await it.run('import json as j\nj.loads("2")')).toBe(2);
    expect(await it.run('from itertools import chain\nlist(chain([1], [2]))')).toEqual([1, 2]);
    expect(await it.run('from collections import *\nCounter("aa")["a"]')).toBe(2);
    expect(await it.run('import collections\ntype(collections.deque()).__name__')).toBe('deque');
    const more = createInterpreter({ modules: [functools, string, random] });
    expect(await more.run('from functools import reduce\nreduce(lambda a, b: a + b, [1, 2, 3])')).toBe(6);
    expect(await more.run('import string\nstring.digits')).toBe('0123456789');
    expect(await more.run('import random\n0 <= random.random() < 1')).toBe(true);
  });

  test('a module cannot replace a built-in one', () => {
    expect(() => createInterpreter({ modules: [{ ...json, name: 'math' } as any] })).toThrow("Module 'math' is already provided");
  });
});

describe('tool calls inside module callbacks', () => {
  test('json.dumps default=', async () => {
    const it = createInterpreter({ modules: [json], tools });
    expect(await it.run('import json\nfrom datetime import date\njson.dumps({"d": date(2026, 1, 2), "n": [date(2026, 3, 4)]}, default=lambda v: label(v.isoformat()))'))
      .toBe('{"d": "<2026-01-02>", "n": ["<2026-03-04>"]}');
  });

  test('itertools callbacks and lazily consumed tool results', async () => {
    const it = createInterpreter({ modules: [itertools], tools });
    expect(await it.run('from itertools import *\nlist(starmap(lambda a, b: double(a) + b, [(1, 1), (2, 2)]))')).toEqual([3, 6]);
    expect(await it.run('from itertools import *\n[(k, list(g)) for k, g in groupby([1, 2, 3, 4], key=lambda x: double(x) > 4)]')).toEqual([[false, [1, 2]], [true, [3, 4]]]);
    expect(await it.run('from itertools import *\nlist(takewhile(lambda x: double(x) < 6, [1, 2, 3, 1]))')).toEqual([1, 2]);
    expect(await it.run('from itertools import *\nlist(accumulate([1, 2, 3], lambda a, b: double(a) + b))')).toEqual([1, 4, 11]);
    expect(await it.run('from itertools import *\nlist(islice((double(x) for x in count()), 3))')).toEqual([0, 2, 4]);
    expect(await it.run('from itertools import *\nlist(chain.from_iterable([double(x)] for x in range(3)))')).toEqual([0, 2, 4]);
    expect(await it.run('from itertools import *\nlist(zip_longest((double(x) for x in range(2)), "abc"))')).toEqual([[0, 'a'], [2, 'b'], [null, 'c']]);
  });

  test('collections built from tool-driven iterables', async () => {
    const it = createInterpreter({ modules: [collections], tools });
    expect(await it.run('from collections import Counter\nCounter(double(x) % 3 for x in range(6)).most_common(1)')).toEqual([[0, 2]]);
    expect(await it.run('from collections import deque\nd = deque(maxlen=2)\nd.extend(double(x) for x in range(4))\nlist(d)')).toEqual([4, 6]);
    expect(await it.run('from collections import defaultdict\nd = defaultdict(list)\nfor x in range(3):\n    d[double(x) % 2].append(x)\ndict(d)')).toEqual({ 0: [0, 1, 2] });
    expect(await it.run('from collections import defaultdict\nd = defaultdict(lambda: double(1))\n[d["k"], d["k"], dict(d)]')).toEqual([2, 2, { k: 2 }]);
  });

  test('functools callbacks that call tools', async () => {
    const it = createInterpreter({ modules: [functools], tools });
    expect(await it.run('from functools import reduce\nreduce(lambda a, b: a + double(b), [1, 2, 3], 10)')).toBe(22);
    expect(await it.run('from functools import partial\npartial(double)(21)')).toBe(42);
    expect(await it.run('from functools import lru_cache\n@lru_cache\ndef f(n):\n    return double(n)\n[f(2), f(2), f.cache_info().hits]')).toEqual([4, 4, 1]);
    expect(await it.run('from functools import cmp_to_key\nsorted(["bb", "a", "ccc"], key=cmp_to_key(lambda a, b: double(len(a)) - double(len(b))))')).toEqual(['a', 'bb', 'ccc']);
    expect(await it.run('from functools import cmp_to_key\nsorted([3, 1, 2], key=cmp_to_key(lambda a, b: double(b) - double(a)), reverse=True)')).toEqual([1, 2, 3]);
    expect(await it.run('from functools import cmp_to_key\nK = cmp_to_key(lambda a, b: double(a) - double(b))\n[max([3, 1, 2], key=K), min([3, 1, 2], key=K), K(1) < K(2)]')).toEqual([3, 1, true]);
  });

  test('random callbacks and iterables that call tools', async () => {
    const it = createInterpreter({ modules: [random], tools });
    expect(await it.run('import random\nrandom.seed(1)\nrandom.choices([1, 2], weights=(double(w) for w in [1, 0]), k=3)')).toEqual([1, 1, 1]);
    expect(await it.run('import random\nrandom.seed(1)\nrandom.sample([7, 8], 2, counts=(double(c) for c in [1, 0]))')).toEqual([7, 7]);
  });
});

describe('random', () => {
  test('unseeded runs differ, seeded runs repeat', async () => {
    const draws = new Set<number>();
    for (let i = 0; i < 50; i++) draws.add(await createInterpreter({ modules: [random] }).run('import random\nrandom.random()'));
    expect(draws.size).toBe(50);
    const a = await createInterpreter({ modules: [random] }).run('import random\nrandom.seed(42)\n[random.random(), random.randint(1, 100)]');
    const b = await createInterpreter({ modules: [random] }).run('import random\nrandom.seed(42)\n[random.random(), random.randint(1, 100)]');
    expect(a).toEqual([0.6394267984578837, 4]);
    expect(b).toEqual(a);
  });

  test('randint stays in range and covers it', async () => {
    const faces = await createInterpreter({ modules: [random] }).run('import random\nsorted({random.randint(1, 6) for _ in range(5000)})');
    expect(faces).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('each interpreter owns its generator, and keeps it across runs', async () => {
    const one = createInterpreter({ modules: [random] });
    const two = createInterpreter({ modules: [random] });
    await one.run('import random\nrandom.seed(5)');
    await two.run('import random\nrandom.seed(5)\nrandom.random()');
    // `two` is one draw ahead; `one` must not have moved with it.
    expect(await one.run('import random\nrandom.random()')).toBe(0.6229016948897019);
    expect(await two.run('import random\nrandom.random()')).not.toBe(0.6229016948897019);
  });

  test('Random instances are independent of the module generator', async () => {
    const it = createInterpreter({ modules: [random] });
    expect(await it.run('import random\nrandom.seed(5)\nr = random.Random(5)\n[r.random(), r.random(), random.random()]'))
      .toEqual([0.6229016948897019, 0.7417869892607294, 0.6229016948897019]);
  });
});

describe('limits still apply inside the modules', () => {
  test('infinite iterators cannot be drained by a built-in', async () => {
    const it = createInterpreter({ modules: [itertools], limits: { maxCollectionSize: 1000 }, maxIterations: 10_000 });
    await expect(it.run('from itertools import count\nlist(count())')).rejects.toThrow('maximum collection size');
    await expect(it.run('from itertools import cycle\nsum(cycle([1]))')).rejects.toThrow('maximum collection size');
    await expect(it.run('from itertools import repeat\nsum(x for x in repeat(1))')).rejects.toThrow(/Maximum iterations|maximum collection size/);
    await expect(it.run('from itertools import product\nlen(list(product(range(100), repeat=3)))')).rejects.toThrow('maximum collection size');
  });

  test('lru_cache recursion stops with a RecursionError, not a crash', async () => {
    const it = createInterpreter({ modules: [functools] });
    await expect(it.run('from functools import lru_cache\n@lru_cache\ndef f(n):\n    return 0 if n == 0 else f(n - 1) + 1\nf(5000)')).rejects.toThrow('maximum recursion depth');
    expect(await it.run('from functools import lru_cache\n@lru_cache\ndef f(n):\n    return 0 if n == 0 else f(n - 1) + 1\nf(400)')).toBe(400);
  });

  test('json output respects the string limit', async () => {
    const it = createInterpreter({ modules: [json], limits: { maxStringLength: 1000 } });
    await expect(it.run('import json\njson.dumps(["x" * 300] * 10)')).rejects.toThrow('maximum string length');
  });
});
