# tespy-parser: Feature Support Matrix

A Python interpreter implemented in TypeScript. This document describes which Python features are supported and which are not, based on `tests/features.test.ts` (**186 pass / 34 fail** as of 2026-04-17).

Explanations are written for TypeScript developers who may not know Python.

---

## Table of Contents

- [✅ Working Features](#-working-features)
- [❌ Broken or Missing Features](#-broken-or-missing-features)
  - [Parser gaps](#parser-gaps)
  - [Missing string methods](#missing-string-methods)
  - [Runtime bugs](#runtime-bugs)
- [TypeScript ↔ Python cheat sheet](#typescript--python-cheat-sheet)

---

## ✅ Working Features

### Basic augmented assignment
```python
x += 1    # works  (like TS: x += 1)
x -= 1    # works
x *= 2    # works
x /= 2    # works
```
Python's `+=`, `-=`, `*=`, `/=` behave like the TypeScript equivalents.

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

### Most string methods

| Method | Does | TS analogue |
|---|---|---|
| `s.upper()` / `s.lower()` | Uppercase / lowercase | `s.toUpperCase()` / `s.toLowerCase()` |
| `s.strip()` | Trim whitespace | `s.trim()` |
| `s.strip(chars)` | Trim specific chars from both ends | no direct equivalent |
| `s.replace(old, new)` | Replace all occurrences | `s.replaceAll(old, new)` |
| `s.split(sep)` | Split into list | `s.split(sep)` |
| `s.startswith(x)` / `s.endswith(x)` | Prefix / suffix check | `s.startsWith(x)` / `s.endsWith(x)` |
| `s.find(x)` | Index of substring, `-1` if missing | `s.indexOf(x)` |
| `s.count(x)` | Count non-overlapping occurrences | no direct equivalent (**buggy with regex chars, see below**) |
| `s.join(list)` | Join list with `s` as separator | `list.join(s)` (note: args reversed) |
| `s.isdigit()` / `s.isalpha()` / `s.isalnum()` | Character-class predicates | regex equivalent |
| `s.title()` / `s.capitalize()` / `s.swapcase()` | Case transforms | no direct equivalent |
| `s.zfill(n)` | Pad left with zeros | `s.padStart(n, '0')` |
| `s.format(...)` | Named/positional placeholder substitution | template literals |
| `s * n` | Repeat string `n` times | `s.repeat(n)` |

### `str()`, `float()`, and partial `int()` conversions
- `str(123)` → `"123"` — like `String(123)` in TS
- `str(True)` → `"True"` (note: Python capitalizes booleans)
- `str([1, 2])` → `"[1, 2]"` (prints list representation)
- `float("3.14")` → `3.14`, `float(5)` → `5.0`
- `int("42")` → `42`, `int(True)` → `1`

Python has no separate `int` vs. `float` types in TS's sense — both are JS `number` internally, but Python prints `1` vs. `1.0` differently. The interpreter preserves that distinction.

### Tuples (mostly)
```python
t = (1, 2, 3)       # immutable list — like `readonly [1, 2, 3]` in TS
t[0]                # 1
len(t)              # 3
1 in t              # True
a, b, c = t         # destructuring (works in *function bodies*, see broken features for top-level)
```
A tuple is conceptually a fixed-size, immutable array. Python uses them for multi-return values:
```python
def divmod(a, b):
    return a // b, a % b   # returns a tuple
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

### Set comprehensions behave like sets when created via `set()`
`set([1, 1, 2])` → `{1, 2}` works. But **set-literal comprehensions** (`{x for x in ...}`) do not — see broken features.

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

### Parser gaps

These produce `SyntaxError` — the parser does not recognize the syntax.

#### 1. Extended augmented assignments
```python
x //= 3    # floor-divide and assign
x %= 3     # modulo and assign
x **= 2    # power and assign
```
Python supports `//=`, `%=`, and `**=` (analogous to `/=` and `*=`). **The parser only handles the common four** (`+=`, `-=`, `*=`, `/=`). These three are unrecognized tokens.

**What they should do:** same as `x = x // 3`, `x = x % 3`, `x = x ** 2`.

#### 2. Tuple unpacking at statement level
```python
a, b = 1, 2              # swap-style multi-assignment
a, b, c = [10, 20, 30]   # destructure from list
a, b = b, a              # swap values
a, (b, c) = 1, (2, 3)    # nested destructuring
```
All of these fail. Equivalent TS destructuring works fine: `const [a, b] = [1, 2]`. The parser does not allow comma-separated targets on the left side of `=`.

**Note:** tuple unpacking works inside function parameters and `for` loops — just not as a statement.

#### 3. Tuple concatenation
```python
(1, 2) + (3, 4)   # should produce (1, 2, 3, 4)
```
Tuples should concatenate with `+` the same way lists do. In TS: `[...[1,2], ...[3,4]]`. Currently fails.

#### 4. Set-literal comprehensions
```python
{x for x in range(3)}          # should be {0, 1, 2}
{x for x in [1, 1, 2]}         # should be {1, 2} (dedupes)
```
The parser sees `{` and assumes a dict literal, so it demands a `:` after the first element. A set comprehension is distinguished from a dict comprehension by the absence of `:`. There is no direct TS equivalent; roughly: `new Set(range(3).map(x => x))`.

---

### Missing string methods

All of these throw `AttributeError: 'str' object has no attribute '<method>'`.

| Method | What it does | TS analogue |
|---|---|---|
| `s.lstrip()` | Trim whitespace from the **left** only | `s.trimStart()` |
| `s.rstrip()` | Trim whitespace from the **right** only | `s.trimEnd()` |
| `s.lstrip(chars)` | Trim specified chars from the left | — |
| `s.rstrip(chars)` | Trim specified chars from the right | — |
| `s.index(sub)` | Like `find()`, but **throws `ValueError` if not found** instead of returning -1 | `s.indexOf(sub)` + manual throw |
| `s.rfind(sub)` | Last index of substring, `-1` if missing | `s.lastIndexOf(sub)` |
| `s.isspace()` | True if string is non-empty and all whitespace | `/^\s+$/.test(s)` |
| `s.split(sep, maxsplit)` | Split, but stop after `maxsplit` splits | `s.split(sep, limit)` — but note: TS `limit` **truncates**, Python `maxsplit` keeps the remainder as the last element |
| `s.ljust(n, fill=' ')` | Pad right until length `n` | `s.padEnd(n, fill)` |
| `s.rjust(n, fill=' ')` | Pad left until length `n` | `s.padStart(n, fill)` |
| `s.center(n, fill=' ')` | Pad both sides to center the string | — |
| `s.replace(old, new, count)` | Replace **only the first `count` occurrences** | no direct equivalent |

**Note on `split(sep, maxsplit)`:**
```python
"a,b,c,d".split(",", 2)    # → ["a", "b", "c,d"]   (Python: remainder preserved)
"a,b,c,d".split(",").slice(0, 3)   # TS equivalent, roughly
```

---

### Runtime bugs

These parse but produce wrong results or crashes.

#### 1. `str.count()` treats input as a regex pattern
```python
"a.b.c".count(".")     # should be 2 (count literal dots)
                       # actually returns 5 (. matches every char)
```
**Root cause:** the implementation passes the argument to `new RegExp(pattern)` without escaping regex metacharacters. `.`, `*`, `+`, `(`, `)`, `[`, `]`, `?`, `^`, `$`, `|`, `\` will all misbehave.

**Fix:** escape with `pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` before building the RegExp, or use `split(sub).length - 1`.

#### 2. `int()` truncates in the wrong direction
```python
int(-3.9)   # should be -3 (Python truncates toward zero)
            # actually returns -4 (JS Math.floor rounds toward -Infinity)
```
Python's `int()` applied to a float truncates toward zero — like TS's `Math.trunc()`. The interpreter uses `Math.floor()`, which gives a different answer for negatives. (`Math.floor(-3.9) === -4`, `Math.trunc(-3.9) === -3`.)

#### 3. `int()` silently accepts float strings
```python
int("3.14")   # should raise ValueError: invalid literal for int()
              # actually returns 3
```
In Python, `int(str)` only accepts strings that represent whole integers (e.g. `"42"`, `"-5"`). Decimal strings must go through `float()` first: `int(float("3.14"))`. The current implementation uses JS `parseInt`, which stops reading at the `.` and returns `3` instead of raising.

#### 4. `sorted()` does not accept strings
```python
sorted("cba")    # should return ['a', 'b', 'c'] (iterate string chars)
```
In Python, strings are iterable (each character is an element), so `sorted("cba")` returns a list of sorted characters. The `sorted` built-in in this interpreter rejects strings with `TypeError: 'string' object is not iterable`.

#### 5. F-strings with nested matching quotes
```python
f'{"big" if x > 3 else "small"}'
```
This should work: the f-string uses single quotes on the outside, double quotes for the nested literals inside `{...}`. The parser fails with "Unterminated expression in f-string" because it does not track nesting / quote state properly inside the expression braces.

**Workaround:** if you need this pattern, assign to a variable first and interpolate.

#### 6. F-string format specs are ignored
```python
x = 3.14159
f"{x:.2f}"     # should be "3.14"
               # actually returns "3.14159"
f"{n:d}"       # integer formatting — ignored
f"{n:>10}"     # alignment / width — ignored
```
The `:<spec>` portion of an f-string placeholder controls formatting (precision, width, alignment, base). Roughly equivalent to `x.toFixed(2)` in TS for `:.2f`. The implementation currently strips or ignores the spec and just interpolates the value's default string form.

#### 7. Boolean arithmetic
```python
True + 1       # should be 2 (bool is a subclass of int in Python)
sum([True, False, True])   # should be 2
```
In Python, `bool` inherits from `int` — `True` acts as `1` and `False` as `0` in arithmetic. In TS, `true + 1 === 2` works because of coercion. The interpreter rejects boolean operands in `+`, probably by strict type checking in the binary op handler.

#### 8. Lambdas containing function calls, used as kwarg values
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
| `a, b = 1, 2` | `const [a, b] = [1, 2]` | **NOT SUPPORTED at top level** in this interpreter |
| `raise Exception("x")` | `throw new Error("x")` | |
| `try: ... except E: ...` | `try { ... } catch (e) { if (e instanceof E) ... }` | |
| `f"{x}"` | `` `${x}` `` | f-string / template literal |
| `dict.get(k, default)` | `k in d ? d[k] : default` | |
| `//` | `Math.floor(a / b)` | floor division — note the negative-number caveat |
| `**` | `a ** b` | power operator (same syntax in both) |
| `is` / `is not` | `===` / `!==` (roughly) | identity check, not equality |

---

*Generated from `tests/features.test.ts` against commit `89de649`.*
