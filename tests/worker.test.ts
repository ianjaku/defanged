/**
 * `defanged/worker`: the interpreter in a worker thread, with tools proxied
 * to the main thread and a hard kill for scripts nothing else can stop.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { createWorkerInterpreter } from '../src/worker';
import { json } from '../src/json';
import { CancelledError, MaxIterationsError, NameError, TimeoutError, ToolError, TypeError } from '../src/errors';

const prints: string[] = [];
const charts: any[] = [];
const it = createWorkerInterpreter({
  tools: {
    double: (n: number) => n * 2,
    when: () => new Date(0),
    boom: () => { throw new Error('nope'); },
    spec: { params: { x: 'int' }, handler: ({ x }: { x: number }) => x + 1 },
    slow: () => new Promise((resolve) => setTimeout(() => resolve('late'), 20)),
  },
  modules: [json, 'random'],
  onPrint: (t) => prints.push(t),
  onChart: (c) => charts.push(c),
  // Generous: a cold worker on a CI runner takes a while to start.
  timeoutMs: 1500,
  maxIterations: 1e9,
});
afterAll(async () => { await it.terminate(); });

describe('worker interpreter', () => {
  test('runs scripts, keeps globals between runs, proxies tools and print', async () => {
    expect(await it.run('x = double(21)\nprint("hi", x)\nx')).toBe(42);
    expect(await it.run('x + 1')).toBe(43);
    expect(await it.run('double(n=4)')).toBe(8);
    expect(await it.run('[v for v in [slow(), slow()]]')).toEqual(['late', 'late']);
    expect(prints).toEqual(['hi 42']);
  });

  test('optional modules by object or name, Dates from tools, chart hook', async () => {
    expect(await it.run('import json, random\nrandom.seed(1)\njson.dumps({"y": when().year, "r": random.randint(1, 100)})')).toBe('{"y": 1970, "r": 18}');
    await it.run('print_chart("bar", [{"a": 1, "b": 2}], x="a", y="b")');
    expect(charts).toEqual([{ type: 'bar', data: [{ a: 1, b: 2 }], x: 'a', y: 'b', title: undefined }]);
  });

  test('errors keep their class on both sides of the boundary', async () => {
    await expect(it.run('undefined_thing')).rejects.toBeInstanceOf(NameError);
    await expect(it.run('undefined_thing')).rejects.toThrow("Line 1, Column 1: name 'undefined_thing' is not defined");
    expect(await it.run('try:\n    spec()\nexcept TypeError as e:\n    str(e)')).toBe("spec() missing 1 required argument: 'x'");
    expect(await it.run('try:\n    boom()\nexcept ToolError as e:\n    str(e)')).toBe("Tool 'boom' failed: nope");
    await expect(it.run('boom()')).rejects.toBeInstanceOf(ToolError);
    await expect(it.run('spec()')).rejects.toBeInstanceOf(TypeError);
  });

  test('the interpreter stops a plain loop itself at timeoutMs', async () => {
    await expect(it.run('while True:\n    pass')).rejects.toBeInstanceOf(TimeoutError);
    expect(await it.run('x')).toBe(42); // the worker survived, globals intact
  });

  test('a script the interpreter cannot stop is killed from the main thread', async () => {
    const started = Date.now();
    // Each iteration is a few ms of native work, and the VM only looks at the
    // clock every 8,192 iterations, so the interpreter would run for a minute.
    await expect(it.run('s = "x" * 5_000_000\nwhile True:\n    s.count("y")')).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(6000);
    // Killed worker: a fresh one starts, without the old globals.
    await expect(it.run('x')).rejects.toBeInstanceOf(NameError);
    expect(await it.run('double(2)')).toBe(4);
  });

  test('abort kills the worker at once', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user left')), 20);
    const started = Date.now();
    await expect(it.run('while True:\n    pass', { signal: ac.signal })).rejects.toThrow('Execution was cancelled: user left');
    expect(Date.now() - started).toBeLessThan(150);
    await expect(it.run('1', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancelledError);
  });

  test('runs are serialised per worker', async () => {
    const results = await Promise.all([it.run('a = 1\na'), it.run('a += 1\na'), it.run('a += 1\na')]);
    expect(results).toEqual([1, 2, 3]);
  });

  test('maxIterations still applies inside the worker', async () => {
    const small = createWorkerInterpreter({ maxIterations: 1000 });
    await expect(small.run('while True:\n    pass')).rejects.toBeInstanceOf(MaxIterationsError);
    await small.terminate();
  });

  test('an unknown module name fails on the first run', async () => {
    const bad = createWorkerInterpreter({ modules: ['os'] });
    await expect(bad.run('1')).rejects.toThrow("Module 'os' is not available in worker mode");
    await bad.terminate();
  });
});
