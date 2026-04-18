# tespy-parser: Feature Support Matrix

A Python interpreter implemented in TypeScript. This document describes which Python features are supported and which are not, based on `tests/features.test.ts` (**507 pass / 5 fail** as of 2026-04-18).

Explanations are written for TypeScript developers who may not know Python.

---

## Table of Contents

- [✅ Working Features](#-working-features)
- [❌ Broken or Missing Features](#-broken-or-missing-features)
  - [Runtime bugs](#runtime-bugs)
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
"a" in d               # d.hasOwnProperty("a")
```
Dict comprehensions (`{k: v for k, v in items}`) also work.

### Functions
- Definitions: `def f(a, b): ...`
- Default arguments: `def f(a, b=10)`
- Keyword arguments: `f(a=1, b=2)`
- `*args` and `**kwargs` (variadic and rest-object)
- Recursion, nested functions, closures
- Lambdas: `lambda x: x * 2` — like `(x) => x * 2`
- Early return with `return`

### Control flow
- `if / elif / else` — like `if / else if / else`
- `for x in iterable:` — like `for (const x of iterable)`
- `while`, `break`, `continue`
- `for...else` and `while...else`: the `else` runs if the loop completed without `break` (Python-specific, no TS equivalent)
- `try / except / finally` (Python's name for catch)
- `raise` (Python's `throw`)
- Chained comparisons: `1 < x < 10` (equivalent to `1 < x && x < 10`)
- Short-circuit `and` / `or` (note: they return the operand, not a boolean — like `&&` / `||` in TS)

### Built-ins
Working: `len`, `range`, `print`, `abs`, `min`, `max`, `sum`, `round`, `sorted` *(on lists/tuples)*, `reversed`, `enumerate`, `zip`, `map`, `filter`, `any`, `all`, `type`, `isinstance`, `hex`, `oct`, `bin`, `ord`, `chr`, `repr`.

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

### Number formats
- Hex: `0xff` → 255
- Octal: `0o77` → 63
- Binary: `0b1010` → 10
- Underscore separators: `1_000_000` → 1000000

### Scope and closures
- Functions capture their enclosing scope (lexical scoping, same as TS).
- `global` and `nonlocal` keywords work.

---

## ❌ Broken or Missing Features

### Runtime bugs

These parse but produce wrong results or crashes.

#### 1. `sorted()` does not accept strings
```python
sorted("cba")    # should return ['a', 'b', 'c'] (iterate string chars)
```
In Python, strings are iterable (each character is an element), so `sorted("cba")` returns a list of sorted characters. The `sorted` built-in in this interpreter rejects strings with `TypeError: 'string' object is not iterable`.

#### 2. F-strings with nested matching quotes
```python
f'{"big" if x > 3 else "small"}'
```
This should work: the f-string uses single quotes on the outside, double quotes for the nested literals inside `{...}`. The parser fails with "Unterminated expression in f-string" because it does not track nesting / quote state properly inside the expression braces.

**Workaround:** if you need this pattern, assign to a variable first and interpolate.

#### 3. F-string format specs are ignored
```python
x = 3.14159
f"{x:.2f}"     # should be "3.14"
               # actually returns "3.14159"
f"{n:d}"       # integer formatting — ignored
f"{n:>10}"     # alignment / width — ignored
```
The `:<spec>` portion of an f-string placeholder controls formatting (precision, width, alignment, base). Roughly equivalent to `x.toFixed(2)` in TS for `:.2f`. The implementation currently strips or ignores the spec and just interpolates the value's default string form.

#### 4. Boolean arithmetic
```python
True + 1       # should be 2 (bool is a subclass of int in Python)
sum([True, False, True])   # should be 2
```
In Python, `bool` inherits from `int` — `True` acts as `1` and `False` as `0` in arithmetic. In TS, `true + 1 === 2` works because of coercion. The interpreter rejects boolean operands in `+`, probably by strict type checking in the binary op handler.

#### 5. Lambdas containing function calls, used as kwarg values
```python
sorted(['banana', 'apple'], key=lambda x: len(x))
```
This pattern — lambda body contains a function call, lambda is passed as a keyword argument inside another call — fails with a SyntaxError. Likely a parser issue where the lambda body's termination condition conflicts with the enclosing argument list's comma/paren tracking.

**Workaround:** assign the lambda to a variable first, then pass it:
```python
key_fn = lambda x: len(x)
sorted(['banana', 'apple'], key=key_fn)
```

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
