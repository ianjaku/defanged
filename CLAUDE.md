# CLAUDE.md

Guidance for AI assistants working on this repo. Keep it tight.

## What this project is

`defang` is a **sandboxed Python interpreter written in TypeScript**. It exists so that LLMs and agents can emit Python and have it executed safely from a Node/Bun host, with no filesystem, network, or subprocess access.

The contract: **behave like CPython for the supported subset**. When behavior is ambiguous, open a real Python REPL and match what it does.

## Pipeline

```
src/lexer.ts → src/parser.ts → src/interpreter.ts
    (tokens)      (AST)           (values)
```

Supporting files: `src/ast.ts` (node types), `src/values.ts` (runtime values), `src/builtins.ts` (built-ins + string/list/dict methods), `src/errors.ts` (Python-like exceptions), `src/index.ts` (public API).

## Non-negotiable rules

1. **Never widen the safety boundary.** No `import`, `exec`, `eval`, `open`, `compile`, `__import__`, filesystem, network, or subprocess. These features don't exist and shouldn't be added. If data needs to come in from the outside, it goes through `ToolDefinition`.
2. **Tests are the spec.** `tests/features.test.ts` documents behavioral expectations. Before changing semantics, add or update a test that pins the new behavior.
3. **Match CPython.** Don't invent Python. If unsure, verify in `python3 -c "..."`.

## Running things

```bash
bun test                        # full suite
bun test tests/features.test.ts # behavioral surface
bun run typecheck
```

## Where feature status lives

`FEATURES.md` tracks what works and what's broken, with TypeScript analogues. **Keep it in sync** when you add or fix a feature — flip the entry from the "broken" section to "working" and update the header pass/fail count.

## Parser notes worth remembering

- `Assignment.targets: Expression[]` — supports chained assignment (`x = y = 5`). Iterate and assign the single evaluated value to each target.
- Lambdas use `expression()` for their body, which can conflict with enclosing comma contexts.
- `int()` uses `Math.floor`, which is wrong for negatives. CPython's `int()` truncates toward zero — use `Math.trunc`.

## Commit style

Short imperative subject line, blank line, then a paragraph or two explaining the *why*. Don't mention AI authorship in commit messages; the README already handles disclosure project-wide. Write commit messages that sound natural and human. No `Co-Authored-By` trailers.
