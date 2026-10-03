/** Scripts the playground offers, in the order they appear. */
export const EXAMPLES: { title: string; code: string }[] = [
  {
    title: 'Revenue by month (chart + table)',
    code: `# fetch_orders() is a tool: a function the host registered.
# Here it returns sample rows; in your app it would hit your database.
orders = fetch_orders()

by_month = {}
for o in orders:
    if o["status"] != "paid":
        continue
    key = o["date"].strftime("%Y-%m")
    by_month[key] = by_month.get(key, 0) + o["total"]

rows = [{"month": m, "revenue": round(v, 2)} for m, v in sorted(by_month.items())]
print_chart("bar", rows, x="month", y="revenue", title="Paid revenue by month")
print_table(rows, [{"key": "month", "label": "Month"}, {"key": "revenue", "label": "Revenue", "format": "currency"}], title="The same, as a table")

total = sum(r["revenue"] for r in rows)
f"{len(orders)} orders, {total:,.2f} paid revenue, best month {max(rows, key=lambda r: r['revenue'])['month']}"
`,
  },
  {
    title: 'Group by region and product',
    code: `from collections import Counter, defaultdict

orders = fetch_orders()
count = Counter(o["region"] for o in orders)
revenue = defaultdict(float)
for o in orders:
    revenue[(o["region"], o["product"])] += o["total"]

print("Orders per region:", dict(count))
top = sorted(revenue.items(), key=lambda kv: kv[1], reverse=True)[:5]
for (region, product), amount in top:
    print(f"{region:<5} {product:<12} {amount:>10,.2f}")

print_chart("pie", [{"region": r, "orders": n} for r, n in count.items()], x="region", y="orders", title="Orders by region")
`,
  },
  {
    title: 'Keyword and positional tool calls',
    code: `# A tool takes positional or keyword arguments; both reach the handler.
eu = fetch_orders(region="EU")
us = fetch_orders("US")
rate = exchange_rate("USD", to_currency="EUR")

print(f"EU: {len(eu)} orders, US: {len(us)} orders, 1 USD = {rate} EUR")

# A wrong call is a Python error the model can read and fix:
try:
    exchange_rate("USD")
except TypeError as e:
    print("TypeError:", e)

# A failing tool is a ToolError, so scripts can fall back:
try:
    exchange_rate("USD", "XYZ")
except ToolError as e:
    print("Fell back after:", e)

round(sum(o["total"] for o in us) * rate, 2)
`,
  },
  {
    title: 'Dates and time',
    code: `from datetime import datetime, timedelta, date

orders = fetch_orders()
# Dates from tools arrive as datetime objects in the playground's timezone.
first = min(o["date"] for o in orders)
last = max(o["date"] for o in orders)
print("Span:", first.date(), "to", last.date(), "=", (last - first).days, "days")

recent = [o for o in orders if o["date"] > last - timedelta(days=30)]
print(f"{len(recent)} orders in the last 30 days of data")

by_weekday = {}
for o in orders:
    by_weekday[o["date"].strftime("%a")] = by_weekday.get(o["date"].strftime("%a"), 0) + 1
print_chart("bar", [{"day": d, "orders": n} for d, n in by_weekday.items()], x="day", y="orders", title="Orders by weekday")

datetime.now().isoformat(timespec="seconds")
`,
  },
  {
    title: 'The sandbox says no',
    code: `# None of this exists in the interpreter: not blocked, never built.
try:
    import os
except ModuleNotFoundError as e:
    print("import os          ->", e)

try:
    open("/etc/passwd")
except NameError as e:
    print("open(...)          ->", e)

try:
    eval("1 + 1")
except NameError as e:
    print("eval(...)          ->", e)

try:
    __import__("subprocess")
except NameError as e:
    print("__import__(...)    ->", e)

try:
    import requests
except ModuleNotFoundError as e:
    print("import requests    ->", e)

# What does exist: four built-in modules and whatever the host registered.
import math, statistics, re
print(math.sqrt(2), statistics.median([3, 1, 2]), re.findall(r"\\d+", "a1b22c333"))
`,
  },
  {
    title: 'Limits: a runaway loop',
    code: `# The host set maxIterations=2,000,000 and timeoutMs=3000 for this page.
# Neither can be caught from inside the script.
n = 0
while True:
    n += 1
`,
  },
  {
    title: 'Async tools pause the script',
    code: `# slow_lookup() takes 300 ms on the host. The script just waits.
results = [slow_lookup(q) for q in ["alpha", "beta", "gamma"]]
print(results)

# Inside any expression, even a generator consumed by sum():
total = sum(len(slow_lookup(q)) for q in ["one", "three"])
total
`,
  },
  {
    title: 'Modules: json, itertools, functools, random',
    code: `import json, random
from itertools import groupby, islice, count
from functools import reduce, lru_cache

orders = sorted(fetch_orders(), key=lambda o: o["product"])
sizes = {k: len(list(g)) for k, g in groupby(orders, key=lambda o: o["product"])}
print(json.dumps(sizes, indent=2))

@lru_cache
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
print("fib(80) =", fib(80), fib.cache_info())

random.seed(42)   # the same numbers CPython gives for this seed
print([random.randint(1, 100) for _ in range(5)], random.choice(["a", "b", "c"]))

reduce(lambda a, b: a + b, islice(count(1), 100))
`,
  },
];
