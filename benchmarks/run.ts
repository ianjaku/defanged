/**
 * Standalone benchmark suite for the defanged interpreter.
 *
 * Usage:
 *   bun benchmarks/run.ts            # run all benchmarks
 *   bun benchmarks/run.ts --json     # machine-readable output
 *
 * Each benchmark runs its program multiple times (warmup + measured)
 * and reports median wall-clock time. Compare before/after a change
 * to catch regressions.
 */

import { runPython, type InterpreterOptions, type ToolDefinition } from '../src';

interface Benchmark {
  name: string;
  category: string;
  code: string;
  iterations: number;
  /** Tools the script can call; dashboard scripts get their rows this way. */
  tools?: ToolDefinition[];
  options?: Omit<InterpreterOptions, 'tools'>;
}

// ── Data for the dashboard benchmarks ───────────────────────────────────
// Shaped like database rows: a JS Date, a float amount, a few strings.

const ORDERS = Array.from({ length: 5000 }, (_, i) => ({
  id: i,
  customer_id: (i * 7) % 5000,
  created_at: new Date(Date.UTC(2026, i % 12, (i % 27) + 1, i % 24)),
  org: `org${i % 7}`,
  category: ['saas', 'services', 'hardware'][i % 3],
  amount: ((i * 37) % 100000) / 100 + 0.01,
  status: i % 5 === 0 ? 'open' : 'paid',
}));
const CUSTOMERS = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `customer ${i}`, region: `r${i % 5}` }));

const dataTools: ToolDefinition[] = [
  { name: 'fetch_orders', handler: async () => ORDERS },
  { name: 'fetch_customers', handler: async () => CUSTOMERS },
];
const discard = () => {};
const dashboard = { tools: dataTools, options: { onPrint: discard, onTable: discard, onChart: discard } };

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

  {
    name: 'index loop over 20000-char string',
    category: 'strings',
    iterations: 10,
    code: `
s = "ab" * 10000
i = 0
count = 0
while i < len(s):
    if s[i] == "a":
        count += 1
    i += 1
count
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

  // ── Statistics ──────────────────────────────────────────────────────
  {
    name: 'statistics over 1000 points',
    category: 'statistics',
    iterations: 20,
    code: `
import statistics
data = [(i * 37) % 1000 + (i % 7) * 0.5 for i in range(1000)]
[statistics.mean(data), statistics.stdev(data), statistics.quantiles(data, n=10)[4]]
`,
  },

  // ── Datetime ────────────────────────────────────────────────────────
  {
    name: 'date arithmetic + strftime 1000',
    category: 'datetime',
    iterations: 10,
    code: `
from datetime import date, timedelta
start = date(2026, 1, 1)
labels = []
latest = start
for i in range(1000):
    d = start + timedelta(days=i)
    if d > latest:
        latest = d
    labels.append(d.strftime('%Y-%m'))
len(labels)
`,
  },

  // ── Dashboards ──────────────────────────────────────────────────────
  {
    name: 'fetch 5000 rows with a date column',
    category: 'dashboard',
    iterations: 20,
    ...dashboard,
    code: `len(fetch_orders())`,
  },
  {
    name: 'fetch 5000 rows, Berlin timezone',
    category: 'dashboard',
    iterations: 20,
    tools: dataTools,
    options: { timezone: 'Europe/Berlin' },
    code: `len(fetch_orders())`,
  },
  {
    name: 'dashboard script over 5000 rows',
    category: 'dashboard',
    iterations: 20,
    ...dashboard,
    code: `
rows = fetch_orders()
paid = [r for r in rows if r["status"] == "paid"]
revenue = sum(r["amount"] for r in paid)
by_month = {}
for r in paid:
    key = (r["created_at"].strftime("%Y-%m"), r["category"])
    by_month[key] = by_month.get(key, 0) + r["amount"]
by_org = {}
for r in paid:
    by_org[r["org"]] = by_org.get(r["org"], 0) + r["amount"]
top = sorted(by_org.items(), key=lambda kv: kv[1], reverse=True)[:5]
chart = [{"month": m, "category": c, "revenue": round(v, 2)} for (m, c), v in sorted(by_month.items())]
print_chart(type="bar", data=chart[:200], x="month", y="revenue", title="Revenue by month")
print_table([{"org": o, "revenue": f"{v:,.2f}", "share": f"{v / revenue:.1%}"} for o, v in top])
largest = sorted(paid, key=lambda r: r["amount"], reverse=True)[:10]
print_table([{"id": r["id"], "date": r["created_at"].strftime("%d %b %Y"), "amount": f"{r['amount']:,.2f}"} for r in largest])
print(f"Revenue {revenue:,.2f} from {len(paid)} paid orders, average {revenue / len(paid):,.2f}")
`,
  },
  {
    name: 'format and round 5000 amounts',
    category: 'dashboard',
    iterations: 20,
    ...dashboard,
    code: `
rows = fetch_customers()
labels = []
for r in rows:
    amount = r["id"] * 1.37
    labels.append(f"{amount:,.2f} ({round(amount / 6850, 3):.1%})")
len(labels)
`,
  },
  {
    name: 'group 5000 rows by a tuple key',
    category: 'dashboard',
    iterations: 20,
    ...dashboard,
    code: `
rows = fetch_customers()
totals = {}
for r in rows:
    key = (r["region"], r["id"] % 12)
    totals[key] = totals.get(key, 0) + r["id"] * 0.5
len(totals)
`,
  },
  {
    name: 'merge two 5000-row lists via a dict',
    category: 'dashboard',
    iterations: 20,
    ...dashboard,
    code: `
customers = fetch_customers()
by_id = {c["id"]: c for c in customers}
merged = []
for r in customers:
    c = by_id.get((r["id"] * 7) % 5000)
    if c:
        merged.append({**r, "partner": c["name"], "partner_region": c["region"]})
len(merged)
`,
  },
  {
    name: 'nested-loop merge 500 x 500 with a helper',
    category: 'dashboard',
    iterations: 10,
    ...dashboard,
    code: `
customers = fetch_customers()[:500]
def same(a, b):
    return a["id"] == (b["id"] * 7) % 500
merged = []
for a in customers:
    for b in customers:
        if same(a, b):
            merged.append({**a, "partner": b["name"]})
            break
len(merged)
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
    await runPython(bench.code, bench.tools, bench.options);
  }

  // Measured runs
  for (let i = 0; i < bench.iterations; i++) {
    const start = Bun.nanoseconds();
    await runPython(bench.code, bench.tools, bench.options);
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
  console.log('  defanged interpreter benchmarks');
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
