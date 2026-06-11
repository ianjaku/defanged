# CLAUDE.md

Guidance for AI assistants working on this repo. Keep it tight.

## What this project is

`defanged` is a **sandboxed Python interpreter written in TypeScript**. It exists so that LLMs and agents can emit Python and have it executed safely from a Node/Bun host, with no filesystem, network, or subprocess access.

The contract: **behave like CPython for the supported subset**. When behavior is ambiguous, open a real Python REPL and match what it does.

Scope is defined by exclusion lists, not just feature lists: `FEATURES.md` is the authoritative record of what works, and the README's "Not supported" table records *why* each missing feature is missing (safety vs. deliberately-not-useful, e.g. `class`, `with`, `async`). Don't implement anything in that table without revisiting its rationale. The one intentional CPython deviation — fresh mutable defaults per call — is documented there too; any other divergence is a bug.

## Pipeline

```
src/lexer.ts → src/parser.ts → src/interpreter.ts
    (tokens)      (AST)           (values)
```

Supporting files: `src/tokens.ts` (token types), `src/ast.ts` (node types), `src/values.ts` (runtime values), `src/builtins.ts` (built-in functions), `src/methods.ts` (string/list/dict/set methods), `src/datetime.ts` (the whitelisted `datetime` module), `src/errors.ts` (Python-like exceptions), `src/index.ts` (public API).

## Non-negotiable rules

1. **Never widen the safety boundary.** No `exec`, `eval`, `open`, `compile`, `__import__`, filesystem, network, or subprocess. These features don't exist and shouldn't be added. `import` resolves only against the built-in whitelist of pure-computation modules (currently `datetime`, `math`, `statistics`); never whitelist a module that performs I/O. If data needs to come in from the outside, it goes through `ToolDefinition`.
2. **Tests are the spec.** `tests/features.test.ts` documents behavioral expectations. Before changing semantics, add or update a test that pins the new behavior.
3. **Match CPython.** Don't invent Python. If unsure, verify in `python3 -c "..."`.
4. **Always use Bun** instead of npm

## Running things

```bash
bun test                        # full suite
bun test tests/features.test.ts # behavioral surface
bun run typecheck
bun bench                       # performance benchmarks (median/min/max)
bun bench --json                # machine-readable output
```

## Performance

Run `bun bench` **before and after** every feature change. Compare the output and note any significant differences (>20% regression on any benchmark) in the commit message. If a feature unavoidably regresses performance, explain the tradeoff in the commit body.

## Where feature status lives

`FEATURES.md` tracks what works and what's broken, with TypeScript analogues. **Keep it in sync** when you add or fix a feature — flip the entry from the "broken" section to "working" and update the header pass/fail count.

## Parser notes worth remembering

- `Assignment.targets: Expression[]` — supports chained assignment (`x = y = 5`). Iterate and assign the single evaluated value to each target.
- Lambdas use `expression()` for their body, which can conflict with enclosing comma contexts.

## Commit style

Short imperative subject line, blank line, then a paragraph or two explaining the _why_. Don't mention AI authorship in commit messages; the README already handles disclosure project-wide. Write commit messages that sound natural and human. No `Co-Authored-By` trailers.
