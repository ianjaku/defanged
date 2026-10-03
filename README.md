<p align="center">
  <img src="https://raw.githubusercontent.com/ianjaku/defanged/main/logo.png" alt="defanged: a small snake under a bell jar" width="600" />
</p>

# defanged

Run Python written by an LLM inside your Node or Bun app. It cannot touch your disk, your network or your process, because those parts were never built.

```typescript
import { runPython } from "defanged";

await runPython(`sum(x * x for x in range(10))`); // 285
```

The only way out of the sandbox is a function you hand in. No tool, no exit.

[![npm](https://img.shields.io/npm/v/defanged.svg)](https://www.npmjs.com/package/defanged)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![typescript](https://img.shields.io/badge/typescript-5.x-blue.svg)](https://www.typescriptlang.org/)

## What it is for

**Agents that calculate instead of guess.** Ask "what was churn last quarter" and let the model write the arithmetic. Your data goes in through a tool; the model never gets a shell.

```typescript
await runPython(
  `
customers = fetch_customers(quarter="2026-Q1")
lost = [c for c in customers if c["churned"]]
f"{len(lost) / len(customers):.1%} churn ({len(lost)} of {len(customers)})"
  `,
  [{ name: "fetch_customers", handler: ({ quarter }) => db.customers.forQuarter(quarter) }],
); // "4.2% churn (17 of 405)"
```

**Dashboards from a sentence.** The model groups, sorts and formats; you render. `print_table` and `print_chart` hand the result to your UI as plain objects.

```typescript
const interpreter = createInterpreter({
  tools: [{ name: "fetch_orders", handler: () => orders }],
  onTable: (t) => ui.renderTable(t),
  onChart: (c) => ui.renderChart(c),
});
await interpreter.run(`
by_month = {}
for o in fetch_orders():
    by_month[o["date"][:7]] = by_month.get(o["date"][:7], 0) + o["total"]
rows = [{"month": m, "revenue": round(v, 2)} for m, v in sorted(by_month.items())]
print_chart("bar", rows, x="month", y="revenue", title="Revenue by month")
`);
```

**User-defined rules in your product.** Let customers write a pricing rule or an alert condition in Python instead of inventing a formula language. Cap the damage a bad script can do with a step budget and a deadline.

```typescript
const rules = createInterpreter({
  tools: [{ name: "order", handler: () => order }],
  maxIterations: 10_000,
  timeoutMs: 50,
});
await rules.run(`
o = order()
discount = 0.15 if o["total"] > 500 and o["country"] == "NL" else 0
round(o["total"] * (1 - discount), 2)
`); // 510
```

**Cleaning up tool output.** APIs return messy JSON; the model reshapes it with the Python it already knows (`datetime`, `re`, `collections`, `statistics`) and you get a JS object back.

Runaway code hits a catchable limit, not your server: loops and calls are budgeted, strings and lists are capped, and recursion stops at 1,000 frames.

## Install

```bash
npm install defanged
# or
bun add defanged
```

## Quick start

```typescript
import { runPython } from "defanged";

const result = await runPython(`
total = sum([x * 2 for x in range(10) if x % 2 == 0])
f"Total: {total}"
`);

console.log(result); // "Total: 40"
```

### With tool injection

Tools are the only way Python code can reach data outside the interpreter:

```typescript
import { runPython } from "defanged";

const result = await runPython(
  `
transactions = fetch_transactions("2026-04")
total = sum([t['amount'] for t in transactions if t['amount'] > 0])
f"Inflow: {total}"
  `,
  [
    {
      name: "fetch_transactions",
      description: "Fetch transactions for a given month (YYYY-MM).",
      handler: async (month: string) => {
        return await db.transactions.findMany({ where: { month } });
      },
    },
  ],
);
```

Handlers can be synchronous or async. The interpreter awaits async handlers automatically.

### Reusable interpreter

```typescript
import { createInterpreter } from "defanged";

const interpreter = createInterpreter({
  tools: [...],
  onPrint: (msg) => logger.info(msg),
  maxIterations: 10_000, // lower for untrusted input
});

const a = await interpreter.run(codeOne);
const b = await interpreter.run(codeTwo);
```

---

## What's supported

A quick overview — see [`FEATURES.md`](./FEATURES.md) for the authoritative list with TypeScript analogues for every feature.

**Works:**

- Numbers the way CPython has them. `int` is exact at any size (`2 ** 100` prints all 31 digits), `float` is a separate type (`6 / 2` is `3.0`), and `bool` is an `int`.
- Strings with full escape sequences, raw strings (`r"\d+"`), f-strings (format specs such as `:,.2f` and `:.1%`, `!r`, `{x=}`, nested `{width}`), `%` formatting and `str.format`.
- Lists, tuples, dicts and sets. Dict keys and set members can be any hashable value, so `totals[(month, org)]` works. `zip`, `enumerate` and `dict.items()` yield real tuples.
- Comprehensions and generator expressions, slicing, `*` and `**` unpacking in calls and literals.
- `if`/`elif`/`else`, `for`/`while` with `else`, `break`/`continue`/`pass`, `try`/`except`/`else`/`finally`, `raise`, `assert`, `del`, the walrus `:=`, one-line bodies (`if x: return 1`).
- Functions with defaults, `*args`/`**kwargs`, keyword-only parameters, closures, `global`/`nonlocal`, lambdas, decorators. Type annotations parse and are ignored.
- Generators with `yield`, `yield from` and `send()`. `map`, `filter`, `zip` and `enumerate` are lazy.
- Exceptions are objects. `except ValueError as e` gives you `str(e)`, `e.args` and `type(e).__name__`, and the classes form CPython's hierarchy (`except LookupError` catches a `KeyError`).
- The `datetime` module (`datetime`, `date`, `timedelta`, naive, with a host-configurable clock and session timezone), `math`, `statistics`, and `re` (backed by JS `RegExp`, dialect caveats in `FEATURES.md`).
- Opt-in modules you register from the host: `json`, `itertools`, `collections` (`Counter`, `defaultdict`, `OrderedDict`, `deque`, `namedtuple`), `functools` (`reduce`, `partial`, `lru_cache`, `cmp_to_key`), `string` and `random` (CPython's Mersenne Twister, so seeded runs match). See "Optional modules" below.
- About 50 built-ins (`len`, `range`, `sum`, `sorted`, `enumerate`, `zip`, `map`, `filter`, `any`, `all`, `print`, `isinstance`, `getattr`, `format`, `round`, ...).

### Not supported

| Feature | Reason |
|---|---|
| Modules other than `datetime`, `math`, `statistics`, `re` and the registered optional ones | **Safety.** There is no real module system — imports resolve against a whitelist of pure-computation modules. Nothing importable touches the filesystem, network, or process. Everything else raises `ModuleNotFoundError`. |
| `exec` / `eval` / `compile` | **Safety.** Dynamic code execution would bypass the sandbox. |
| `open` / filesystem I/O | **Safety.** No filesystem access. Data comes in through tools. |
| `__import__` / `globals` / `locals` | **Safety.** Introspection escapes could leak or mutate interpreter state. |
| Network / subprocess | **Safety.** No `os`, `socket`, `subprocess`, `urllib`, or `requests`. |
| `class` definitions | **Not useful for agents.** AI-generated sandbox code is short and procedural — dicts, tuples, and functions cover every practical case. Classes are a code organization tool for larger programs. |
| `match` statements | **Not useful enough.** `if`/`elif` covers the cases agents write. |
| `with` statement | **Blocked by classes.** Context managers require `__enter__`/`__exit__` methods, and every real-world use case (`open()`, DB connections, locks) involves I/O that the sandbox doesn't have. |
| `async` / `await` | **Not applicable.** The sandbox has no I/O to await. Concurrency is not meaningful in a single-threaded, network-free interpreter. |
| `input()` | **Not applicable.** There is no interactive stdin. Data should be passed in via tools. |
| `str.encode()` / `bytes` type | **Not useful for agents.** Binary data handling is irrelevant in a text-processing sandbox. |

The constructs models emit anyway (`class`, `with`, `match`, `async`/`await`, `b"..."`) fail at parse time with a targeted message — e.g. `class definitions are not supported in this sandbox — use dicts and functions instead` — so an LLM's retry loop converges instead of guessing at a generic `Unexpected token`. Absent built-ins do the same at run time: calling `open()` raises `name 'open' is not defined — file access is not available in this sandbox; data comes in through tool functions`.

### Where it deliberately differs from CPython

Everything else is meant to match CPython 3.14, and `tests/conformance` checks that against a recorded CPython run.

| Behavior | Why |
|---|---|
| A list, dict or set default is copied on each call | In CPython, `def f(x=[]):` shares one list across calls, a well-known footgun. Here every call starts with a fresh copy. |
| `d.get(key, default)` returns `default` when the key holds `None` | Tool results carry JSON nulls. `row.get("amount", 0)` is meant to give a usable number. |
| `None` counts as `0` in `+`, `-` and `*` next to a number | Same reason: summing a column with null cells should not fail. |
| Sets iterate in insertion order | CPython's order depends on its hash table. Sort a set before printing it if the order matters. |
| Ints convert to JS numbers at the host boundary | Inside the sandbox ints are exact. A result beyond 2^53 reaches the host as the nearest JS number, so return `str(n)` when you need every digit. |
| `datetime.fromisoformat()` converts an offset into the session timezone | All datetimes stay naive. See `FEATURES.md`. |

---

## Safety model

`defanged` is safe by _construction_, not by _configuration_. The dangerous Python features simply do not exist in this interpreter — there is no flag to enable them and no module to import them from.

| Attack surface         | Status                                                   |
| ---------------------- | -------------------------------------------------------- |
| Filesystem access      | Absent (`open` is not defined)                           |
| Network access         | Absent (no `urllib`, `requests`, `socket`)               |
| Shell / subprocess     | Absent (no `os`, `subprocess`)                           |
| Dynamic code execution | Absent (no `exec`, `eval`, `compile`, `__import__`)      |
| Module imports         | Whitelist only (`datetime`, `math`, `statistics`, `re`), all pure computation |
| Introspection escape   | Absent (no `globals()`, `locals()`, `__dict__`)          |
| Infinite loops / DoS   | Bounded by `maxIterations` (default 5,000,000 loop iterations, and separately 5,000,000 function calls) and `timeoutMs` (wall-clock, opt-in) |
| Runaway recursion      | A catchable `RecursionError` at 1,000 nested calls, or at 500 levels when the recursion goes through a built-in callback such as a `sorted` key or an `lru_cache` wrapper. Plain Python calls do not use the JS stack |
| Host memory exhaustion | Bounded by `limits` — single-step allocations (`[0] * 10**9`, `"x" * 10**9`, `list(range(10**9))`, `join`, `ljust`/`center`/`zfill`, huge ints) fail with a Python `MemoryError` instead of OOMing the process |
| Host CPU exhaustion    | Bounded by the iteration and call budgets + optional wall-clock deadline |
| Prototype pollution    | A dict key named `__proto__` stays an ordinary own property on results and tool arguments |

Neither `MaxIterationsError` nor `TimeoutError` can be caught from Python — not even by a bare `except:` — and `finally` blocks do not run for them, so sandboxed code cannot neutralize the host's resource bounds.

### Residual risks (yours to own)

1. **Tool handlers are trust boundaries.** Whatever a tool handler does with its arguments is on you. If a tool runs SQL, parameterize it. If a tool calls out to a system, validate inputs.
2. **Memory bounding is crude, not precise accounting.** The `limits` caps guard the operations that can allocate huge results in one step. Many small allocations across millions of iterations are bounded only indirectly (by `maxIterations`); keep a process-level memory budget for hostile input.
3. **Wall-clock enforcement has gaps.** The `timeoutMs` deadline is checked between operations, and `run()` rejects when it passes while a tool call is still pending. It cannot interrupt a single synchronous operation already in flight: a catastrophically backtracking `re` pattern (on Node, `re.match(r"(a+)+$", "a" * 40 + "b")` does not return) or a tool handler that blocks the event loop. For hard real-time guarantees, run untrusted code in a worker you can kill.

---

## API

### `runPython(code, tools?, onPrintOrOptions?)`

One-shot execution. Returns the value of the last expression, or `None` if the code ends in a statement. The third argument is a print callback, or an options object with any of the `createInterpreter` options below (`timeoutMs`, `limits`, `onPrint`, ...).

### `createInterpreter(options)`

Long-lived interpreter. Options:

- `tools: ToolDefinition[]` — functions callable from Python
- `onPrint: (msg: string) => void` — called for every `print()` invocation. Without it, `print()` raises, so the model is told to use the two below instead
- `onTable: (t: { data, columns, title? }) => void` — receives `print_table(data, columns, title=)` calls: `data` is a list of dicts as plain objects, `columns` is `[{ key, label, format? }]`
- `onChart: (c: { type, data, x, y, title? }) => void` — receives `print_chart(type, data, x, y, title=)` calls; `type` is `bar`, `line`, `pie` or `area`, `y` a key or list of keys
- `maxIterations: number` — budget for loop iterations, and separately for function calls, per `run()` (default 5,000,000 each). The call budget is what stops recursion that never loops, such as `fib(60)`
- `timeoutMs: number` — wall-clock deadline per `run()`, including time spent inside awaited tool handlers (which `maxIterations` cannot bound). Raises a `TimeoutError` that Python code cannot catch. Default: no limit — set one if your host runs on an event loop it can't block indefinitely.
- `limits: { maxStringLength?, maxCollectionSize? }` — allocation caps (defaults: 10,000,000 characters / elements). Exceeding one raises a Python-catchable `MemoryError` instead of OOMing the host. Pass `Infinity` to disable.
- `now: () => number` — clock for `datetime.now()` / `date.today()`, in epoch milliseconds (default `Date.now`). A fractional value keeps its microseconds.
- `timezone: string` — IANA timezone the sandboxed code appears to run in, e.g. `'Europe/Berlin'` (default `'UTC'`). Affects `datetime.now()`, `date.today()`, and how `fromisoformat()` localizes `Z`/offset-suffixed timestamps; pass the end user's timezone so dates render in their local time. All datetimes stay naive — see `FEATURES.md` for the full model.
- `modules: PyModule[]` — optional modules to make importable; see "Optional modules" below.

### Optional modules

`json`, `itertools`, `collections`, `functools`, `string` and `random` ship with the package but stay out of the core bundle. Import the ones you want and pass them in:

```typescript
import { createInterpreter } from "defanged";
import { json } from "defanged/json";
import { collections } from "defanged/collections";
import { itertools } from "defanged/itertools";

const interpreter = createInterpreter({ modules: [json, collections, itertools] });
await interpreter.run(`
import json
from collections import Counter
json.dumps(Counter("abracadabra").most_common(2))
`); // '[["a", 5], ["b", 2]]'
```

Each one is pure computation, so the safety boundary does not move. `json` has `dumps` and `loads` (`load`/`dump` take files and do not exist). `itertools` has the lazy iterators (`chain`, `groupby`, `product`, `permutations`, `combinations`, `accumulate`, `islice`, `zip_longest`, `batched`, ...). `collections` has `Counter`, `defaultdict`, `OrderedDict`, `deque` and `namedtuple`. `functools` has `reduce`, `partial`, `lru_cache`/`cache`, `cmp_to_key` and `wraps`. `string` has the character constants and `capwords`. `FEATURES.md` lists what each supports.

`random` is a port of CPython's generator (Mersenne Twister), so `random.seed(42)` followed by `randint`, `shuffle`, `sample`, `gauss` or any other function gives the numbers CPython gives. Unseeded, each interpreter starts from OS entropy and keeps its own generator between runs, the way one Python process does. Only `int` seeds are accepted; CPython hashes `str` seeds with SHA-512, which is not ported.

A module is a `PyModule` built from the value classes the package exports. That API exists so the six above can live outside the core; it is not yet documented or stable for third-party modules.

### `ToolDefinition`

```typescript
interface ToolDefinition {
  name: string;
  description?: string;
  handler: (...args: any[]) => any | Promise<any>;
  parameters?: ToolParameter[]; // metadata for generateToolsPrompt
  group?: string;               // section heading in generateToolsPrompt
}
```

**Calling convention.** Handlers receive the script's positional arguments (marshalled to plain JS values) followed by **one trailing kwargs object**, which is always present when the call uses keyword arguments and is `{}` for zero-argument calls:

```python
f()           # handler({})
f("a")        # handler("a", {})
f("a", x=1)   # handler("a", { x: 1 })
```

Note the ambiguity: a final positional dict is indistinguishable from kwargs. Prefer keyword-only tools, or put dict parameters first. (A cleaner `(args, kwargs)` signature is planned for a later release.)

**Errors.** A JS exception thrown (or rejected) by a handler surfaces in Python as a `ToolError` — catchable with `except ToolError`, `except RuntimeError`, or `except Exception` — so scripts can implement fallbacks. The message is `Tool '<name>' failed: <error.message>`.

Return values marshal into Python values: arrays → lists, plain objects → dicts, `null`/`undefined` → `None`, and JS `Date` objects → naive `datetime` values in the session timezone (so timestamp columns from database drivers behave like `datetime.now()` output). A JS number becomes an `int` when it is a whole number in the safe-integer range and a `float` otherwise, because JS cannot tell `4` from `4.0`. An invalid `Date` raises `ValueError` in the script, and one outside the years 1 to 9999 raises `OverflowError`.

Going the other way, tuples and sets arrive as arrays, `int` and `float` as numbers, and dict keys as strings.

### Errors the host sees

Every failure is an `InterpreterError` subclass named after the Python exception (`TypeError`, `KeyError`, `ToolError`, `SyntaxError`, ...), exported from the package for `instanceof` checks. `error.message` is `Line N, Column N: <message>` with CPython's wording, `error.baseMessage` is the message alone, and `error.line` / `error.column` give the position.

### `generateToolsPrompt(tools, options?)`

Produces a system-prompt fragment describing available tools, for use with Claude / other LLMs. Tools with `parameters` metadata render Python-style signatures with per-argument docs; tools sharing a `group` render under a `##` section heading (useful past ~10 tools); `{ includeLanguageNotes: true }` appends a short description of the supported Python subset so hosts don't each hand-write it. The notes also tell the model to join two lists through a dict, because a nested-loop join over a few thousand rows runs into `maxIterations`.

```typescript
generateToolsPrompt([
  {
    name: "get_sales",
    description: "Fetch sales rows for a region.",
    handler: getSales,
    group: "Data",
    parameters: [
      { name: "region", type: "str", description: "Sales region code" },
      { name: "currency", type: "str", default: '"USD"' },
    ],
  },
], { includeLanguageNotes: true });
// ## Data
// - get_sales(region: str, currency: str = "USD") - Fetch sales rows for a region.
//     region: Sales region code
// ...
```

---

## Architecture

```
source code ──► lexer ──► parser ──► compiler ──► VM ──► value
                (tokens)   (AST)    (bytecode)     │
                                                   └─► tool handler (TS)
```

- `src/lexer.ts` — tokenizer, including INDENT/DEDENT tracking
- `src/parser.ts` — recursive-descent parser producing the AST (`src/ast.ts`)
- `src/compiler.ts` — resolves where each name lives and emits bytecode
- `src/vm.ts` — the bytecode loop: frames, calls, exceptions, generators
- `src/values.ts`, `src/numbers.ts` — runtime values and exact-int / float arithmetic
- `src/ops.ts`, `src/format.ts` — operators, and the three string-formatting styles
- `src/builtins.ts`, `src/methods.ts` — built-in functions and the methods of `str`/`list`/`dict`/`set`
- `src/datetime.ts`, `src/math.ts`, `src/statistics.ts`, `src/re.ts` — the built-in modules
- `src/json.ts`, `src/itertools.ts`, `src/collections.ts`, `src/functools.ts`, `src/string.ts`, `src/random.ts` — the optional modules, each its own entry point
- `src/errors.ts` — the exception classes
- `src/interpreter.ts` — the public `Interpreter`: options, tools, `run()`

A Python call pushes a frame on the VM's own stack instead of recursing in JS. That is what lets a tool call pause the whole script on a promise from anywhere (inside a comprehension, a generator, a `sorted` key function), and what turns runaway recursion into a `RecursionError` instead of a crashed host. The one place JS does nest is a built-in calling back into Python, and the VM caps that at 100 levels.

---

## Performance

`bun bench` runs the benchmark suite. Its `dashboard` category is the one modelled on real use: 5,000 rows from a tool with a `Date` and a float column, then filtering, group-bys, sorting, number formatting and merges. On an Apple-silicon laptop a script doing all of that takes about 13 ms under Bun and 11 ms under Node 22, of which 4 to 5 ms is converting the rows into Python values.

Three things keep that cheap, and they are worth knowing when you write tools:

- The interpreter runs in your process, so a tool call costs a function call and returned rows are converted once, not serialised.
- `Date` values need a timezone lookup only for the first rows of each calendar day, not for every row.
- A join written as a dict lookup handles 5,000 rows in a few milliseconds. The same join as a nested loop is quadratic and will hit `maxIterations` at a few thousand rows per side.

---

## Upgrading from 0.3

0.4 replaces the interpreter's runtime to match CPython much more closely. Scripts that relied on the old differences will behave differently:

- `6 / 2` is `3.0` and prints that way. Integers are exact at any size.
- `except E as e` binds an exception object. `"error: " + e` is a `TypeError`; use `str(e)` or an f-string.
- `zip`, `enumerate`, `dict.items()` and `divmod` produce tuples, and `d.keys()` is a view that cannot be indexed.
- A missing attribute raises `AttributeError` (it was `TypeError`), unpacking the wrong number of values raises `ValueError`, and messages use CPython's wording: `name 'x' is not defined`, `division by zero`.
- `maxIterations` now also caps the number of function calls, and `finally` blocks no longer run when `MaxIterationsError` or `TimeoutError` ends a script.
- `sorted(..., reverse=True)` keeps equal items in their original order, as CPython does.

For hosts: the tool calling convention, `runPython`, `createInterpreter` and the exported error classes are unchanged. Two things changed for code that reached into internals: the constructor arguments of `NameError`, `KeyError` and `ZeroDivisionError`, and the exported value types (the old tagged objects such as `PyNumber` and the `Environment` class are gone).

---

## Development

```bash
bun install             # install devDependencies
bun test                # run the full suite
bun run test:features   # run the behavioral feature suite
bun run typecheck       # tsc --noEmit
bun run build           # emit dist/
bun bench               # performance benchmarks
```

`tests/conformance/cases.ts` holds small Python programs. `bun run conformance:record` runs them in a real CPython (set `PYTHON=python3.14` to pick one) and saves what it printed, and `bun test` then checks that defanged prints the same. Add a case there whenever you find a difference.

Contributions welcome. Two rules:

1. **Never add a capability that widens the safety boundary.** No module system, no `exec`, no filesystem, no network. If you want to expose something to Python code, add it as a tool, not as a built-in.
2. **Match CPython behavior.** When in doubt, open a real Python REPL and observe. The test suite is the spec, and the conformance corpus is the part of it that CPython wrote.

---

## A note on AI-assisted authorship

A substantial portion of this codebase was written with the help of Claude. I'm flagging it up front because transparency matters and because I want to explain why I think this is a reasonable approach here — not a general endorsement, but a case for _this specific kind of project_.

**A Python interpreter is a black box with a very well-defined contract.** The contract is "behave like CPython for the supported subset." That contract is:

- **Externally specified.** Python's semantics are documented, tested, and can be verified against a reference implementation that ships with every major OS. If `defanged` says `int(-3.9) == -3`, I can check that in a real Python REPL in five seconds.
- **Mechanically testable.** Every behavioral claim is a unit test. Given input X, produce output Y. There is very little room for "it works but it's subtly wrong" in a way that tests wouldn't catch — and when there is, the right fix is to add a test, not to re-audit the code by hand. Since 0.4 part of the suite is written by CPython itself: a corpus of programs is run through the real interpreter and its recorded output is what `bun test` compares against.
- **Narrowly scoped.** The code does one thing: interpret a stream of Python tokens and produce values. It does not make network calls, write to disk, or interact with shared state. The blast radius of a bug is "the code returns the wrong answer," not "the code leaks user data."

For projects like this — interpreters, parsers, codecs, protocol implementations, math libraries, anything with a reference spec and deterministic I/O — I believe the honest engineering question is not "who typed this?" but "is the behavior correct, and can you prove it?" The test suite is the proof. If `bun test` passes and the coverage is honest, the implementation is sound whether a human, an AI, or a team of both produced it.

I would not make the same argument about a project where the spec _is_ the code itself — a novel system design, a security-critical protocol, a piece of infrastructure where the blast radius extends beyond its return value. Those warrant human review line by line. `defanged` is not that project.

If you find a case where `defanged` diverges from CPython, please [file an issue](https://github.com/ianjaku/defanged/issues) with a minimal repro. That's the contract.

---

## License

MIT © Ian Jakubek — see [LICENSE](LICENSE).
