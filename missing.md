# Missing / Broken Python Features

Tested against the current codebase on 2026-04-19. Items marked ✅ have been fixed.

---

## Language constructs (parser-level)

1. **`class` definitions** — `class Foo:` fails with "Unexpected token: COLON"
2. ✅ ~~`raise` statement~~
3. ✅ ~~`del` statement~~
4. ✅ ~~`assert` statement~~
5. ✅ ~~`global` / `nonlocal` declarations~~
6. **`yield` / generators** — `yield 1` fails; no generator support
7. **`with` statement (context managers)** — fails at parse
8. ✅ ~~`for...else` / `while...else`~~
9. ✅ ~~`try...except...else`~~
10. ✅ ~~`@decorator` syntax~~
11. ✅ ~~`*args` / `**kwargs` in function definitions~~
12. ✅ ~~`*args` / `**kwargs` unpacking in calls~~
13. ✅ ~~`*` starred assignment~~
14. ✅ ~~Slice assignment~~
15. ✅ ~~Backslash line continuation~~
16. ✅ ~~Implicit string concatenation~~

## Operators

17. ✅ ~~Bitwise AND `&`~~
18. ✅ ~~Bitwise OR `|`~~
19. ✅ ~~Bitwise XOR `^`~~
20. ✅ ~~Bitwise NOT `~`~~
21. ✅ ~~Left shift `<<`~~
22. ✅ ~~Right shift `>>`~~
23. ✅ ~~`%` string formatting~~

## Missing builtins

24. ✅ ~~`chr()`~~
25. ✅ ~~`ord()`~~
26. ✅ ~~`hex()`~~
27. ✅ ~~`oct()`~~
28. ✅ ~~`bin()`~~
29. ✅ ~~`pow()`~~
30. ✅ ~~`divmod()`~~
31. **`hasattr()`** — not applicable without class support
32. **`getattr()`** — not applicable without class support
33. ✅ ~~`callable()`~~
34. ✅ ~~`iter()` / `next()`~~
35. ✅ ~~`id()`~~
36. ✅ ~~`hash()`~~
37. ✅ ~~`tuple()` constructor~~
38. **`input()`** — intentionally unsupported in sandbox

## Missing string methods

39. ✅ ~~`str.isupper()` / `str.islower()`~~
40. **`str.isnumeric()` / `str.isdecimal()` / `str.isidentifier()` / `str.isprintable()`** — ✅ `str.istitle()` added
41. ✅ ~~`str.partition()` / `str.rpartition()`~~
42. ✅ ~~`str.splitlines()`~~
43. ✅ ~~`str.expandtabs()`~~
44. ✅ ~~`str.removeprefix()` / `str.removesuffix()`~~
45. **`str.encode()`** — intentionally unsupported (no bytes type)
46. **`str.maketrans()` / `str.translate()`**

## Missing dict methods

47. ✅ ~~`dict.popitem()`~~
48. **`dict.fromkeys()`** — static method not supported

## Semantic / runtime bugs

49. ✅ ~~`print(sep=...)` ignored~~
50. ✅ ~~`print(end=...)` ignored~~
51. ✅ ~~`dict(a=1, b=2)` returns empty dict~~
52. ✅ ~~`enumerate(start=N)` keyword form ignored~~
53. ✅ ~~`isinstance()` only accepts type name as string~~
54. ✅ ~~`isinstance()` with tuple of types~~
55. ✅ ~~`int()` ignores base argument~~
56. ✅ ~~`round()` doesn't do banker's rounding~~
57. ✅ ~~`sorted()` can't compare tuples~~
58. ✅ ~~`list.sort(key=lambda: fn_call)` fails~~
59. **`except ... as e` — `e` is a string, not an exception object** — minor: type(e) returns `<class 'str'>`
60. ✅ ~~`str.format()` with keyword args~~
61. **Escape `\n` in single-line strings** — may be a test-harness issue with how source is passed
62. **Default mutable arguments not shared across calls** — intentional deviation; safer for sandboxed use
