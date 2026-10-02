/**
 * Tests for the parts of the runtime that CPython cannot check for us:
 * tool calls that pause the script, host resource bounds, and what crosses
 * the boundary between the sandbox and the host.
 */

import { describe, test, expect } from 'bun:test';
import {
  createInterpreter, runPython, ToolDefinition,
  MaxIterationsError, MemoryError, RecursionError, TimeoutError, ToolError,
} from '../src';
import { makeIntlConverter, makeTzConverter } from '../src/datetime';

/** Tools that resolve on a later tick, so every call really suspends. */
function asyncTools(log: string[] = []): ToolDefinition[] {
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));
  return [
    { name: 'double', handler: (n: number) => { log.push(`double(${n})`); return later(n * 2); } },
    { name: 'fetch_rows', handler: () => later([{ id: 1, amount: 10.5 }, { id: 2, amount: 4 }, { id: 3, amount: null }]) },
    { name: 'is_even', handler: (n: number) => later(n % 2 === 0) },
    { name: 'fail', handler: () => later(0).then(() => { throw new Error('backend down'); }) },
    { name: 'sync_double', handler: (n: number) => n * 2 },
  ];
}

async function run(code: string, log: string[] = []): Promise<any> {
  return createInterpreter({ tools: asyncTools(log) }).run(code);
}

describe('tool calls suspend the script wherever they occur', () => {
  test('in expressions, arguments and assignments', async () => {
    expect(await run('double(1) + double(2) * double(3)')).toBe(26);
    expect(await run('x = double(double(double(1)))\nx')).toBe(8);
    expect(await run('a, b = double(1), double(2)\n[a, b]')).toEqual([2, 4]);
    expect(await run('d = {"k": double(4)}\nd["k"] += double(1)\nd')).toEqual({ k: 10 });
    expect(await run('f"{double(2)} and {double(3):>4}"')).toBe('4 and    6');
    expect(await run('double(1) if is_even(2) else double(5)')).toBe(2);
    expect(await run('is_even(1) or double(7)')).toBe(14);
    expect(await run('1 < double(1) < double(2)')).toBe(true);
  });

  test('in loops and conditions', async () => {
    expect(await run(`
total = 0
for i in range(4):
    if is_even(i):
        total += double(i)
total
`)).toBe(4);
    expect(await run(`
n = 1
while double(n) < 20:
    n += 1
n
`)).toBe(10);
  });

  test('evaluates calls in source order', async () => {
    const log: string[] = [];
    await run('[double(1), double(2)] + [double(x) for x in (3, 4)]', log);
    expect(log).toEqual(['double(1)', 'double(2)', 'double(3)', 'double(4)']);
  });

  test('in comprehensions and generator expressions', async () => {
    expect(await run('[double(x) for x in range(3)]')).toEqual([0, 2, 4]);
    expect(await run('{x: double(x) for x in range(3) if is_even(x)}')).toEqual({ 0: 0, 2: 4 });
    expect(await run('sum(double(x) for x in range(4))')).toBe(12);
    expect(await run('", ".join(str(double(x)) for x in range(3))')).toBe('0, 2, 4');
    expect(await run('list(double(x) for x in range(3))')).toEqual([0, 2, 4]);
    expect(await run('max(double(x) for x in range(3))')).toBe(4);
    expect(await run('any(is_even(x) for x in [1, 3, 4])')).toBe(true);
    expect(await run('4 in (double(x) for x in range(5))')).toBe(true);
    expect(await run('a, b = (double(x) for x in (1, 2))\n[a, b]')).toEqual([2, 4]);
    expect(await run('[*(double(x) for x in (1, 2)), 9]')).toEqual([2, 4, 9]);
  });

  test('inside functions, closures, lambdas and decorators', async () => {
    expect(await run(`
def total(rows):
    return sum(r["amount"] or 0 for r in rows)
total(fetch_rows())
`)).toBe(14.5);
    expect(await run(`
def twice(fn):
    def wrapper(n):
        return fn(fn(n))
    return wrapper
@twice
def bump(n):
    return double(n) + 1
bump(1)
`)).toBe(7);
    expect(await run('def f(n=double(5)):\n    return n\nf()')).toBe(10);
    expect(await run('(lambda n: double(n) + 1)(3)')).toBe(7);
  });

  test('as callbacks of built-ins', async () => {
    expect(await run('sorted([3, 1, 2], key=lambda n: -double(n))')).toEqual([3, 2, 1]);
    expect(await run('list(map(double, [1, 2, 3]))')).toEqual([2, 4, 6]);
    expect(await run('list(filter(is_even, range(5)))')).toEqual([0, 2, 4]);
    expect(await run('max([1, 5, 3], key=double)')).toBe(5);
    expect(await run('items = [3, 1, 2]\nitems.sort(key=double, reverse=True)\nitems')).toEqual([3, 2, 1]);
    expect(await run('import re\nre.sub(r"\\d", lambda m: str(double(int(m.group()))), "a1b2")')).toBe('a2b4');
    expect(await run('list(zip(map(double, [1, 2]), "ab"))')).toEqual([[2, 'a'], [4, 'b']]);
    expect(await run('[(i, v) for i, v in enumerate(map(double, [5, 6]))]')).toEqual([[0, 10], [1, 12]]);
  });

  test('inside generators', async () => {
    expect(await run(`
def doubled(ns):
    for n in ns:
        yield double(n)
def both():
    yield from doubled([1, 2])
    yield double(10)
list(both())
`)).toEqual([2, 4, 20]);
    expect(await run(`
def doubled(ns):
    for n in ns:
        yield double(n)
g = doubled([1, 2, 3])
[next(g), next(g), next(g, "done"), next(g, "done")]
`)).toEqual([2, 4, 6, 'done']);
    expect(await run(`
def doubled(ns):
    for n in ns:
        yield double(n)
out = []
for v in doubled(range(3)):
    out.append(v)
out
`)).toEqual([0, 2, 4]);
  });

  test('with keyword and spread arguments', async () => {
    const calls: any[][] = [];
    const interpreter = createInterpreter({
      tools: [{ name: 'record', handler: async (...args: any[]) => { calls.push(args); return args.length; } }],
    });
    await interpreter.run('record()\nrecord("a")\nrecord("a", x=1)\nrecord(*[1, 2], **{"k": (3, 4)})');
    expect(calls).toEqual([[{}], ['a', {}], ['a', { x: 1 }], [1, 2, { k: [3, 4] }]]);
  });

  test('a sync tool behaves the same as an async one', async () => {
    expect(await run('[sync_double(x) for x in range(3)]')).toEqual([0, 2, 4]);
  });
});

describe('tool failures', () => {
  test('are catchable where they happen', async () => {
    expect(await run(`
try:
    fail()
except ToolError as e:
    result = f"{type(e).__name__}: {e}"
result
`)).toBe("ToolError: Tool 'fail' failed: backend down");
  });

  test('propagate through generators and callbacks, and finally still runs', async () => {
    expect(await run(`
log = []
def gen():
    try:
        yield double(1)
        yield fail()
    finally:
        log.append("gen finally")
try:
    for v in gen():
        log.append(v)
except RuntimeError as e:
    log.append("caught")
finally:
    log.append("outer finally")
log
`)).toEqual([2, 'gen finally', 'caught', 'outer finally']);
    expect(await run(`
try:
    sorted([1, 2], key=lambda n: fail())
except Exception as e:
    result = type(e).__name__
result
`)).toBe('ToolError');
  });

  test('reach the host with the call position when uncaught', async () => {
    const error = await run('x = 1\ny = fail()').catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toBe("Line 2, Column 5: Tool 'fail' failed: backend down");
    expect(error.line).toBe(2);
  });
});

describe('host resource bounds', () => {
  test('runaway recursion is a catchable RecursionError, not a JS stack overflow', async () => {
    await expect(runPython('def f(n):\n    return f(n + 1)\nf(0)')).rejects.toBeInstanceOf(RecursionError);
    expect(await runPython(`
def f(n):
    return f(n + 1)
try:
    f(0)
except RecursionError:
    result = "recovered"
result
`)).toBe('recovered');
    expect(await runPython('def depth(n):\n    return 0 if n == 0 else 1 + depth(n - 1)\ndepth(900)')).toBe(900);
  });

  test('deeply nested data does not overflow the host stack', async () => {
    await expect(runPython('a = []\nfor i in range(200000):\n    a = [a]\nstr(a)')).rejects.toBeInstanceOf(RecursionError);
    await expect(runPython('a = []\nfor i in range(200000):\n    a = [a]\na')).rejects.toBeInstanceOf(RecursionError);
  });

  test('recursion through a built-in callback is bounded before the JS stack runs out', async () => {
    const viaSortKey = 'def f(n):\n    return 0 if n == 0 else sorted([n], key=lambda x: f(n - 1))[0]\n';
    expect(await runPython(viaSortKey + 'f(50)')).toBe(50);
    const error = await runPython(viaSortKey + 'f(5000)').catch((e) => e);
    expect(error).toBeInstanceOf(RecursionError);
    expect(error.message).toMatch(/^Line \d+, Column \d+: maximum recursion depth exceeded$/);
    expect(await runPython(viaSortKey + 'try:\n    f(5000)\nexcept RecursionError:\n    r = "recovered"\nr')).toBe('recovered');
    await expect(runPython('def f(n):\n    return list(map(f, [n + 1]))\nf(0)')).rejects.toBeInstanceOf(RecursionError);
  });

  test('generators nest and comprehensions recurse as deep as plain calls', async () => {
    expect(await runPython('def nest(n):\n    if n > 0:\n        yield from nest(n - 1)\n    yield n\nlen(list(nest(900)))')).toBe(901);
    expect(await runPython('def f(n):\n    return 0 if n == 0 else [f(n - 1) for _ in range(1)][0] + 1\nf(700)')).toBe(700);
  });

  test('maxIterations bounds loops', async () => {
    const interpreter = createInterpreter({ maxIterations: 1000 });
    expect(await interpreter.run('t = 0\nfor i in range(900):\n    t += i\nt')).toBe(404550);
    await expect(interpreter.run('while True:\n    pass')).rejects.toBeInstanceOf(MaxIterationsError);
    await expect(interpreter.run('[x for x in range(5000)]')).rejects.toBeInstanceOf(MaxIterationsError);
    await expect(interpreter.run('def g():\n    while True:\n        yield 1\nsum(g())')).rejects.toBeInstanceOf(MaxIterationsError);
  });

  test('maxIterations counts loops over tool-driven iterators', async () => {
    let calls = 0;
    const interpreter = createInterpreter({
      maxIterations: 100,
      tools: [{ name: 'tool', handler: async (n: number) => { calls++; return n; } }],
    });
    await expect(interpreter.run('n = 0\nfor x in map(tool, range(3000)):\n    n += 1')).rejects.toBeInstanceOf(MaxIterationsError);
    expect(calls).toBeLessThan(200);
    await expect(interpreter.run('for x in filter(tool, range(1, 3000)):\n    pass')).rejects.toBeInstanceOf(MaxIterationsError);
    await expect(interpreter.run('def g():\n    while True:\n        yield tool(1)\nfor x in g():\n    pass')).rejects.toBeInstanceOf(MaxIterationsError);
  });

  test('maxIterations also bounds recursion that never loops', async () => {
    const interpreter = createInterpreter({ maxIterations: 10_000 });
    const fib = 'def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n';
    expect(await interpreter.run(fib + 'fib(15)')).toBe(610);
    await expect(interpreter.run(fib + 'fib(40)')).rejects.toBeInstanceOf(MaxIterationsError);
  });

  test('the bounds cannot be caught or outlasted by a finally block', async () => {
    const interpreter = createInterpreter({ maxIterations: 1000 });
    await expect(interpreter.run(`
while True:
    try:
        pass
    except:
        pass
`)).rejects.toBeInstanceOf(MaxIterationsError);
    await expect(interpreter.run(`
while True:
    try:
        while True:
            pass
    finally:
        continue
`)).rejects.toBeInstanceOf(MaxIterationsError);
    await expect(interpreter.run(`
def f():
    try:
        while True:
            pass
    except BaseException:
        return "swallowed"
    finally:
        return "swallowed"
f()
`)).rejects.toThrow();
  });

  test('timeoutMs stops a busy script and a slow tool', async () => {
    await expect(createInterpreter({ timeoutMs: 30, maxIterations: Infinity }).run('n = 0\nwhile True:\n    n += 1'))
      .rejects.toBeInstanceOf(TimeoutError);
    const slow = createInterpreter({
      timeoutMs: 20,
      tools: [{ name: 'slow', handler: () => new Promise((resolve) => setTimeout(resolve, 60)) }],
    });
    await expect(slow.run('try:\n    slow()\nexcept:\n    pass\n"survived"')).rejects.toBeInstanceOf(TimeoutError);
  });

  test('timeoutMs covers long built-in calls and tools that never answer', async () => {
    const started = Date.now();
    await expect(createInterpreter({ timeoutMs: 100, maxIterations: Infinity })
      .run('big = list(range(300000))\nwhile True:\n    sorted(big)')).rejects.toBeInstanceOf(TimeoutError);
    const stuck = createInterpreter({ timeoutMs: 50, tools: [{ name: 'hang', handler: () => new Promise(() => {}) }] });
    await expect(stuck.run('hang()')).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('repeating an empty sequence a huge number of times returns at once', async () => {
    expect(await runPython('[len([] * 10 ** 12), len(() * 10 ** 12), "" * 10 ** 12]', [], { timeoutMs: 1000 })).toEqual([0, 0, '']);
  });

  test('indexing a long string in a loop stays linear', async () => {
    const loop = 'i = 0\nn = 0\nwhile i < len(s):\n    if s[i] == "a":\n        n += 1\n    i += 1\nn';
    expect(await runPython('s = "ab" * 100000\n' + loop, [], { timeoutMs: 3000 })).toBe(100000);
    expect(await runPython('s = "a\\U0001F600" * 20000\n' + loop, [], { timeoutMs: 3000 })).toBe(20000);
  });

  test('built-ins cannot be used to loop or allocate past the limits', async () => {
    const limits = { maxCollectionSize: 1000, maxStringLength: 1000 };
    const interpreter = createInterpreter({ limits });
    for (const code of [
      'sum(range(10 ** 12))',
      'list(range(10 ** 9))',
      'list(zip(range(10 ** 9), range(10 ** 9)))',
      'list(reversed(range(10 ** 9)))',
      'sorted(range(5000))',
      '[0] * 5000',
      '"x" * 5000',
      '"-".join(["ab"] * 600)',
      '"x".ljust(5000)',
      'f"{1:>5000000}"',
      'a = [1] * 600\na += a\na',
      'range(5000)',
    ]) {
      await expect(interpreter.run(code)).rejects.toBeInstanceOf(MemoryError);
    }
    expect(await interpreter.run('len(range(10 ** 12))')).toBe(10 ** 12);
    expect(await interpreter.run('10 ** 11 in range(10 ** 12)')).toBe(true);
    expect(await interpreter.run('t = 0\nfor i in range(10 ** 12):\n    t += i\n    if i == 5: break\nt')).toBe(15);
  });

  test('huge integers are bounded', async () => {
    await expect(runPython('2 ** (10 ** 9)')).rejects.toBeInstanceOf(MemoryError);
    await expect(runPython('1 << (10 ** 9)')).rejects.toBeInstanceOf(MemoryError);
    await expect(runPython('x = 2 ** 900000\nx * x')).rejects.toBeInstanceOf(MemoryError);
    await expect(runPython('str(10 ** 5000)')).rejects.toThrow('Exceeds the limit (4300 digits)');
    await expect(runPython('int("9" * 5000)')).rejects.toThrow('Exceeds the limit (4300 digits)');
    expect(await runPython('len(str(10 ** 4000))')).toBe(4001);
  });

  test('a memory error is an ordinary Python exception', async () => {
    expect(await runPython('try:\n    x = [0] * 10 ** 9\nexcept MemoryError:\n    x = "too big"\nx')).toBe('too big');
  });
});

describe('the sandbox boundary', () => {
  test('a "__proto__" key stays an ordinary key on results and tool arguments', async () => {
    const result = await runPython('{"__proto__": {"isAdmin": True}, "a": 1}');
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'a']);
    expect(result.isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);

    let received: any;
    const interpreter = createInterpreter({ tools: [{ name: 'take', handler: (arg: any, kwargs: any) => { received = { arg, kwargs }; } }] });
    await interpreter.run('take({"__proto__": {"isAdmin": True}}, **{"__proto__": 1, "constructor": 2})');
    expect(received.arg.isAdmin).toBeUndefined();
    expect(Object.keys(received.arg)).toEqual(['__proto__']);
    expect(Object.keys(received.kwargs).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(received.kwargs)).toBe(Object.prototype);
    expect(({} as any).isAdmin).toBeUndefined();
  });

  test('JS object internals are not reachable as attributes or names', async () => {
    for (const code of [
      '"a".constructor', '[].constructor', '{}.__proto__', '(1).__class__', '"a".__class__',
      'len.constructor', 'len.__proto__', 'str.constructor', 'str.__proto__', 'str.prototype',
      'import math\nmath.constructor', 'import re\nre.compile("a").constructor', 'ValueError("x").constructor',
      '"{0.__class__}".format(1)', '"{0.constructor}".format([])', 'getattr("a", "constructor")',
      'def f(): pass\nf.constructor', '(x for x in []).constructor', 'range(3).constructor',
    ]) {
      await expect(runPython(code)).rejects.toThrow('has no attribute');
    }
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'globalThis', 'process', 'require']) {
      await expect(runPython(name)).rejects.toThrow(`name '${name}' is not defined`);
      await expect(runPython(`from math import ${name}`)).rejects.toThrow('cannot import name');
    }
    expect(await runPython('d = {}\nd["constructor"] = 1\nd["__proto__"] = 2\n["toString" in d, len(d), d["__proto__"]]')).toEqual([false, 2, 2]);
    expect(await runPython('def f(**kw):\n    return sorted(kw)\nf(**{"__proto__": 1, "constructor": 2})')).toEqual(['__proto__', 'constructor']);
  });

  test('absent built-ins say why they are absent', async () => {
    await expect(runPython('open("/etc/passwd")')).rejects.toThrow("name 'open' is not defined — file access is not available in this sandbox");
    await expect(runPython('eval("1")')).rejects.toThrow('dynamic code execution is not available');
    await expect(runPython('import os')).rejects.toThrow("No module named 'os'");
    await expect(runPython('__import__("os")')).rejects.toThrow('only whitelisted modules can be imported');
  });

  test('values marshal across the boundary by type', async () => {
    const seen: any[] = [];
    const interpreter = createInterpreter({ tools: [{ name: 'echo', handler: (v: any) => { seen.push(v); return v; } }] });
    const result = await interpreter.run(`
values = echo({"int": 3, "float": 2.5, "whole": 4.0, "big": 2 ** 60, "none": None, "flag": True,
               "tuple": (1, 2), "set": {7}, "nested": [{"k": (1,)}], 5: "int key", (1, 2): "tuple key"})
[type(values["int"]).__name__, type(values["float"]).__name__, type(values["whole"]).__name__,
 type(values["tuple"]).__name__, values["none"] is None, values["5"]]
`);
    expect(seen[0]).toEqual({
      int: 3, float: 2.5, whole: 4, big: 2 ** 60, none: null, flag: true,
      tuple: [1, 2], set: [7], nested: [{ k: [1] }], 5: 'int key', '(1, 2)': 'tuple key',
    });
    expect(result).toEqual(['int', 'float', 'int', 'list', true, 'int key']);
  });

  test('large integers stay exact inside the sandbox', async () => {
    expect(await runPython('str(2 ** 100)')).toBe('1267650600228229401496703205376');
    expect(await runPython('2 ** 100 // 2 ** 90')).toBe(1024);
    expect(await runPython('2 ** 100')).toBe(2 ** 100);
  });

  test('globals persist across runs of one interpreter and never leak between interpreters', async () => {
    const a = createInterpreter();
    await a.run('counter = 1\ndef bump():\n    global counter\n    counter += 1\n    return counter');
    expect(await a.run('bump()\nbump()')).toBe(3);
    await expect(createInterpreter().run('counter')).rejects.toThrow("name 'counter' is not defined");
  });

  test('runPython accepts a print callback or an options object', async () => {
    const printed: string[] = [];
    await runPython('print("a")', [], (line) => printed.push(line));
    await runPython('print("b")', [], { onPrint: (line) => printed.push(line) });
    expect(printed).toEqual(['a', 'b']);
    await expect(runPython('while True:\n    pass', [], { timeoutMs: 20, maxIterations: Infinity })).rejects.toBeInstanceOf(TimeoutError);
    await expect(runPython('[0] * 100', [], { limits: { maxCollectionSize: 10 } })).rejects.toBeInstanceOf(MemoryError);
  });
});

describe('session timezone conversion', () => {
  test('the cached-offset path agrees with Intl for every instant, across DST changes', () => {
    const zones = ['Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/Sao_Paulo', 'UTC'];
    const start = Date.UTC(2025, 11, 1);
    const end = Date.UTC(2027, 1, 1);
    const step = 37 * 60_000 + 1_234; // lands on odd minutes, seconds and milliseconds
    for (const zone of zones) {
      const fast = makeTzConverter(zone);
      const viaIntl = makeIntlConverter(zone);
      for (let ms = start; ms < end; ms += step) {
        const got = fast(ms);
        const want = viaIntl(ms);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(`${zone} at ${new Date(ms).toISOString()}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        }
      }
    }
  });

  test('the minutes around a DST change convert exactly', () => {
    const fast = makeTzConverter('Europe/Berlin');
    const viaIntl = makeIntlConverter('Europe/Berlin');
    // Clocks go forward at 2026-03-29 01:00 UTC and back at 2026-10-25 01:00 UTC.
    for (const change of [Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1)]) {
      for (let ms = change - 3 * 3_600_000; ms <= change + 3 * 3_600_000; ms += 59_000) {
        expect(fast(ms)).toEqual(viaIntl(ms));
      }
    }
    expect(fast(Date.UTC(2026, 2, 29, 0, 59, 59))).toMatchObject({ hour: 1, minute: 59 });
    expect(fast(Date.UTC(2026, 2, 29, 1, 0, 0))).toMatchObject({ hour: 3, minute: 0 });
  });

  test('a date the sandbox cannot represent is an error, not a garbled datetime', async () => {
    for (const timezone of ['UTC', 'Europe/Berlin']) {
      const invalid = createInterpreter({ timezone, tools: [{ name: 'row', handler: () => ({ at: new Date('not a date') }) }] });
      await expect(invalid.run('row()')).rejects.toThrow('invalid date');
      const ancient = createInterpreter({ timezone, tools: [{ name: 'row', handler: () => ({ at: new Date(-1e14) }) }] });
      await expect(ancient.run('row()')).rejects.toThrow('date value out of range');
    }
    await expect(runPython('from datetime import datetime\ndatetime.fromisoformat("0001-01-01T00:00:00+05:00")'))
      .rejects.toThrow('date value out of range');
    expect(await runPython('from datetime import datetime\nstr(datetime.fromisoformat("0001-01-01T05:00:00+05:00"))'))
      .toBe('0001-01-01 00:00:00');
  });

  test('a host clock with sub-millisecond precision keeps its microseconds', async () => {
    const code = 'from datetime import datetime\ndatetime.now().microsecond';
    expect(await createInterpreter({ now: () => 1700000000123.75 }).run(code)).toBe(123750);
    expect(await createInterpreter({ now: () => 1700000000123.75, timezone: 'America/New_York' }).run(code)).toBe(123750);
    expect(await createInterpreter({ now: () => 1700000000123 }).run(code)).toBe(123000);
  });

  test('rows spread over more days than the cache holds still convert correctly', () => {
    const fast = makeTzConverter('Asia/Kolkata');
    const viaIntl = makeIntlConverter('Asia/Kolkata');
    for (let day = 0; day < 9000; day += 1) {
      const ms = Date.UTC(1990, 0, 1) + day * 86_400_000 + (day % 24) * 3_600_000 + 123;
      if (JSON.stringify(fast(ms)) !== JSON.stringify(viaIntl(ms))) throw new Error(`mismatch at ${new Date(ms).toISOString()}`);
    }
    // And again, now that the oldest days have been evicted.
    for (let day = 0; day < 9000; day += 97) {
      const ms = Date.UTC(1990, 0, 1) + day * 86_400_000 + 5_000;
      expect(fast(ms)).toEqual(viaIntl(ms));
    }
  });

  test('tool dates arrive as wall-clock time in the session timezone', async () => {
    const rows = [{ at: new Date('2026-07-01T22:30:00.250Z') }, { at: new Date('2026-01-01T22:30:00Z') }, { at: new Date('1969-12-31T23:59:59.500Z') }];
    const code = '[str(r["at"]) for r in rows()]';
    const tools = [{ name: 'rows', handler: () => rows }];
    expect(await createInterpreter({ tools }).run(code))
      .toEqual(['2026-07-01 22:30:00.250000', '2026-01-01 22:30:00', '1969-12-31 23:59:59.500000']);
    expect(await createInterpreter({ tools, timezone: 'Europe/Berlin' }).run(code))
      .toEqual(['2026-07-02 00:30:00.250000', '2026-01-01 23:30:00', '1970-01-01 00:59:59.500000']);
  });
});

describe('top-level names on a reused interpreter', () => {
  test('a function sees a global defined in a later run', async () => {
    const it = createInterpreter();
    await it.run('def show():\n    return later');
    await expect(it.run('show()')).rejects.toThrow("name 'later' is not defined");
    await it.run('later = 42');
    expect(await it.run('show()')).toBe(42);
    await it.run('later = "rebound"');
    expect(await it.run('show()')).toBe('rebound');
  });

  test('shadowing a built-in lasts until the name is deleted', async () => {
    const it = createInterpreter();
    await it.run('len = lambda x: "shadowed"');
    expect(await it.run('len([1, 2])')).toBe('shadowed');
    expect(await it.run('def f():\n    return len([1, 2])\nf()')).toBe('shadowed');
    await it.run('del len');
    expect(await it.run('[len([1, 2]), f()]')).toEqual([2, 2]);
    await expect(it.run('del len')).rejects.toThrow("name 'len' is not defined");
  });

  test('a tool is found like a built-in and can be shadowed', async () => {
    const it = createInterpreter({ tools: [{ name: 'get', handler: () => 'tool' }] });
    expect(await it.run('get()')).toBe('tool');
    await it.run('get = lambda: "script"');
    expect(await it.run('get()')).toBe('script');
    await it.run('del get');
    expect(await it.run('get()')).toBe('tool');
  });

  test('global statements, import * and comprehensions all reach the same variables', async () => {
    const it = createInterpreter();
    await it.run('total = 1\ndef add(n):\n    global total, created\n    total += n\n    created = "by function"');
    await it.run('add(4)');
    expect(await it.run('[total, created]')).toEqual([5, 'by function']);
    await it.run('from math import *');
    expect(await it.run('floor(sqrt(17))')).toBe(4);
    await it.run('sqrt = "mine"');
    expect(await it.run('sqrt')).toBe('mine');
    expect(await it.run('scale = 3\n[x * scale for x in range(3)]')).toEqual([0, 3, 6]);
    expect(await it.run('x = "kept"\n[x for x in range(2)]\nx')).toBe('kept');
  });

  test('a deleted name is undefined again, and a failed run keeps what it assigned', async () => {
    const it = createInterpreter();
    await it.run('value = 1');
    await it.run('del value');
    await expect(it.run('value')).rejects.toThrow("name 'value' is not defined");
    await expect(it.run('kept = 7\n1 / 0')).rejects.toThrow('division by zero');
    expect(await it.run('kept')).toBe(7);
    await expect(it.run('def f():\n    return undefined_helper()\nf()')).rejects.toThrow("name 'undefined_helper' is not defined");
  });

  test('two interpreters never share a name, even one with the same spelling', async () => {
    const a = createInterpreter();
    const b = createInterpreter();
    await a.run('shared = "a"\ndef get():\n    return shared');
    await b.run('shared = "b"\ndef get():\n    return shared');
    expect(await a.run('get()')).toBe('a');
    expect(await b.run('get()')).toBe('b');
  });
});

describe('the package entry point', () => {
  test('does not export `then`, which would make `await import()` treat the module as a promise', async () => {
    const entry = await import('../src');
    expect(Object.keys(entry)).not.toContain('then');
    expect(typeof entry.runPython).toBe('function');
  });
});

describe('the value of a run', () => {
  test('is the last expression statement, through branches and loops', async () => {
    expect(await runPython('1\n2')).toBe(2);
    expect(await runPython('x = 5')).toBeNull();
    expect(await runPython('5\nx = 1')).toBeNull();
    expect(await runPython('if True:\n    "yes"\nelse:\n    "no"')).toBe('yes');
    expect(await runPython('for i in range(3):\n    i * 2')).toBe(4);
    expect(await runPython('try:\n    1 / 0\nexcept ZeroDivisionError:\n    "handled"')).toBe('handled');
    expect(await runPython('def f():\n    return 1')).toBeNull();
  });

  test('lazy iterators and views reach the host as arrays', async () => {
    expect(await runPython('zip([1, 2], "ab")')).toEqual([[1, 'a'], [2, 'b']]);
    expect(await runPython('map(str, [1, 2])')).toEqual(['1', '2']);
    expect(await runPython('{"a": 1}.items()')).toEqual([['a', 1]]);
    expect(await runPython('range(3)')).toEqual([0, 1, 2]);
    expect(await runPython('{3, 1}')).toEqual([3, 1]);
  });
});

describe('syntax models emit', () => {
  test('type annotations are accepted and ignored', async () => {
    expect(await runPython(`
from datetime import date
def total(rows: list[dict], *, since: date | None = None, **extra: int) -> float:
    result: float = 0.0
    for row in rows:
        result += row["amount"]
    return result
count: int
total([{"amount": 1.5}, {"amount": 2}])
`)).toBe(3.5);
  });

  test('trailing commas and multi-line calls', async () => {
    expect(await runPython(`
def f(a, b=2, *, c=3,):
    return [a, b, c]
f(
    1,
    b=5,
    c=7,
)
`)).toEqual([1, 5, 7]);
  });

  test('unsupported constructs fail with a targeted message', async () => {
    await expect(runPython('match x:\n    case 1:\n        pass')).rejects.toThrow('match statements are not supported in this sandbox');
    await expect(runPython('x = b"bytes"')).rejects.toThrow('bytes literals are not supported in this sandbox');
    expect(await runPython('match = 3\nmatch + 1')).toBe(4);
  });

  test('a statement followed by junk is a syntax error', async () => {
    await expect(runPython('x = 1 2')).rejects.toThrow('invalid syntax');
    await expect(runPython('print("a") print("b")')).rejects.toThrow('invalid syntax');
    await expect(runPython('x = 1\n    y = 2')).rejects.toThrow('unexpected indent');
  });
});
