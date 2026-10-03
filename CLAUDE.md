# CLAUDE.md

Guidance for AI assistants working on this repo. Keep it tight.

## What this project is

`defanged` is a **sandboxed Python interpreter written in TypeScript**. It exists so that LLMs and agents can emit Python and have it executed safely from a Node/Bun host, with no filesystem, network, or subprocess access.

The contract: **behave like CPython for the supported subset**. When behavior is ambiguous, open a real Python REPL and match what it does.

Scope is defined by exclusion lists, not just feature lists: `FEATURES.md` is the authoritative record of what works, and the README's "Not supported" table records *why* each missing feature is missing (safety vs. deliberately-not-useful, e.g. `class`, `with`, `async`). Don't implement anything in that table without revisiting its rationale. The intentional CPython deviations are listed in the README under "Where it deliberately differs from CPython" (fresh mutable defaults per call, `dict.get` treating `None` as missing, `None` as `0` in arithmetic, insertion-ordered sets); any other divergence is a bug.

## Pipeline

```
src/lexer.ts → src/parser.ts → src/compiler.ts → src/vm.ts
    (tokens)      (AST)          (bytecode)      (values)
```

Supporting files: `src/tokens.ts` (token types), `src/ast.ts` (node types), `src/values.ts` (runtime values, equality, hashing, repr), `src/numbers.ts` (exact ints and floats), `src/ops.ts` (operators and subscripting), `src/format.ts` (format specs, `%`, `str.format`), `src/builtins.ts` (built-in functions and types), `src/methods.ts` (string/list/dict/set methods), `src/datetime.ts`, `src/math.ts`, `src/statistics.ts`, `src/re.ts` (the whitelisted modules), `src/errors.ts` (the exception classes, which are also what the host catches), `src/interpreter.ts` (options, tools, `run()`), `src/index.ts` (public API).

How values look in TypeScript: `str`/`bool`/`None` are JS `string`/`boolean`/`null`, an `int` is a `number` (a `bigint` past 2^53), a `float` is a `PyFloat`, and containers are `PyList`/`PyTuple`/`PyDict`/`PySet`. A built-in is `(rt, args, kwargs) => value`; it returns a promise only if it had to wait (a tool call, or a callback that made one), and the VM pauses the script on it. Use `andThen()` from `values.ts` to chain on such a result without forcing the synchronous case through a promise.

A built-in that calls back into Python (`rt.call`, `rt.next`, `rt.collect`) must return or chain on the result it gets, never drop it: a promise from `rt.call` means the VM is paused inside that call, and abandoning it leaves frames behind that resume into nothing.

Top-level variables live in a `Globals` table owned by the interpreter: the compiler gives each name a fixed slot and the VM reads it by index. An empty slot means the script has not defined the name, so the lookup falls back to built-ins and tools. Compiled code is therefore only valid for the interpreter it was compiled for.

## Non-negotiable rules

1. **Never widen the safety boundary.** No `exec`, `eval`, `open`, `compile`, `__import__`, filesystem, network, or subprocess. These features don't exist and shouldn't be added. `import` resolves only against the built-in whitelist of pure-computation modules (`datetime`, `math`, `statistics`, `re`) plus the optional ones a host registers (`json`, `itertools`, `collections`, `functools`, `string`, `random`, each its own entry point under `src/`); never add a module that performs I/O. If data needs to come in from the outside, it goes through the `tools` option (`src/tools.ts`).
2. **Tests are the spec.** `tests/features.test.ts` documents behavioral expectations. Before changing semantics, add or update a test that pins the new behavior.
3. **Match CPython.** Don't invent Python. If unsure, verify in `python3.14 -c "..."`. Better: add a program to `tests/conformance/cases.ts` and run `PYTHON=python3.14 bun run conformance:record`, which saves CPython's output for `bun test` to compare against. A new feature or bug fix should come with a conformance case.
4. **Always use Bun** instead of npm

## Running things

```bash
bun test                        # full suite
bun test tests/features.test.ts # behavioral surface
bun run conformance:record      # re-record CPython's output for tests/conformance
bun run typecheck
bun bench                       # performance benchmarks (median/min/max)
bun bench --json                # machine-readable output
```

## Performance

Run `bun bench` **before and after** every feature change. The `dashboard` category is the one that reflects real use: tool rows with dates and floats, group-bys, formatting, merges. A benchmark under 1 ms measures JIT warm-up as much as the interpreter, so confirm a surprising number there by running the script a few hundred times before acting on it. Compare the output and note any significant differences (>20% regression on any benchmark) in the commit message. If a feature unavoidably regresses performance, explain the tradeoff in the commit body.

## Where feature status lives

`FEATURES.md` tracks what works, with TypeScript analogues, and `missing.md` lists what doesn't. **Keep both in sync** when you add or fix a feature.

## Parser notes worth remembering

- `Assignment.targets: Expression[]` — supports chained assignment (`x = y = 5`). Iterate and assign the single evaluated value to each target.
- Lambdas use `expression()` for their body, which can conflict with enclosing comma contexts.
- Every simple statement ends through `endStatement()`, which rejects trailing tokens (`x = 1 2` is a syntax error).
- Never index a plain object with a name from the script (`KEYWORDS[name]`): `constructor` and `__proto__` would hit `Object.prototype`. Use `Object.hasOwn`, a `Map`, or a null-prototype table.

## Commit style

Short imperative subject line, blank line, then a paragraph or two explaining the _why_. Don't mention AI authorship in commit messages; the README already handles disclosure project-wide. Write commit messages that sound natural and human. No `Co-Authored-By` trailers.
