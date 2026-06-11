# tespy-parser: Feature Support Matrix

A Python interpreter implemented in TypeScript. This document describes which Python features are supported and which are not, based on `tests/features.test.ts` (**733 pass / 0 fail** as of 2026-06-11).

Explanations are written for TypeScript developers who may not know Python.

---

## Table of Contents

- [✅ Working Features](#-working-features)
- [❌ Broken or Missing Features](#-broken-or-missing-features)
- [TypeScript ↔ Python cheat sheet](#typescript--python-cheat-sheet)

---

## ✅ Working Features

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
Python's `+=`, `-=`, `*=`, `/=`, `//=`, `%=`, `**=` behave like the TypeScript equivalents (with `//` being floor division, which has no TS operator).

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
- `float("3.14")` → `3.14`, `float(5)` → `5.0`
- `int("42")` → `42`, `int(True)` → `1`
- `int(-3.9)` → `-3` (truncates toward zero, like CPython)
- `int("3.14")` → raises `ValueError` (only whole-integer strings accepted)

Python has no separate `int` vs. `float` types in TS's sense — both are JS `number` internally, but Python prints `1` vs. `1.0` differently. The interpreter preserves that distinction.

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
```
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
lst.sort()             # in-place
lst.clear()            # empty the list
lst.copy()             # shallow copy
```
Also supported: slicing (`lst[1:3]`, `lst[::-1]`), negative indices, `in` membership, list comprehensions (`[x*2 for x in lst if x > 0]`).

### Dicts (Python's plain object / Map)
```python
d = {"a": 1, "b": 2}
d["a"]                 # 1
d.get("c", 0)          # default if missing — no TS equivalent for plain objects
d.keys()               # Object.keys(d)
d.values()             # Object.values(d)
d.items()              # Object.entries(d)
d.update({"c": 3})     # Object.assign(d, {c: 3})
d.pop("a")             # remove and return
d.setdefault("x", 0)   # get, or set-and-return default
dict.fromkeys(["a","b"], 0) # {"a": 0, "b": 0} — static constructor
"a" in d               # d.hasOwnProperty("a")
```
Dict comprehensions (`{k: v for k, v in items}`) also work.

### Functions
- Definitions: `def f(a, b): ...`
- Default arguments: `def f(a, b=10)`
- Keyword arguments: `f(a=1, b=2)`
- `*args` (rest parameter): `def f(*args): return len(args)` — like `function f(...args)` in TS
- `**kwargs` (keyword rest): `def f(**kwargs): return kwargs["key"]` — collects keyword args into a dict
- `*list` / `**dict` unpacking in calls: `f(*args, **kwargs)` — spreads iterables/dicts into arguments
- `@decorator` syntax — decorators wrap functions, applied bottom-up
- Recursion, nested functions, closures
- Lambdas: `lambda x: x * 2` — like `(x) => x * 2`
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

### Built-ins
Working: `len`, `range`, `print` *(with `sep`/`end` kwargs)*, `abs`, `min`, `max`, `sum`, `round` *(banker's rounding)*, `sorted`, `reversed`, `enumerate` *(with `start=`)*, `zip`, `map`, `filter`, `any`, `all`, `type`, `isinstance` *(accepts type builtins and tuples)*, `repr`, `hex`, `oct`, `bin`, `ord`, `chr`, `pow` *(with optional modulo)*, `divmod`, `callable`, `iter`, `next`, `hash`, `id`, `tuple`.

Exception constructors: `Exception`, `ValueError`, `TypeError`, `KeyError`, `IndexError`, `ZeroDivisionError`, `NameError`, `RuntimeError` — all work with `raise` and `except`.

### F-strings (most cases)
```python
name = "Alice"
f"hello {name}"                   # "hello Alice"
f"{1 + 2}"                        # "3"
f"{[x for x in range(3)]}"        # "[0, 1, 2]"
```
F-strings are like TS template literals (`` `hello ${name}` ``), but use `{...}` instead of `${...}`.

### Sets
`set([1, 1, 2])` → `{1, 2}` works. Set-literal comprehensions also work:
```python
{x for x in range(3)}          # {0, 1, 2}
{x for x in [1, 1, 2]}         # {1, 2} (deduplicates)
{x for x in range(10) if x > 5}  # {6, 7, 8, 9} (with condition)
```
Set comprehensions are like list comprehensions but produce a `set` (deduplicated, unordered). No direct TS equivalent; roughly `new Set(array.map(fn))`.

### Multiline strings
Triple-quoted strings work: `"""multi\nline"""`.

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
```
The `:<spec>` portion supports precision (`.Nf`), type (`d`, `f`, `b`, `o`, `x`, `X`, `e`, `E`), width, alignment (`<`, `>`, `^`), and zero-fill.

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

Not yet supported:
- `gen.send(value)` — sending values into a generator
- `gen.throw()` / `gen.close()` — generator cleanup protocol

### The `datetime` module

The only importable module. All standard import forms work:

```python
import datetime
import datetime as dt
from datetime import datetime, date, timedelta
from datetime import datetime as DT
from datetime import *
```

Importing anything else raises `ModuleNotFoundError` (catchable with `except ImportError`, as in CPython).

| Feature | Does | TS analogue |
|---|---|---|
| `datetime(y, m, d, [h, min, s, us])` | Construct a naive datetime | `new Date(y, m-1, d, ...)` |
| `date(y, m, d)` | Construct a date | no direct equivalent |
| `timedelta(days=, hours=, ...)` | A duration; kwargs accept floats | milliseconds number |
| `datetime.now()` / `date.today()` | Wall-clock time in the session timezone (see below) | `new Date()` |
| `datetime.utcnow()` | UTC wall-clock time | `new Date()` UTC getters |
| `datetime.fromisoformat(s)` / `date.fromisoformat(s)` | Parse ISO 8601 | `new Date(s)` |
| `datetime.strptime(s, fmt)` | Parse with `%Y-%m-%d`-style directives | date library |
| `d.isoformat()` | ISO 8601 string | `d.toISOString()` |
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
- `date`/`datetime` values are not hashable — they can't be dict keys or set members.
- `datetime.now()` reflects the injected clock and session timezone, not the process-local timezone (CPython uses the machine's local time).

---

## ❌ Known Missing Features

See `missing.md` for the full list. Major gaps: `class` definitions, `with` statement (context managers).

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

*Generated from `tests/features.test.ts` against commit `a2c3413`.*
