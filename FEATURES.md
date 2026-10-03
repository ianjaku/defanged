# defanged: feature support matrix

A Python interpreter implemented in TypeScript. This document describes which Python features are supported and which are not. Three test files back it:

- `tests/features.test.ts` pins each feature below.
- `tests/conformance.test.ts` runs the programs in `tests/conformance/cases.ts` and compares what they print with a recorded CPython 3.14 run.
- `tests/vm.test.ts` covers what CPython cannot check: tool calls, resource limits, and the boundary with the host.

Explanations are written for TypeScript developers who may not know Python.

---

## Table of Contents

- [✅ Working Features](#-working-features)
- [❌ Broken or Missing Features](#-broken-or-missing-features)
- [TypeScript ↔ Python cheat sheet](#typescript--python-cheat-sheet)

---

## ✅ Working Features

### Numbers
```python
2 ** 100          # 1267650600228229401496703205376, ints are exact at any size
10 ** 18 + 1      # 1000000000000000001
6 / 2             # 3.0, `/` always gives a float
7 // 2            # 3, floor division of ints gives an int
7 // 2.0          # 3.0
type(6 / 2)       # <class 'float'>
1 == 1.0          # True, but they print differently: 1 and 1.0
round(2.5)        # 2, ties round to even
sum([0.1] * 10)   # 1.0, float sums are compensated like CPython 3.12+
```
`int` and `float` are distinct types, unlike TS's single `number`. An int is stored as a JS number while it fits in the safe-integer range and as a `BigInt` beyond it, so arithmetic never silently rounds. Floats print with CPython's rules (`1e+16`, `1e-05`, `-0.0`, `inf`, `nan`).

Two bounds keep huge ints from hanging the host. An int may have at most 1,000,000 bits (`2 ** 10**9` raises `MemoryError`). Converting an int with more than 4,300 digits to or from a string raises `ValueError`, the same limit CPython applies.

When an int beyond 2^53 is returned to the host it becomes the nearest JS number. Return `str(n)` to keep every digit.

### Augmented assignment
```python
x += 1    # works  (like TS: x += 1)
x -= 1    # works
x *= 2    # works
x /= 2    # works
x //= 3   # floor-divide and assign
x %= 3    # modulo and assign
x **= 2   # power and assign
```
Python's `+=`, `-=`, `*=`, `/=`, `//=`, `%=`, `**=` behave like the TypeScript equivalents (with `//` being floor division, which has no TS operator). The bitwise forms `&=`, `|=`, `^=`, `<<=`, `>>=` work too. On a list, `+=` extends the list in place, so every other name bound to it sees the change.

### Chained assignment
```python
x = y = 5       # both x and y become 5
a = b = c = []  # all three names bound to the SAME list (shared reference)
```
Python evaluates the right-hand side **once**, then assigns that single value to each target left-to-right. Equivalent to this in TypeScript:
```ts
const __tmp = 5;
let x = __tmp, y = __tmp;
```
Note the shared-reference caveat with mutable values: `a = b = []` means `a` and `b` point to the same list, so `a.append(1)` changes `b` too.

### String methods

| Method | Does | TS analogue |
|---|---|---|
| `s.upper()` / `s.lower()` | Uppercase / lowercase | `s.toUpperCase()` / `s.toLowerCase()` |
| `s.strip()` / `s.lstrip()` / `s.rstrip()` | Trim whitespace (both/left/right) | `s.trim()` / `s.trimStart()` / `s.trimEnd()` |
| `s.strip(chars)` / `s.lstrip(chars)` / `s.rstrip(chars)` | Trim specific chars | no direct equivalent |
| `s.replace(old, new)` | Replace all occurrences | `s.replaceAll(old, new)` |
| `s.replace(old, new, count)` | Replace first `count` occurrences | no direct equivalent |
| `s.split(sep)` | Split into list | `s.split(sep)` |
| `s.split(sep, maxsplit)` | Split with limit (remainder kept) | no direct equivalent (TS `limit` truncates) |
| `s.startswith(x)` / `s.endswith(x)` | Prefix / suffix check | `s.startsWith(x)` / `s.endsWith(x)` |
| `s.find(x)` | Index of substring, `-1` if missing | `s.indexOf(x)` |
| `s.rfind(x)` | Last index of substring, `-1` if missing | `s.lastIndexOf(x)` |
| `s.index(x)` | Like `find()`, but throws `ValueError` if missing | `s.indexOf(x)` + manual throw |
| `s.count(x)` | Count non-overlapping occurrences | no direct equivalent |
| `s.join(list)` | Join list with `s` as separator | `list.join(s)` (note: args reversed) |
| `s.isdigit()` / `s.isalpha()` / `s.isalnum()` | Character-class predicates | regex equivalent |
| `s.isspace()` | True if non-empty and all whitespace | `/^\s+$/.test(s)` |
| `s.title()` / `s.capitalize()` / `s.swapcase()` | Case transforms | no direct equivalent |
| `s.zfill(n)` | Pad left with zeros | `s.padStart(n, '0')` |
| `s.ljust(n)` / `s.rjust(n)` / `s.center(n)` | Pad right / left / both sides | `s.padEnd(n)` / `s.padStart(n)` / — |
| `s.format(...)` | Named/positional placeholder substitution | template literals |
| `s.isupper()` / `s.islower()` | Case check predicates | no direct equivalent |
| `s.istitle()` | True if titlecased | no direct equivalent |
| `s.isnumeric()` | True if all numeric (incl. Unicode) | no direct equivalent |
| `s.isdecimal()` | True if all decimal digits | no direct equivalent |
| `s.isidentifier()` | True if valid Python identifier | no direct equivalent |
| `s.isprintable()` | True if all printable (empty is True) | no direct equivalent |
| `str.maketrans(x, y, z)` | Build translation table | no direct equivalent |
| `s.translate(table)` | Apply translation table | no direct equivalent |
| `s.partition(sep)` / `s.rpartition(sep)` | Split into 3-tuple at first/last sep | no direct equivalent |
| `s.splitlines()` | Split on line boundaries | `s.split(/\r\n\|\r\|\n/)` |
| `s.expandtabs(n)` | Replace tabs with spaces | no direct equivalent |
| `s.removeprefix(p)` / `s.removesuffix(s)` | Strip prefix/suffix (3.9+) | no direct equivalent |
| `s * n` | Repeat string `n` times | `s.repeat(n)` |

### `str()`, `float()`, and `int()` conversions
- `str(123)` → `"123"` — like `String(123)` in TS
- `str(True)` → `"True"` (note: Python capitalizes booleans)
- `str([1, 2])` → `"[1, 2]"` (prints list representation)
- `float("3.14")` → `3.14`, `float(5)` → `5.0`, `float("inf")` → `inf`
- `int("42")` → `42`, `int(True)` → `1`, `int("ff", 16)` → `255`
- `int(-3.9)` → `-3` (truncates toward zero, like CPython)
- `int("3.14")` → raises `ValueError` (only whole-integer strings accepted)
- `repr("it's")` → `"it's"`, `repr("a\nb")` → `'a\\nb'` (quotes and escapes chosen like CPython)

Strings are sequences of code points, as in Python: `len("😀")` is `1` (JS's `.length` says `2`), and indexing or slicing never splits a character.

### Tuples
```python
t = (1, 2, 3)       # immutable list — like `readonly [1, 2, 3]` in TS
t[0]                # 1
len(t)              # 3
1 in t              # True
a, b, c = t         # destructuring — works everywhere (statements, for loops, function bodies)
a, b = 1, 2         # implicit tuple unpacking
a, b = b, a         # swap values
a, b, c = [10, 20, 30]  # destructure from list
(1, 2) + (3, 4)     # tuple concatenation → (1, 2, 3, 4)
(1, 2) < (1, 3)     # lexicographic comparison → True (lists compare the same way)
(1,) < (1, 2)       # a strict prefix is smaller → True
```
Comparing a tuple to a list, or elements of incomparable types, raises `TypeError` like CPython (`'<' not supported between instances of 'str' and 'int'`).

`zip()`, `enumerate()`, `dict.items()` and `divmod()` produce tuples, so `sorted(d.items())` prints `[('a', 1), ('b', 2)]`. A tuple returned to the host becomes a JS array.
A tuple is conceptually a fixed-size, immutable array. Python uses them for multi-return values:
```python
def divmod(a, b):
    return a // b, a % b   # returns a tuple (implicit return tuple works)
```

### Lists and list methods
All of these work:
```python
lst = [1, 2, 3]
lst.append(4)          # like lst.push(4)
lst.pop()              # like lst.pop()
lst.pop(0)             # pop from index — no direct TS equivalent
lst.insert(0, "x")     # like lst.splice(0, 0, "x")
lst.remove(2)          # remove first matching value
lst.extend([4, 5])     # like lst.push(...[4, 5])
lst.index(2)           # like lst.indexOf(2) but throws if not found
lst.count(2)           # count occurrences
lst.reverse()          # in-place
lst.sort()             # in-place; key= and reverse= work, and the sort is stable
lst.clear()            # empty the list
lst.copy()             # shallow copy
```
Also supported: slicing (`lst[1:3]`, `lst[::-1]`), negative indices, `in` membership, list comprehensions (`[x*2 for x in lst if x > 0]`), spreading (`[*a, *b]`), and slice assignment and deletion including a step (`lst[::2] = ...`, `del lst[1:3]`).

### Dicts (Python's plain object / Map)
```python
d = {"a": 1, "b": 2}
d["a"]                 # 1
d.get("c", 0)          # default if missing — no TS equivalent for plain objects
d.keys()               # Object.keys(d), as a live view: dict_keys(['a', 'b'])
d.values()             # Object.values(d), as a live view
d.items()              # Object.entries(d), as a live view of (key, value) tuples
d.update({"c": 3})     # Object.assign(d, {c: 3})
d.pop("a")             # remove and return
d.setdefault("x", 0)   # get, or set-and-return default
dict.fromkeys(["a","b"], 0) # {"a": 0, "b": 0} — static constructor
"a" in d               # d.hasOwnProperty("a")
```
Dict comprehensions (`{k: v for k, v in items}`) also work, as do merging with `{**a, **b}` and `a | b`, and `dict(zip(keys, values))`.

`d.keys()`, `d.values()` and `d.items()` return views, as in CPython. You can loop over them, take `len()`, test membership and pass them to `list()` or `sorted()`, but not index them (`d.keys()[0]` is a `TypeError`). Adding or removing a key while looping over a dict raises `RuntimeError`.

One deliberate deviation: `d.get(key, default)` also returns `default` when the key is present with the value `None`. Tool results carry JSON nulls, and `row.get("amount", 0)` is meant to give a usable number.

Keys can be any hashable value — strings, numbers, booleans, `None`, dates, and tuples of hashables (the multi-dimension group-by idiom):
```python
totals = {}
for r in rows:
    key = (r["month"], r["org"])      # tuple key
    totals[key] = totals.get(key, 0) + r["amount"]
```
Like CPython, `True`/`1`/`1.0` are the same key, and unhashable keys (lists, dicts, sets) raise `TypeError: unhashable type`. In TS terms a tuple key is a composite `Map` key, which plain objects/Maps can't do by value.

### Functions
- Definitions: `def f(a, b): ...`
- Default arguments: `def f(a, b=10)`
- Keyword arguments: `f(a=1, b=2)`
- `*args` (rest parameter): `def f(*args): return len(args)` — like `function f(...args)` in TS
- `**kwargs` (keyword rest): `def f(**kwargs): return kwargs["key"]` — collects keyword args into a dict
- `*list` / `**dict` unpacking in calls: `f(*args, **kwargs)` — spreads iterables/dicts into arguments
- Keyword-only parameters: `def f(a, *, b=1)`; the positional-only marker `/` is accepted
- Type annotations parse and are ignored: `def f(a: int, b: str = "x") -> str:` and `total: float = 0.0`
- Wrong calls raise CPython's `TypeError` messages (`f() missing 1 required positional argument: 'b'`)
- `@decorator` syntax — decorators wrap functions, applied bottom-up
- Recursion, nested functions, closures
- Lambdas: `lambda x: x * 2` — like `(x) => x * 2`; defaults, `*args` and `**kwargs` work
- Early return with `return`

### Control flow
- `if / elif / else` — like `if / else if / else`
- `for x in iterable:` — like `for (const x of iterable)`
- `for...else` / `while...else` — the `else` clause runs if the loop completes without `break` (no TS equivalent)
- `while`, `break`, `continue`
- `raise` statement — `raise ValueError("x")` — like `throw new Error("x")` in TS
- `del` statement — `del x`, `del d["key"]`, `del lst[0]`
- `assert` statement — `assert x > 0, "must be positive"`
- `try / except / else / finally` (Python's name for catch)
- Chained comparisons: `1 < x < 10` (equivalent to `1 < x && x < 10`)
- Short-circuit `and` / `or` (note: they return the operand, not a boolean — like `&&` / `||` in TS)
- Semicolons separate simple statements on one line: `a = 1; b = 2`
- One-line bodies: `if x: y = 1`, `for i in xs: print(i)`, `def f(): return 1`
- Runaway recursion raises a catchable `RecursionError` at 1,000 nested calls (500 when each level goes through a built-in callback, such as a recursive `sorted` key or an `lru_cache` wrapper)

### Built-ins
Working: `len`, `range` *(lazy, like CPython)*, `print` *(with `sep`/`end` kwargs)*, `abs`, `min` / `max` *(with `key=` and `default=`)*, `sum`, `round` *(banker's rounding)*, `sorted`, `reversed`, `enumerate` *(with `start=`)*, `zip`, `map`, `filter`, `any`, `all`, `type`, `isinstance` *(accepts types and tuples of types)*, `issubclass`, `repr`, `ascii`, `format`, `hex`, `oct`, `bin`, `ord`, `chr`, `pow` *(with optional modulo)*, `divmod`, `callable`, `iter`, `next`, `hash`, `id`, `getattr`, `hasattr`, and the type constructors `int`, `float`, `str`, `bool`, `list`, `tuple`, `dict`, `set`, `slice`.

`map`, `filter`, `zip` and `enumerate` return lazy iterators, so `next(map(f, xs))` calls `f` once. `type(x)` returns a type object: `type(x) == int`, `type(x).__name__` and `isinstance(True, int)` behave as in CPython. `__name__` is `"__main__"`, so the usual `if __name__ == "__main__":` guard runs.

### Exceptions
```python
try:
    int("abc")
except ValueError as e:
    str(e)             # "invalid literal for int() with base 10: 'abc'"
    e.args             # ("invalid literal for int() with base 10: 'abc'",)
    type(e).__name__   # 'ValueError'
    raise              # re-raises the same exception
```
An exception is an object, not a string. As in CPython, the name after `as` is unbound again when the handler ends. The classes form CPython's hierarchy: `Exception`, `ArithmeticError` (`ZeroDivisionError`, `OverflowError`), `LookupError` (`KeyError`, `IndexError`), `ValueError`, `TypeError`, `AttributeError`, `NameError` (`UnboundLocalError`), `RuntimeError` (`RecursionError`, `NotImplementedError`, `ToolError`), `AssertionError`, `StopIteration`, `ImportError` (`ModuleNotFoundError`), `MemoryError`. `except LookupError` therefore catches a `KeyError`. `raise X from Y` parses; the cause is ignored.

`ToolError` (sandbox-specific) is raised when a JS tool handler throws, so scripts can implement fallbacks; `MemoryError` is raised when an allocation would exceed the host's configured limits. The host-side `maxIterations`, `timeoutMs` and `AbortSignal` bounds (`MaxIterationsError`, `TimeoutError`, `CancelledError`) are deliberately **not** catchable — not even by a bare `except:`, and `finally` blocks do not run for them — so a `try` inside a loop can't neutralize them.

Error messages use CPython 3.14's type names and wording (`name 'x' is not defined`, `division by zero`, `'str' object has no attribute 'push'`) and carry a real `Line N, Column N` position, including errors raised inside built-ins. Models self-correct by pattern-matching CPython error text, so this wording is part of the behavioral contract. Unsupported constructs that models emit anyway (`class`, `with`, `match`, `async`/`await`, `b"..."`) fail at parse time with a targeted message saying the construct is unsupported and what to do instead, rather than a generic `Unexpected token`. Absent built-ins such as `open` and `eval` raise a `NameError` that says why they are absent.

### F-strings
```python
name = "Alice"
f"hello {name}"                   # "hello Alice"
f"{1 + 2}"                        # "3"
f"{[x for x in range(3)]}"        # "[0, 1, 2]"
```
F-strings are like TS template literals (`` `hello ${name}` ``), but use `{...}` instead of `${...}`. Also supported: `{x!r}` / `{x!s}` / `{x!a}` conversions, the debug form `{x=}`, and a format spec that itself interpolates (`{value:{width}.{precision}f}`).

### Sets
Set literals, `set()`, comprehensions, methods, and operators all work:
```python
{1, 2, 2}                      # {1, 2} — set literal (deduplicates)
{(1, 2), (3, 4)}               # tuples are valid members
set([1, 1, 2])                 # {1, 2}
{x for x in range(10) if x > 5}  # {6, 7, 8, 9} — set comprehension
a | b, a & b, a - b, a ^ b     # union, intersection, difference, symmetric difference
s.add(x), s.remove(x), s.issubset(t), ...
```
Members can be any hashable value (same rules as dict keys, tuples included). Like `new Set()` in TS, except membership is by value — `(1, 2)` equals `(1, 2)` — not by reference.

`frozenset` is the immutable kind: the same operators, methods and comparisons, no `add`/`remove`/`update`, and it is hashable, so `{frozenset(pair) for pair in edges}` deduplicates unordered pairs and a frozenset can be a dict key. Operators return the left operand's kind (`frozenset | set` is a frozenset), `fs |= s` rebinds to a new frozenset, and `frozenset(fs)` returns `fs` itself, as in CPython.

### Multiline strings
Triple-quoted strings work: `"""multi\nline"""`.

### Raw strings
```python
r"\d+"        # backslashes kept literally — like String.raw`\d+` in TS
r'\n'         # the two characters \ and n, not a newline
rf"\d{n}"     # raw f-string: literal backslashes plus interpolation
```
`r`/`R` prefixes (and `rf`/`fr` combinations) work, including triple-quoted. As in CPython, a raw string cannot end in a lone backslash.

### Number literal formats
```python
0xff          # hex → 255
0o77          # octal → 63
0b1010        # binary → 10
1_000_000     # underscore separators → 1000000
3.14_15       # underscores in floats too
```
Python supports hex (`0x`), octal (`0o`), and binary (`0b`) prefixes, plus underscore digit separators for readability. No direct TS equivalent for the underscore separators (TS uses `_` too, but only in numeric literals since ES2021).

### Operators
Arithmetic: `+`, `-`, `*`, `/`, `//`, `%`, `**`.
Bitwise: `&`, `|`, `^`, `~`, `<<`, `>>`.
Set: `|` (union), `&` (intersection), `-` (difference), `^` (symmetric difference).
String: `%` formatting (`"%s is %d" % ("age", 25)`), `+` concatenation, `*` repetition.
Assignment: `a, *b, c = [1, 2, 3, 4, 5]` (starred unpacking), slice assignment (`x[1:3] = [20, 30]`).

### Scope and closures
- Functions capture their enclosing scope (lexical scoping, same as TS).
- `global x` — declare that `x` in this function refers to the module-level variable
- `nonlocal x` — declare that `x` refers to the enclosing function's variable (not global)

### F-strings with nested quotes
```python
f'{"big" if x > 3 else "small"}'   # works — double quotes inside single-quoted f-string
f"{'hello'}"                        # works — single quotes inside double-quoted f-string
```
F-string expressions can contain string literals using a different quote character from the f-string's delimiter, just like in CPython 3.12+.

### F-string format specs
```python
f"{3.14159:.2f}"   # "3.14"   — like x.toFixed(2) in TS
f"{42:d}"          # "42"     — integer format
f"{42:08b}"        # "00101010" — binary, zero-padded to width 8
f"{255:x}"         # "ff"     — hex
f"{'hi':>10}"      # "        hi" — right-aligned in width 10
f"{1234567.891:,.2f}"   # "1,234,567.89" — thousands separator
f"{0.256:.1%}"     # "25.6%"
f"{12:+d}"         # "+12"
```
The spec is Python's full format mini-language: fill and alignment (`<`, `>`, `^`, `=`), sign (`+`, `-`, space), `#`, zero-fill, width, grouping (`,` and `_`), precision, and the types `d b o x X c e E f F g G n %` and `s`. `format(value, spec)` and `"{:>8.2f}".format(value)` use the same code, and `"%05.1f" % value` supports the printf flags.

### Boolean arithmetic
```python
True + 1               # 2  (bool is a subclass of int in Python)
False + 1              # 1
sum([True, False, True])  # 2
True * 5               # 5
```
In Python, `bool` inherits from `int` — `True` acts as `1` and `False` as `0` in all arithmetic. In TS, `true + 1 === 2` works because of coercion; Python does the same via class hierarchy.

### Lambda as keyword argument
```python
sorted(['banana', 'apple'], key=lambda x: len(x))  # ['apple', 'banana']
```
Lambdas with function calls in their bodies can be passed directly as keyword arguments (e.g., `key=`). No need to assign to a variable first.

### Generators / `yield`
```python
def count_up(n):
    i = 0
    while i < n:
        yield i
        i += 1

list(count_up(5))            # [0, 1, 2, 3, 4]

g = count_up(3)
next(g)                      # 0
next(g)                      # 1
next(g)                      # 2
```
A generator function contains `yield` in its body. Calling it returns a generator object instead of executing the body immediately. Each call to `next()` resumes execution until the next `yield`, which produces a value and suspends. When the function body completes, `StopIteration` is raised.

In TypeScript, the closest analogue is an `async function*` (async generator), though Python generators are synchronous from the caller's perspective.

Supported:
- `yield value` and bare `yield` (yields `None`)
- `yield from iterable` — delegates to a sub-generator or any iterable
- Generators work with `for` loops, `list()`, `sorted()`, `enumerate()`, and `next()`
- Multiple independent generators can be active simultaneously
- `StopIteration` exception when exhausted
- `next(gen, default)` returns `default` instead of raising `StopIteration`

- `x = yield value` with `gen.send(value)`, and `gen.close()`
- `result = yield from sub()` receives the sub-generator's return value
- Generator expressions are lazy: `next(x for x in rows if x > 1)` stops at the first match

Not supported: `gen.throw()`, and `yield from` does not pass `send()` values through to the inner generator. A generator that is dropped or closed half-way does not run its `finally` blocks.

### Importable modules

Four pure-computation modules are whitelisted: `datetime`, `math`, `statistics`, and `re`. All standard import forms work for each:

```python
import datetime
import datetime as dt
from datetime import datetime, date, timedelta
from math import sqrt as root
from statistics import *
from re import findall
```

Importing anything else raises `ModuleNotFoundError` (catchable with `except ImportError`, as in CPython).

### The `datetime` module

| Feature | Does | TS analogue |
|---|---|---|
| `datetime(y, m, d, [h, min, s, us])` | Construct a naive datetime | `new Date(y, m-1, d, ...)` |
| `date(y, m, d)` | Construct a date | no direct equivalent |
| `timedelta(days=, hours=, ...)` | A duration; kwargs accept floats | milliseconds number |
| `datetime.now()` / `date.today()` | Wall-clock time in the session timezone (see below) | `new Date()` |
| `datetime.utcnow()` | UTC wall-clock time | `new Date()` UTC getters |
| `datetime.fromisoformat(s)` / `date.fromisoformat(s)` | Parse ISO 8601 | `new Date(s)` |
| `datetime.strptime(s, fmt)` | Parse with `%Y-%m-%d`-style directives | date library |
| `d.isoformat(sep="T", timespec="auto")` | ISO 8601 string; `timespec` is `hours`, `minutes`, `seconds`, `milliseconds` or `microseconds` | `d.toISOString()` |
| `d.strftime(fmt)` | Format (`%Y %y %m %d %H %M %S %f %I %p %j %a %A %b %B %%`) | date library |
| `d.year` … `d.microsecond`, `td.days/seconds/microseconds` | Component access | `getFullYear()` etc. |
| `d.weekday()` | Monday=0 … Sunday=6 | `(getDay() + 6) % 7` |
| `d.replace(year=..., ...)` | Copy with fields changed | spread + override |
| `dt.date()` | Truncate datetime to date | no direct equivalent |
| `td.total_seconds()` | Duration as float seconds | `ms / 1000` |
| `dt2 - dt1` → `timedelta`, `dt ± td`, `td ± td`, `td * n`, `td / n` | Arithmetic | manual ms math |
| `<` `<=` `==` etc., `sorted()`, `min()`/`max()` | Comparison and ordering | `getTime()` comparison |
| `f"{dt:%Y-%m}"` | Format spec delegates to `strftime` | template literal |

**Timezone model.** All datetimes are naive (no `tzinfo`), but the host configures a *session timezone* (`createInterpreter({ timezone: 'Europe/Berlin' })`, default `'UTC'`) and the sandbox behaves as if the Python were running on a computer in that timezone: `now()`/`today()` return its wall-clock time, and `fromisoformat()` converts `Z`/`±HH:MM`-suffixed strings into it (a deviation — CPython 3.11+ would return an aware datetime). Offset-free strings are never reinterpreted. The clock itself is also injectable: `createInterpreter({ now: () => epochMillis })`.

Known limitations:
- No `tzinfo` / aware datetimes, no `astimezone()`, no `datetime.time` (time-of-day) class, no `fold`.
- `datetime.now()` reflects the injected clock and session timezone, not the process-local timezone (CPython uses the machine's local time).

JS `Date` objects returned by tool handlers (e.g. timestamp columns from a database driver) marshal into naive `datetime` values in the session timezone — the same wall clock `datetime.now()` uses. An invalid `Date` raises `ValueError`, and an instant outside the years 1 to 9999 raises `OverflowError`, which is also what `fromisoformat()` raises when an offset pushes the result out of that range.

### The `math` module

| Feature | Does | TS analogue |
|---|---|---|
| `sqrt`, `exp`, `pow`, `fabs` | The obvious | `Math.sqrt` etc. |
| `floor(x)`, `ceil(x)`, `trunc(x)` | Float → int (errors on inf/nan like CPython) | `Math.floor` etc. |
| `log(x)`, `log(x, base)`, `log10`, `log2` | Logarithms | `Math.log(x) / Math.log(base)` |
| `sin cos tan asin acos atan atan2` | Trigonometry (radians) | `Math.*` |
| `radians(x)` / `degrees(x)` | Angle conversion | manual `* Math.PI / 180` |
| `isnan` / `isinf` / `isfinite` | Float classification | `Number.isNaN` / `Number.isFinite` |
| `isclose(a, b, rel_tol=, abs_tol=)` | Tolerant float comparison | no stdlib analogue |
| `pi`, `e`, `tau`, `inf`, `nan` | Constants | `Math.PI`, `Infinity`, `NaN` |

Results are floats (`math.sqrt(16)` is `4.0`), except `floor`/`ceil`/`trunc`, which return ints. Domain errors raise `ValueError: math domain error` for `sqrt(-1)`, `log(0)`, `asin(2)` (CPython 3.14 words these differently per function); `exp(1000)` raises `OverflowError: math range error`. `inf`/`nan` print as Python does (`'inf'`, not JavaScript's `'Infinity'`).

Not included: `factorial`/`comb`/`perm` (unbounded loops, no agent use case), `gcd`/`hypot`/`fsum` (easy future adds), float plumbing (`frexp`, `ldexp`, `ulp`).

### The `statistics` module

| Feature | Does | TS analogue |
|---|---|---|
| `mean(data)` | Arithmetic mean | manual reduce |
| `median(data)` | Middle value (averages middle pair for even n) | manual sort + pick |
| `mode(data)` | Most common value; works on strings for categorical data; ties → first encountered | manual counting |
| `stdev` / `variance` | Sample spread (n−1 divisor) | no stdlib analogue |
| `pstdev` / `pvariance` | Population spread (n divisor) | no stdlib analogue |
| `quantiles(data, n=4, method='exclusive')` | Cut points (quartiles, deciles, percentiles) | no stdlib analogue |
| `StatisticsError` | Raised on empty/insufficient data; subclasses `ValueError` | — |

Inputs accept any iterable, generators included; elements may be numbers or booleans (plus any hashable value for `mode`). As in CPython, an exact result of int data stays an int (`mean([1, 2, 3])` is `2`, `mean([1, 2])` is `1.5`). Not included: `xbar=` on variance/stdev, `fmean`/`geometric_mean`/`harmonic_mean`/`median_low`/`median_high`.

### The `re` module

Backed by JavaScript `RegExp` — Python patterns are translated to the JS dialect before compilation.

| Feature | Does | TS analogue |
|---|---|---|
| `search(p, s)` / `match(p, s)` / `fullmatch(p, s)` | First match anywhere / anchored at start / whole string; `None` when no match | `s.match(re)` |
| `findall(p, s)` | All matches: strings, group strings, or tuples per CPython's group-count rules | `s.match(/…/g)` |
| `finditer(p, s)` | Iterator of match objects | `s.matchAll(re)` |
| `sub(p, repl, s, count=0)` / `subn` | Replace; `repl` is a template (`\1`, `\g<name>`, `\\`, `\n`) or a function called with each match | `s.replace(re, r)` |
| `split(p, s, maxsplit=0)` | Split, captured groups included in the result | `s.split(re)` |
| `compile(p, flags=0)` | Pattern object with all of the above as methods, plus `.pattern` | `new RegExp(p)` |
| `escape(s)` | Escape special characters (CPython 3.7+ set) | manual replace |
| `m.group(...)`, `m[0]`, `m.groups()`, `m.groupdict()`, `m.start/end/span()` | Match object accessors, including named groups | `m.groups`, `m.index` |
| `IGNORECASE`/`I`, `MULTILINE`/`M`, `DOTALL`/`S`, `ASCII`/`A` | Flags, combinable with `\|`; inline `(?i)` etc. also work | `i` / `m` / `s` RegExp flags |
| `(?P<name>…)`, `(?P=name)`, `\A`, `\Z`, `(?#…)` | Python-only syntax, translated for JS | `(?<name>…)`, `\k<name>` |

**Dialect caveats** (JS `RegExp` under the hood): `\d`/`\w`/`\s` are ASCII-only (CPython's default is Unicode-aware; this matches `re.ASCII` behavior, so the `ASCII` flag is a no-op); `$` does not match before a trailing newline like Python's does (use `\Z` semantics or `re.M`). Not supported, with targeted errors: `re.VERBOSE`/`(?x)`, scoped inline flags `(?i:…)` and conditional groups `(?(id)…)`. Invalid patterns raise `ValueError`; `re.error` is an alias for it, so `except re.error:` works.

### Optional modules

Six more modules ship with the package as separate entry points. A host passes them in with `createInterpreter({ modules: [json, itertools, collections, functools, string, random] })`; without that, importing them raises `ModuleNotFoundError` like any other module.

#### `json`

| Feature | Does | TS analogue |
|---|---|---|
| `dumps(obj, indent=, sort_keys=, separators=, default=, ensure_ascii=)` | Serialize; keys may be str, int, float, bool or None; tuples become arrays | `JSON.stringify(obj, null, indent)` |
| `loads(s)` | Parse; ints stay exact, `1.0` stays a float, `NaN`/`Infinity` accepted | `JSON.parse(s)` |
| `JSONDecodeError` | Raised on bad input with CPython's message and position; subclasses `ValueError` | `SyntaxError` from `JSON.parse` |

`ensure_ascii` defaults to True, so non-ASCII text is written as `\uXXXX` escapes, as in CPython. `default=` may be any callable, including one that calls a tool. Not included: `load`/`dump` (files), `object_hook`, `parse_float`, `cls=`.

#### `itertools`

`chain` and `chain.from_iterable`, `count`, `cycle`, `repeat`, `accumulate` (with `func=` and `initial=`), `islice`, `takewhile`, `dropwhile`, `filterfalse`, `groupby` (lazy, sharing one pass like CPython), `zip_longest`, `starmap`, `pairwise`, `batched`, `product` (with `repeat=`), `permutations`, `combinations`, `combinations_with_replacement`. All return lazy iterators. Not included: `tee`, `compress`.

#### `collections`

| Type | Supports |
|---|---|
| `Counter` | Construction from an iterable, mapping or keywords; `most_common`, `elements`, `total`, `update`, `subtract`, `copy`; `+ - & \|`; a missing key counts as 0. It is a `dict` |
| `defaultdict` | Any callable factory, including one that calls a tool; `copy`. It is a `dict` |
| `OrderedDict` | `move_to_end`, `popitem(last=)`, `copy`. Plain dicts keep order too; this exists for scripts that ask for it |
| `deque` | `append`/`appendleft`, `pop`/`popleft`, `extend`/`extendleft`, `rotate`, `clear`, `count`, `index`, `remove`, `reverse`, `copy`, `maxlen`, indexing, `len`, iteration, `in` |
| `namedtuple` | Field access, `_fields`, `_asdict`, `_replace`, `defaults=`; instances are tuples |

#### `functools`

| Feature | Does | TS analogue |
|---|---|---|
| `reduce(fn, iterable[, initial])` | Fold left; the callback may call a tool | `arr.reduce(fn, initial)` |
| `partial(fn, *args, **kwargs)` | Bind leading positional and keyword arguments; `.func`, `.args`, `.keywords`; a partial of a partial flattens | `fn.bind(null, ...args)` |
| `lru_cache(maxsize=128, typed=False)`, `@lru_cache`, `@cache` | Memoize on the argument values; `cache_info()`, `cache_clear()`, `cache_parameters()`, `__wrapped__`; unhashable arguments raise `TypeError` | A `Map` keyed by the arguments |
| `cmp_to_key(cmp)` | Key objects for `sorted`, `list.sort`, `min`, `max` and `<`; `cmp` may call a tool | `arr.sort(cmp)` |
| `wraps`, `update_wrapper` | Return the wrapper unchanged (functions carry no `__name__`/`__doc__` to copy) | — |

Not included: `total_ordering`, `singledispatch`, `cached_property` (all need classes). A cached recursive function re-enters the interpreter once per level, so recursion through `lru_cache` is limited to 500 levels instead of 1,000.

#### `string`

`ascii_letters`, `ascii_lowercase`, `ascii_uppercase`, `digits`, `hexdigits`, `octdigits`, `punctuation`, `printable`, `whitespace`, and `capwords(s, sep=None)`. Not included: `Template`, `Formatter` (classes).

#### `random`

A port of CPython's Mersenne Twister and its `_randbelow` rejection step, so every function below gives CPython's output for the same int seed.

| Feature | Does | TS analogue |
|---|---|---|
| `seed(a=None)` | `None` reseeds from OS entropy; an `int` of any size or a `str` reseeds deterministically, matching CPython. `float` seeds raise `TypeError` | — |
| `random()`, `uniform(a, b)`, `triangular(low, high, mode)` | Floats | `Math.random()` |
| `randint(a, b)`, `randrange(start, stop, step)`, `getrandbits(k)` | Exact ints of any size | — |
| `choice(seq)`, `choices(population, weights=, cum_weights=, k=)`, `sample(population, k, counts=)`, `shuffle(list)` | On lists, tuples, strings and ranges; `shuffle` is in place on lists | — |
| `gauss`, `normalvariate`, `expovariate` | Distributions, matching CPython digit for digit | — |
| `Random(seed=None)` | An independent generator with the same methods | — |

Each interpreter owns one generator (fresh entropy per `createInterpreter`, state kept across `run()` calls). Not included: `getstate`/`setstate`, `randbytes`, `betavariate`/`gammavariate`/`lognormvariate`/`vonmisesvariate`/`paretovariate`/`weibullvariate`, `binomialvariate`.

---

## ❌ Known Missing Features

See `missing.md` for the full list and the reasons. The big ones are `class` definitions, the `with` statement, `match`, `async`/`await`, and every module outside `datetime`, `math`, `statistics`, `re` and the six optional ones above.

---

## TypeScript ↔ Python cheat sheet

Quick reference for the most confusing translations:

| Python | TypeScript equivalent | Notes |
|---|---|---|
| `len(x)` | `x.length` or `x.size` | works on strings, lists, tuples, dicts, sets |
| `str(x)` | `String(x)` | Python always returns `"True"` / `"False"` capitalized |
| `int(x)` | `Math.trunc(x)` / `parseInt(x)` | Python raises on bad input; JS returns `NaN` |
| `None` | `null` or `undefined` | Python has only one null-like value |
| `True` / `False` | `true` / `false` | Python capitalizes |
| `and` / `or` / `not` | `&&` / `\|\|` / `!` | Python uses keywords |
| `elif` | `else if` | |
| `x in lst` | `lst.includes(x)` | also works on dicts (checks keys) and strings (substring) |
| `for x in lst` | `for (const x of lst)` | |
| `[x * 2 for x in lst]` | `lst.map(x => x * 2)` | list comprehension |
| `[x for x in lst if x > 0]` | `lst.filter(x => x > 0)` | list comprehension with condition |
| `lambda x: x + 1` | `(x) => x + 1` | single-expression arrow function |
| `def f(a, b=10): ...` | `function f(a, b = 10) { ... }` | default args |
| `*args` | `...args` (rest) | |
| `**kwargs` | `...rest` into an object | Python separates positional rest and keyword rest |
| `a, b = 1, 2` | `const [a, b] = [1, 2]` | works everywhere (statements, for loops, functions) |
| `raise Exception("x")` | `throw new Error("x")` | |
| `try: ... except E: ...` | `try { ... } catch (e) { if (e instanceof E) ... }` | |
| `f"{x}"` | `` `${x}` `` | f-string / template literal |
| `dict.get(k, default)` | `k in d ? d[k] : default` | |
| `//` | `Math.floor(a / b)` | floor division — note the negative-number caveat |
| `**` | `a ** b` | power operator (same syntax in both) |
| `is` / `is not` | `===` / `!==` (roughly) | identity check, not equality |

---
