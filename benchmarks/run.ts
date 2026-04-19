/**
 * Standalone benchmark suite for the defang interpreter.
 *
 * Usage:
 *   bun benchmarks/run.ts            # run all benchmarks
 *   bun benchmarks/run.ts --json     # machine-readable output
 *
 * Each benchmark runs its program multiple times (warmup + measured)
 * and reports median wall-clock time. Compare before/after a change
 * to catch regressions.
 */

import { runPython } from '../src';

interface Benchmark {
  name: string;
  category: string;
  code: string;
  iterations: number;
}

const benchmarks: Benchmark[] = [
  // ── Arithmetic / loops ──────────────────────────────────────────────
  {
    name: 'fib(20) recursive',
    category: 'compute',
    iterations: 5,
    code: `
def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)
fib(20)
`,
  },
  {
    name: 'fib(1000) iterative',
    category: 'compute',
    iterations: 20,
    code: `
a, b = 0, 1
for _ in range(1000):
    a, b = b, a + b
a
`,
  },
  {
    name: 'sum range(10000)',
    category: 'compute',
    iterations: 20,
    code: `
total = 0
for i in range(10000):
    total += i
total
`,
  },

  // ── Data structures ─────────────────────────────────────────────────
  {
    name: 'list comprehension 5000',
    category: 'data',
    iterations: 20,
    code: `[x * 2 for x in range(5000)]`,
  },
  {
    name: 'dict build + lookup 1000',
    category: 'data',
    iterations: 20,
    code: `
d = {}
for i in range(1000):
    d[str(i)] = i
total = 0
for k in d:
    total += d[k]
total
`,
  },
  {
    name: 'list sort 2000',
    category: 'data',
    iterations: 20,
    code: `
import_free = [i % 37 for i in range(2000)]
sorted(import_free)
`,
  },
  {
    name: 'nested list comp 50x50',
    category: 'data',
    iterations: 20,
    code: `[[i + j for j in range(50)] for i in range(50)]`,
  },

  // ── String operations ───────────────────────────────────────────────
  {
    name: 'string concat 1000',
    category: 'strings',
    iterations: 20,
    code: `
s = ""
for i in range(1000):
    s += str(i)
len(s)
`,
  },
  {
    name: 'f-string formatting 1000',
    category: 'strings',
    iterations: 20,
    code: `
result = []
for i in range(1000):
    result.append(f"item_{i}: {i * 2}")
len(result)
`,
  },
  {
    name: 'string methods chain',
    category: 'strings',
    iterations: 20,
    code: `
s = "  Hello, World!  " * 100
s.strip().lower().replace("hello", "hi").split(",")
`,
  },

  // ── Functions ───────────────────────────────────────────────────────
  {
    name: 'function calls 5000',
    category: 'functions',
    iterations: 10,
    code: `
def add(a, b):
    return a + b
total = 0
for i in range(5000):
    total = add(total, i)
total
`,
  },
  {
    name: 'closure counter 2000',
    category: 'functions',
    iterations: 20,
    code: `
def make_counter():
    count = 0
    def inc():
        nonlocal count
        count += 1
        return count
    return inc

c = make_counter()
for _ in range(2000):
    c()
c()
`,
  },
  {
    name: 'lambda map+filter 2000',
    category: 'functions',
    iterations: 20,
    code: `
nums = list(range(2000))
evens = list(filter(lambda x: x % 2 == 0, nums))
doubled = list(map(lambda x: x * 2, evens))
len(doubled)
`,
  },

  // ── Generators ──────────────────────────────────────────────────────
  {
    name: 'generator exhaust 2000',
    category: 'generators',
    iterations: 10,
    code: `
def count(n):
    i = 0
    while i < n:
        yield i
        i += 1
list(count(2000))
`,
  },
  {
    name: 'generator for-loop 2000',
    category: 'generators',
    iterations: 10,
    code: `
def gen(n):
    for i in range(n):
        yield i * i
total = 0
for x in gen(2000):
    total += x
total
`,
  },
  {
    name: 'yield from chain 3x500',
    category: 'generators',
    iterations: 10,
    code: `
def chunk(start, end):
    for i in range(start, end):
        yield i

def combined():
    yield from chunk(0, 500)
    yield from chunk(500, 1000)
    yield from chunk(1000, 1500)

list(combined())
`,
  },

  // ── Control flow ────────────────────────────────────────────────────
  {
    name: 'try/except 1000',
    category: 'control',
    iterations: 20,
    code: `
count = 0
for i in range(1000):
    try:
        if i % 3 == 0:
            raise ValueError("skip")
        count += 1
    except ValueError:
        pass
count
`,
  },
  {
    name: 'nested loops 100x100',
    category: 'control',
    iterations: 10,
    code: `
total = 0
for i in range(100):
    for j in range(100):
        total += i * j
total
`,
  },

  // ── Builtins ────────────────────────────────────────────────────────
  {
    name: 'sorted with key 1000',
    category: 'builtins',
    iterations: 10,
    code: `
data = [(i % 37, str(i)) for i in range(1000)]
sorted(data, key=lambda x: x[0])
`,
  },
  {
    name: 'enumerate + zip 1000',
    category: 'builtins',
    iterations: 20,
    code: `
a = list(range(1000))
b = list(range(1000, 2000))
result = [(i, x, y) for i, (x, y) in enumerate(zip(a, b))]
len(result)
`,
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Result {
  name: string;
  category: string;
  medianMs: number;
  minMs: number;
  maxMs: number;
  iterations: number;
}

async function runBenchmark(bench: Benchmark): Promise<Result> {
  const warmup = Math.max(1, Math.floor(bench.iterations / 4));
  const times: number[] = [];

  // Warmup
  for (let i = 0; i < warmup; i++) {
    await runPython(bench.code);
  }

  // Measured runs
  for (let i = 0; i < bench.iterations; i++) {
    const start = Bun.nanoseconds();
    await runPython(bench.code);
    const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
    times.push(elapsed);
  }

  return {
    name: bench.name,
    category: bench.category,
    medianMs: median(times),
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    iterations: bench.iterations,
  };
}

// ── Output ──────────────────────────────────────────────────────────────

function formatTable(results: Result[]): void {
  const nameWidth = Math.max(28, ...results.map(r => r.name.length + 2));
  const catWidth = 12;

  const header = [
    'Benchmark'.padEnd(nameWidth),
    'Category'.padEnd(catWidth),
    'Median'.padStart(10),
    'Min'.padStart(10),
    'Max'.padStart(10),
    'Runs'.padStart(6),
  ].join('  ');

  const sep = '─'.repeat(header.length);

  console.log();
  console.log('  defang interpreter benchmarks');
  console.log(`  ${sep}`);
  console.log(`  ${header}`);
  console.log(`  ${sep}`);

  let currentCategory = '';
  for (const r of results) {
    if (r.category !== currentCategory) {
      if (currentCategory !== '') console.log();
      currentCategory = r.category;
    }
    const line = [
      r.name.padEnd(nameWidth),
      r.category.padEnd(catWidth),
      `${r.medianMs.toFixed(2)}ms`.padStart(10),
      `${r.minMs.toFixed(2)}ms`.padStart(10),
      `${r.maxMs.toFixed(2)}ms`.padStart(10),
      String(r.iterations).padStart(6),
    ].join('  ');
    console.log(`  ${line}`);
  }

  console.log(`  ${sep}`);

  const totalMedian = results.reduce((s, r) => s + r.medianMs, 0);
  console.log(`  Total median: ${totalMedian.toFixed(2)}ms`);
  console.log();
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const jsonMode = process.argv.includes('--json');

  if (!jsonMode) {
    console.log('\nRunning benchmarks...\n');
  }

  const results: Result[] = [];
  for (const bench of benchmarks) {
    if (!jsonMode) {
      process.stdout.write(`  ${bench.name}...`);
    }
    const result = await runBenchmark(bench);
    results.push(result);
    if (!jsonMode) {
      process.stdout.write(` ${result.medianMs.toFixed(2)}ms\n`);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    formatTable(results);
  }
}

main().catch(console.error);
