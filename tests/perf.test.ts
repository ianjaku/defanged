/**
 * Performance smoke tests.
 *
 * These catch catastrophic regressions (order-of-magnitude slowdowns),
 * not micro-optimizations. Budgets are set at ~5x the typical median
 * so they stay green across machines and CI load variation.
 *
 * For detailed numbers, run:  bun bench
 */

import { describe, test, expect } from 'bun:test';
import { runPython } from '../src';

async function timeMs(code: string): Promise<number> {
  // One warmup run
  await runPython(code);
  const start = Bun.nanoseconds();
  await runPython(code);
  return (Bun.nanoseconds() - start) / 1_000_000;
}

describe('Performance smoke tests', () => {
  test('fib(20) recursive < 3000ms', async () => {
    const ms = await timeMs(`
def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)
fib(20)
`);
    expect(ms).toBeLessThan(3000);
  });

  test('loop 10k iterations < 100ms', async () => {
    const ms = await timeMs(`
total = 0
for i in range(10000):
    total += i
total
`);
    expect(ms).toBeLessThan(100);
  });

  test('list comprehension 5000 < 50ms', async () => {
    const ms = await timeMs(`[x * 2 for x in range(5000)]`);
    expect(ms).toBeLessThan(50);
  });

  test('5000 function calls < 250ms', async () => {
    const ms = await timeMs(`
def add(a, b):
    return a + b
total = 0
for i in range(5000):
    total = add(total, i)
total
`);
    expect(ms).toBeLessThan(250);
  });

  test('generator exhaust 2000 < 60ms', async () => {
    const ms = await timeMs(`
def count(n):
    i = 0
    while i < n:
        yield i
        i += 1
list(count(2000))
`);
    expect(ms).toBeLessThan(60);
  });

  test('dict build + lookup 1000 < 50ms', async () => {
    const ms = await timeMs(`
d = {}
for i in range(1000):
    d[str(i)] = i
total = 0
for k in d:
    total += d[k]
total
`);
    expect(ms).toBeLessThan(50);
  });

  test('nested loops 100x100 < 150ms', async () => {
    const ms = await timeMs(`
total = 0
for i in range(100):
    for j in range(100):
        total += i * j
total
`);
    expect(ms).toBeLessThan(150);
  });

  test('string ops 1000 < 30ms', async () => {
    const ms = await timeMs(`
s = ""
for i in range(1000):
    s += str(i)
len(s)
`);
    expect(ms).toBeLessThan(30);
  });
});
