# What defanged does not do

The README's "Not supported" table gives the rationale for the deliberate gaps. This file is the working list, including the gaps that are simply not built yet.

## Left out on purpose

- `class` definitions, and with them `with`, `super`, `property`, user-defined exceptions
- `match` statements
- `async` / `await` (tool calls already look synchronous)
- `exec`, `eval`, `compile`, `open`, `input`, `__import__`, `globals`, `locals`
- `bytes`, `bytearray`, `str.encode()`
- Every module except `datetime`, `math`, `statistics`, `re`

## Deliberate differences from CPython

- A list, dict or set default argument is copied on each call.
- `d.get(key, default)` returns `default` when the key holds `None`.
- `None` counts as `0` in `+`, `-` and `*` next to a number.
- Sets iterate in insertion order.
- `datetime.fromisoformat()` converts an offset into the session timezone and returns a naive datetime.

## Not built yet

- `complex` numbers. `(-8) ** 0.5` raises `ValueError` instead of returning a complex.
- `json`, `itertools`, `collections`, `functools`, `string` and `random` exist as optional modules; `FEATURES.md` lists what each leaves out.
- `gen.throw()`, `send()` through `yield from`, and running `finally` blocks of a generator that is dropped or closed half-way.
- `range()` with bounds beyond 2^53 (raises `OverflowError`).
- `\N{NAME}` string escapes (a syntax error that says to use `\uXXXX`).
- Sorting a list of mixed types raises `TypeError` as in CPython, but the message may name a different pair of types: CPython's timsort and the JS sort meet their first incomparable pair in different orders.
- `statistics.variance` and `stdev` use floating-point sums, so the last digit can differ from CPython's exact fractions. `mean` is exact.
- Error positions count lines from the first non-blank line of the source.
- Exception chaining: `raise X from Y` parses but `__cause__` is not kept.
- Tracebacks. An error carries the line and column where it was raised, not the call chain.
- `datetime.time`, aware datetimes, `astimezone()`.
- `str.title()` for titlecase digraphs such as `ǅ`.
- Slices inside a tuple index (`a[1:2, 3]`).
- `math.sqrt(-1)` says `math domain error`; CPython 3.14 says `expected a nonnegative input, got -1.0`.
- `print(..., end="")` reaches `onPrint` as a separate call with the `end` text appended, so the host cannot tell it from a full line.
