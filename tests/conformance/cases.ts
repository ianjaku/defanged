/**
 * Conformance corpus: small Python programs whose printed output (and final
 * exception, if any) must match CPython's.
 *
 * Add a case here, then run `bun run conformance:record` to capture what
 * CPython does. Keep cases deterministic: no hash(), id(), or printing of
 * sets of strings (their order is randomized in CPython).
 */

export interface Case {
  name: string;
  code: string;
  /** Set to false to compare only the exception type, not its wording. */
  message?: false;
}

const py = String.raw;

function c(name: string, code: string, options: { message?: false } = {}): Case {
  return { name, code: code.replace(/^\n/, ''), ...options };
}

export const cases: Case[] = [
  // ── Numbers ───────────────────────────────────────────────────────────────
  c('int and float print differently', py`
print(1, 1.0, 6 / 2, 7 // 2, 7 // 2.0, 2 * 3.0, 10 / 4)
print(type(6 / 2).__name__, type(6 // 2).__name__, type(2 ** -1).__name__)
print([1.0, 2.5, 3], (1.0,), {1.0: 'x'})
print(float(5), int(5.9), int(-5.9), float('1e3'), 1e16, 1e15, 1e-5, 0.0001, -0.0)
`),
  c('float repr round-trips', py`
print(0.1 + 0.2, 1 / 3, 2 / 3, 1e100, 1.5e-7, 123456789.123456789)
print(float('inf'), float('-inf'), float('nan'), float('Infinity'))
print(3.0 == 3, 3.0 is 3.0, 0.1 + 0.2 == 0.3)
`),
  c('ints are arbitrary precision', py`
print(2 ** 100)
print(10 ** 18 + 1)
print(int('12345678901234567890') * 2)
print(2 ** 64 // 3, 2 ** 64 % 1000, -(2 ** 70))
print(9007199254740993 + 1, 9007199254740992 * 3)
print(1 << 70, (1 << 70) >> 68, 0xFFFFFFFFFF & 0xF0F0F0F0F0)
n = 1
for i in range(1, 26):
    n *= i
print(n)
`),
  c('integer division and modulo signs', py`
print(7 // 2, -7 // 2, 7 // -2, -7 // -2)
print(7 % 3, -7 % 3, 7 % -3, -7 % -3)
print(7.5 // 2, -7.5 // 2, 7.5 % 2, -7.5 % 2)
print(divmod(7, 2), divmod(-7, 2), divmod(7.5, 2))
`),
  c('power', py`
print(2 ** 10, 2 ** 0.5, 4 ** 0.5, 2 ** -2, (-2) ** 3, 0 ** 0, 10 ** -1)
print(pow(2, 10), pow(2, 10, 1000), pow(3, -1, 7))
print(-2 ** 2, 2 ** 3 ** 2)
`),
  c('bitwise operators', py`
print(5 & 3, 5 | 3, 5 ^ 3, ~5, 1 << 40, -8 >> 1, 255 >> 4)
print(True & False, True | False, True ^ True)
x = 12
x |= 3
x &= 10
x ^= 1
x <<= 2
x >>= 1
print(x)
`),
  c('bool is an int', py`
print(True + True, True * 5, sum([True, False, True]), True == 1, False == 0)
print(isinstance(True, int), isinstance(1, bool), type(True).__name__)
print(int(True), float(False), str(True), repr(None))
print({True: 'a', 1: 'b', 1.0: 'c'})
`),
  c('round uses bankers rounding', py`
print(round(2.5), round(3.5), round(-2.5), round(0.5), round(1.5))
print(round(2.675, 2), round(0.125, 2), round(1.005, 2), round(3.14159, 3))
print(round(1234, -2), round(1250, -2), round(1350, -2), round(5), round(5.0))
print(type(round(2.5)).__name__, type(round(2.5, 0)).__name__, round(2.5, 0))
`),
  c('number conversions', py`
print(int('42'), int(' 42 '), int('-7'), int('0x1f', 16), int('ff', 16), int('101', 2), int('1_000'))
print(float('3.14'), float(' 2 '), float('1e-3'), float('.5'))
print(str(3), str(3.0), str(-0.5), repr(1e21), repr(1.0e-7))
print(hex(255), oct(8), bin(5), hex(-255), bin(0))
print(abs(-3), abs(-3.5), abs(True), min(1, 2.0), max(1, 2.0), max(2, 2.0))
`),
  c('int() rejects bad literals', py`
try:
    int('3.14')
except ValueError as e:
    print(e)
try:
    int('abc')
except ValueError as e:
    print(e)
try:
    float('abc')
except ValueError as e:
    print(e)
int(None)
`),
  c('division by zero', py`
for expr in (lambda: 1 / 0, lambda: 1 // 0, lambda: 1 % 0, lambda: 1.0 / 0, lambda: divmod(1, 0)):
    try:
        expr()
    except ZeroDivisionError as e:
        print(type(e).__name__, e)
`),
  c('numeric literals', py`
print(0xff, 0o77, 0b1010, 1_000_000, 3.14_15, 1e3, 1E3, 1.5e-3, .5, 5., 0.0)
print(10 ** 20, 123456789012345678901234567890)
`),
  c('sum of floats is compensated', py`
print(sum([0.1] * 10), sum([0.1, 0.2, 0.3]), sum([1, 2, 3]), sum([1.5, 2]), sum([]), sum([1, 2], 10))
print(sum([[1], [2]], []), sum((x * x for x in range(4))))
`),

  c('big int division rounds once', py`
print(10 ** 25 / 10 ** 24, 10 ** 30 / 3, -(10 ** 30) / 7, 2 ** 70 / 2 ** 10, 1 / 10 ** 400, (10 ** 20 + 1) / 10 ** 20)
print(10 ** 30 // 7, 10 ** 30 % 7, -(10 ** 30) // 7, 10 ** 30 > 1e29, 10 ** 30 == 1e30, float(10 ** 30), int(1e30))
print(bin(10 ** 20), hex(2 ** 70), (2 ** 70).bit_length(), (0).bit_length(), ~(2 ** 70), 2 ** 70 | 1)
`),
  c('operator precedence', py`
print(not 1 == 2, 1 + 2 * 3 ** 2, -2 ** 2, 2 ** -1, 10 - 2 - 3, 2 ** 3 ** 2, 7 // 2 * 2, 1 if 0 else 2 if 0 else 3)
print(1 < 2 == True, 1 | 2 == 3, (1 | 2) == 3, 1 + 1 << 2, 5 & 3 | 8, not 1 or 1, 1 in [1] == True, "a" + "b" * 2)
print(-5 % 3, -(5 % 3), ~5 + 1, - - 5, + - 5, not not 0, 3 - -3, 2 * -3, 1 == 1.0 == True)
`),

  c('float floor division agrees with modulo', py`
print(1.0 // 0.1, 5 // 0.1, 6.0 // 0.2, divmod(1.0, 0.1), -1.0 // 0.1, 7.5 // 2, -7.5 // 2, 1.0 % 0.1, 0.0 // 1, -0.0 // 1, 3.0 % -2)
`),
  c('nan is found by identity', py`
x = float('nan')
print(x in [x], [x] == [x], x == x, [x].index(x), [x].count(x), {'k': x} == {'k': x}, (x,) == (x,))
`),
  c('repeating an empty sequence', py`
print([] * 10 ** 12, () * 10 ** 12, "" * 10 ** 12, [1] * 0, [] * -5, [0] * 3)
[] * 10 ** 30
`),

  c('rounding exact ties at every precision', py`
values = [0.5, 1.5, 2.5, -0.5, -2.5, 0.25, 0.75, 0.125, 0.375, 0.0625, 2.675, 1.005, 1e15 + 0.5, 4503599627370496.5, 0.1, 19.995]
for d in range(0, 5):
    print(d, [f"{v:.{d}f}" for v in values])
print([round(v, 1) for v in values], [round(v) for v in values[:9]])
print(f"{0.5:.0%}", f"{0.125:.1%}", f"{0.00125:.2%}", f"{2.5:,.0f}", f"{1234.5:,.0f}", f"{1235.5:,.0f}", "%.0f %.1f" % (0.5, 0.25))
`),
  c('float arithmetic keeps its type', py`
a, b = 1.5, 2
print(a + b, b + a, a - b, b - a, a * b, b * a, a / b, b / a, 7 / 2, 6 / 3, -7 / 2, a + True, a * 0, 0 * a, -a * 0)
total = 0
for v in [1, 2.5, 3]:
    total += v
print(total, type(total).__name__, 1e308 + 1e308, 1e308 * 10, 5 / 0.5, 2 ** 53 / 3)
try:
    1.5 / 0
except ZeroDivisionError as e:
    print("ZeroDivisionError", e)
try:
    2 / 0.0
except ZeroDivisionError as e:
    print("ZeroDivisionError", e)
`),

  // ── Strings ───────────────────────────────────────────────────────────────
  c('string repr picks quotes and escapes', py`
print(repr("it's"), repr('a"b'), repr("a'b\"c"), repr('a\nb\t\\'), repr(''), repr('\x00\x7f'))
print(["it's", 'x'], {'k': "v'"}, ("a\n",))
print(str(['a', 1, None, True, 2.0]))
`),
  c('escape sequences', py`
print("a\tb", "a\\b", 'it\'s', "\x41\u00e9", len("\n"), "\d+", len("\d"), "a\
b")
print(r"\d+\n", len(r"\n"), rf"{1 + 1}\d", "tab\there")
`),
  c('string methods', py`
s = "  Hello, World!  "
print(s.strip(), s.lstrip() + "|", s.rstrip() + "|", s.strip().lower(), s.strip().upper())
print("a,b,,c".split(","), "a b  c".split(), "a,b,c".split(",", 1), "a,b,c".rsplit(",", 1), "".split(), "".split(","))
print("hello".replace("l", "L"), "hello".replace("l", "L", 1), "abc".replace("", "-"))
print("hello".find("l"), "hello".rfind("l"), "hello".find("z"), "hello".index("e"), "hello".count("l"))
print("hello world".title(), "hello".capitalize(), "Hello".swapcase(), "they're".title())
print("hello".startswith("he"), "hello".endswith(("x", "lo")), "hello".startswith("l", 2))
print("-".join(["a", "b", "c"]), ", ".join(str(i) for i in range(3)), "".join([]))
print("42".zfill(5), "-42".zfill(5), "hi".ljust(5, "."), "hi".rjust(5), "hi".center(7, "*"), "hi".center(6, "*"))
`),
  c('whitespace split keeps the remainder verbatim', py`
print("  a  b ".split(None, 1), "a b ".split(None, 1), " a b c ".rsplit(None, 1), "a b c".split(None, 5), "a,b".split(",", -1))
print("  a  b  c ".split(maxsplit=1), "x".split(None, 0), "  x  ".split(None, 0), "a b".rsplit(maxsplit=0))
`),
  c('string predicates', py`
print("123".isdigit(), "12a".isdigit(), "".isdigit(), "abc".isalpha(), "ab1".isalnum(), " \t".isspace())
print("ABC".isupper(), "AbC".isupper(), "abc".islower(), "Hello World".istitle(), "x1".isidentifier(), "1x".isidentifier())
print("abc".isascii(), "\u00e9".isascii(), "\u00bd".isnumeric(), "5".isdecimal(), "\u00e9".isalpha())
`),
  c('string partition, splitlines, prefixes', py`
print("a=b=c".partition("="), "a=b=c".rpartition("="), "abc".partition("x"))
print("a\nb\r\nc".splitlines(), "a\nb\n".splitlines(True), "".splitlines())
print("prefix_name".removeprefix("prefix_"), "file.txt".removesuffix(".txt"), "a\tb".expandtabs(4))
print("abc".translate(str.maketrans("ab", "xy")), "abc".translate(str.maketrans({"a": None})))
`),
  c('string indexing and slicing', py`
s = "hello world"
print(s[0], s[-1], s[1:4], s[:5], s[6:], s[::2], s[::-1], s[-5:-1], s[20:], s[2:1])
print(len(s), "lo w" in s, "x" not in s, s * 2, "ab" + "cd", "a" < "b", "apple" < "banana", "Z" < "a")
print(list("abc"), sorted("hello"), max("hello"), min("hello"), "".join(reversed("abc")))
`),
  c('strings are sequences of code points', py`
s = "a\U0001F600b"
print(len(s), s[1] == "\U0001F600", len(s[::-1]), len(list(s)), s.find("b"), s.upper() == "A\U0001F600B", s[:2] == "a\U0001F600")
print(len("\u00e9"), ord("\U0001F600"), len(chr(128512)), ord("a"), chr(97), "\u00e9".upper() == "\u00c9")
`),
  c('string index out of range', py`
"abc"[5]
`),
  c('str and number do not concatenate', py`
try:
    "total: " + 5
except TypeError as e:
    print(e)
try:
    5 + "5"
except TypeError as e:
    print(e)
print("ab" * 3, 3 * "ab", "ab" * 0, "ab" * -1)
"a" * "b"
`),

  // ── Formatting ────────────────────────────────────────────────────────────
  c('f-string basics', py`
name, n, x = "Ada", 42, 3.14159
print(f"{name} is {n}", f"{n + 1}", f"{x:.2f}", f"{n:5d}|", f"{n:<5}|", f"{n:^5}|", f"{n:05d}", f"{name!r}", f"{name:>6}")
print(f"{{literal}} {n}", f"{'nested'} {"quotes"}", f"{n=}", f"{x = :.1f}", f"{n:x} {n:#x} {n:b} {n:o} {n:e}")
print(f"{[i for i in range(3)]}", f"{ {'a': 1}['a'] }", f"{n if n > 40 else 0}", f"{name.upper()[:2]}")
`),
  c('f-string number formatting', py`
total = 1234567.891
print(f"{total:,}", f"{total:,.2f}", f"{1234567:,}", f"{total:_.1f}", f"{1234567:_}")
print(f"{0.256:.1%}", f"{0.5:.0%}", f"{1:.2%}", f"{12:+d}", f"{-12:+d}", f"{12: d}", f"{3.0:+.1f}")
print(f"{1e6:.2e}", f"{123456789:.3e}", f"{0.000012345:.2E}", f"{1234.5:g}", f"{0.00001234:g}", f"{1e20:g}", f"{100.0:g}")
print(f"{2.5:.0f}", f"{3.5:.0f}", f"{0.125:.2f}", f"{1e21:.1f}", f"{2.675:.2f}", f"{-0.0:.1f}")
print(f"{5:>8.2f}|", f"{5:<8.2f}|", f"{5:^8.2f}|", f"{5:08.2f}|", f"{-5:08.2f}|", f"{5:*>8}|", f"{'x':-^9}|")
print(f"{3.0}", f"{3.0:.3}", f"{1234.5678:.3}", f"{1.0:10}|", f"{True}", f"{True:>6}", f"{None}")
`),
  c('f-string nested format spec', py`
width, prec = 10, 3
print(f"{3.14159:{width}.{prec}f}|", f"{'x':>{width}}|", f"{42:{'0'}{5}}")
for name, value in [("apples", 3), ("kiwis", 12)]:
    print(f"{name:<10}{value:>5}")
`),
  c('format builtin and str.format', py`
print(format(1234.5, ",.2f"), format(42, "08b"), format("x", ">4"), format(0.5, "%"), format(255, "X"))
print("{} {}".format(1, 2), "{0} {1} {0}".format("a", "b"), "{name} is {age}".format(name="Ada", age=36))
print("{:>5}|{:,.2f}|{:.1%}".format("a", 1234.5, 0.25), "{:05.1f}".format(2.345), "{!r}".format("s"))
print("{0[0]} {1[k]}".format([1, 2], {"k": "v"}), "{:{w}}|".format("x", w=4), "{{}}".format())
`),
  c('str.format numbers a field before its nested spec', py`
print("{:>{}}|".format('x', 5), "{:>{}}|{:{}{}}|".format('x', 5, 3.14159, '.', 2), "{0:>{1}}|".format('x', 4))
`),
  c('percent formatting', py`
print("%s is %d" % ("age", 25), "%5.2f|" % 3.14159, "%-5d|" % 3, "%05d" % 42, "%x %o %e" % (255, 8, 1234.5))
print("%s" % "only", "%r" % "q", "%d%%" % 50, "%(a)s-%(b)d" % {"a": "x", "b": 2}, "%+d" % 5, "%.3s" % "abcdef")
print("%05.1f|%s|%d" % (3.14159, [1, 2], 7.9), "%10s|" % "hi", "%c" % 65)
`),
  c('percent formatting argument errors', py`
try:
    "%d" % "a"
except TypeError as e:
    print(e)
try:
    "%s %s" % ("a",)
except TypeError as e:
    print(e)
"%s" % ("a", "b")
`),
  c('unknown format code', py`
f"{'text':d}"
`),

  // ── Lists, tuples ─────────────────────────────────────────────────────────
  c('list operations', py`
a = [3, 1, 2]
a.append(4)
a.extend([5, 6])
a.insert(0, 0)
print(a, a.pop(), a.pop(0), a, a.index(2), a.count(3), len(a))
a.remove(3)
a.reverse()
print(a, sorted(a), sorted(a, reverse=True), a[::-1], a[1:3], a + [9], a * 2, [0] * 3)
a.sort()
print(a, 2 in a, 7 not in a, min(a), max(a), sum(a), a == [1, 2, 4, 5], a.copy() is a)
b = a
b += [10]
print(a, b is a)
`),
  c('list slicing and slice assignment', py`
a = list(range(10))
print(a[2:5], a[:3], a[-3:], a[::3], a[::-2], a[5:2], a[8:20], a[-20:2], a[5:2:-1])
a[2:5] = ['x', 'y']
print(a)
a[::2] = [0, 0, 0, 0, 0]
print(a)
del a[1:3]
del a[0]
print(a)
a[len(a):] = [1, 2]
print(a)
`),
  c('nested lists alias', py`
grid = [[0] * 2] * 2
grid[0][0] = 1
print(grid)
grid = [[0] * 2 for _ in range(2)]
grid[0][0] = 1
print(grid)
a = [1, [2, 3]]
b = a.copy()
b[1].append(4)
b.append(5)
print(a, b)
c = []
c.append(c)
print(c)
`),
  c('sorting is stable and takes keys', py`
rows = [("b", 2), ("a", 2), ("c", 1), ("d", 3)]
print(sorted(rows, key=lambda r: r[1]))
print(sorted(rows, key=lambda r: r[1], reverse=True))
print(sorted(rows), sorted(rows, key=lambda r: (-r[1], r[0])))
words = ["banana", "Apple", "cherry"]
print(sorted(words), sorted(words, key=str.lower), sorted(words, key=len), max(words, key=len), min(words, key=str.lower))
rows.sort(key=lambda r: r[0], reverse=True)
print(rows)
print(sorted([3, 1.5, 2, True]), sorted({"b": 1, "a": 2}), sorted("bca"))
`),
  c('sorting mixed types fails', py`
sorted([1, "a", 2])
`),
  c('tuples', py`
t = (1, 2, 3)
print(t, t[0], t[-1], t[1:], len(t), t + (4,), t * 2, (1,), (), tuple([1, 2]), tuple("ab"))
print((1, 2) < (1, 3), (1,) < (1, 2), (1, 2) == (1, 2), (1, 2) == [1, 2], t.index(2), t.count(1))
a, b = 1, 2
a, b = b, a
(x, y), z = (1, 2), 3
first, *rest = [1, 2, 3, 4]
*init, last = "abc"
h, *m, l = range(5)
print(a, b, x, y, z, first, rest, init, last, h, m, l)
print(divmod(7, 2), list(zip([1, 2], "ab")), list(enumerate("ab", 1)), list({"a": 1}.items()))
`),
  c('tuple is immutable', py`
t = (1, 2)
t[0] = 5
`),
  c('unpacking errors', py`
try:
    a, b = [1, 2, 3]
except ValueError as e:
    print(e)
try:
    a, b = [1]
except ValueError as e:
    print(e)
try:
    a, *b, c = [1]
except ValueError as e:
    print(e)
a, b = 5
`),
  c('star expressions in literals and calls', py`
a, b = [1, 2], (3, 4)
print([*a, *b], (*a, 0), {*a, *b}, [*range(3), *"ab"], {**{"x": 1}, "y": 2, **{"x": 3}})
def f(*args, **kwargs):
    return args, kwargs
print(f(*a, *b), f(*a, k=1, **{"z": 2}), f(0, *a), f(*a, 0))
print(*a, *b, sep="-")
`),

  // ── Dicts and sets ────────────────────────────────────────────────────────
  c('dict operations', py`
d = {"b": 1, "a": 2}
d["c"] = 3
d.update({"a": 20}, z=0)
print(d, len(d), "a" in d, "x" in d, d["a"], d.get("x"), d.get("x", -1), d.setdefault("n", []), d.pop("n"))
print(list(d), list(d.keys()), list(d.values()), list(d.items()), d.keys(), d.values(), d.items())
del d["z"]
print(d.pop("zz", None), d.popitem(), d, dict(a=1, b=2), dict([("x", 1)]), dict(zip("ab", [1, 2])), dict.fromkeys("ab", 0))
print({1: "a", 1.0: "b", True: "c"}, {(1, 2): "t", None: "n"}[(1, 2)], {} == {}, {"a": 1} == {"a": 1.0})
print({"a": 1} | {"b": 2}, {k: v * 2 for k, v in d.items()}, {v: k for k, v in d.items()})
`),
  c('dict iteration and views', py`
d = {"x": 1, "y": 2, "z": 3}
for k in d:
    print(k, d[k])
for k, v in d.items():
    print(f"{k}={v}")
print(sorted(d.items(), key=lambda kv: -kv[1]), max(d, key=d.get), sum(d.values()), len(d.items()))
print("x" in d.keys(), 2 in d.values(), ("x", 1) in d.items(), d.keys() & {"x", "q"}, sorted(d.keys() - {"x"}))
keys = d.keys()
d["w"] = 0
print(list(keys))
`),
  c('missing key raises KeyError', py`
d = {"a": 1}
try:
    d["b"]
except KeyError as e:
    print(repr(e), str(e), e.args)
d[("x", 1)]
`),
  c('unhashable keys', py`
try:
    {[1, 2]: 1}
except TypeError as e:
    print("TypeError")
try:
    {1, [2]}
except TypeError as e:
    print("TypeError")
d = {}
d[{}] = 1
`, { message: false }),
  c('changing a dict while iterating it fails', py`
d = {"a": 1, "b": 2}
for k in d:
    d[k + "x"] = 0
`),
  c('tuple keys that look alike stay distinct', py`
d = {}
keys = [("a", "b"), ("a,b",), ("a", "b", ""), ("ab",), (1, "1"), ("1", 1), (1,), ("#1",), ("s1",), (1.5,), ("1.5",),
        ((1, 2), 3), (1, (2, 3)), (1, 2, 3), ("2:ab",), ("", ""), ("",), (), (None,), ("None",), (True, 0), ('a"b',), ("a\\", "b")]
for i, k in enumerate(keys):
    d[k] = i
print(len(d), len(keys), d[(1.0, "1")], d[(True, 0)], d[(1, 0)], (2, "x") in d, ((1, 2), 3) in d)
print([d[k] for k in keys])
s = {(1, "a"), (1.0, "a"), ("1", "a")}
print(len(s), {(1, 2): "t"}.get((1, 2.0)))
`),
  c('grouping and counting idioms', py`
rows = [
    {"month": "2026-01", "org": "a", "amount": 10.5},
    {"month": "2026-01", "org": "b", "amount": 4},
    {"month": "2026-02", "org": "a", "amount": 7.25},
    {"month": "2026-01", "org": "a", "amount": 1},
]
totals = {}
counts = {}
for r in rows:
    key = (r["month"], r["org"])
    totals[key] = totals.get(key, 0) + r["amount"]
    counts[r["org"]] = counts.get(r["org"], 0) + 1
    totals.setdefault("all", 0)
print(totals)
print(counts, sorted(totals.items(), key=lambda kv: str(kv[0])))
by_month = {}
for r in rows:
    by_month.setdefault(r["month"], []).append(r["amount"])
print({m: (sum(v), len(v), round(sum(v) / len(v), 2)) for m, v in by_month.items()})
print(f"{'Month':<10}{'Total':>10}")
for m, v in sorted(by_month.items()):
    print(f"{m:<10}{sum(v):>10,.2f}")
`),
  c('set operations', py`
a, b = {1, 2, 3}, {2, 3, 4}
print(a | b, a & b, a - b, a ^ b, a <= b, {1} < a, a == {3, 2, 1}, len(a), 2 in a, set(), set([1, 1, 2]))
a.add(9)
a.discard(42)
a.remove(1)
print(sorted(a), sorted(a.union([7], (8,))), a.intersection(b), a.difference(b), a.issubset({2, 3, 9, 0}), a.isdisjoint({5}))
print(sorted({x % 3 for x in range(10)}), sorted(set("hello")), len({(1, 2), (1, 2), (2, 1)}))
a |= {100}
a &= {2, 100, 5}
print(sorted(a), {1, 1.0, True})
`),
  c('removing a missing set member', py`
{1, 2}.remove(3)
`),

  // ── Control flow ──────────────────────────────────────────────────────────
  c('conditionals and truthiness', py`
print("".join("T" if v else "F" for v in [0, 1, "", "a", [], [0], {}, {"a": 1}, None, 0.0, 0.1, (), (0,), set(), range(0), range(1)]))
x = 5
print(1 < x < 10, 1 < x > 3, 10 > x > 6, x == 5 != 4, None is None, [] is [], [] == [], not None, not 1)
print(0 or "default", "" or [] or None, 1 and 2, 0 and 1, None or 0, "a" and "b" or "c")
if x > 3: print("inline suite")
if x > 10: print("no")
elif x > 4: print("elif"); print("second statement")
else: print("no")
`),
  c('loops with break, continue and else', py`
for i in range(5):
    if i == 1:
        continue
    if i == 3:
        break
    print(i)
else:
    print("not reached")
for i in range(2):
    pass
else:
    print("for-else ran", i)
n = 0
while n < 3:
    n += 1
else:
    print("while-else ran", n)
while True:
    n -= 1
    if n == 0:
        break
print(n, list(range(5, 0, -2)), list(range(0)), range(3), list(range(2, 8, 3)), len(range(10 ** 9)))
for i, (a, b) in enumerate([(1, 2), (3, 4)]):
    print(i, a, b)
`),
  c('nested loops and comprehensions', py`
print([(i, j) for i in range(3) for j in range(i)], [x for x in range(10) if x % 2 if x > 3])
print([[i * j for j in range(3)] for i in range(3)], {i: [j for j in range(i)] for i in range(3)})
print(sum(x * x for x in range(5)), any(x > 3 for x in [1, 5]), all(x > 3 for x in [1, 5]), list(x for x in "ab"))
print(next((x for x in [1, 2, 3] if x > 1), None), next((x for x in [] if x), "none"), max(len(w) for w in ["a", "abc"]))
x = "outer"
print([x for x in range(2)], x, [y := 5, y + 1], y)
total = 0
print([total := total + v for v in [1, 2, 3]], total)
`),
  c('walrus and ternary', py`
data = [1, 5, 8]
if (n := len(data)) > 2:
    print("long", n)
print("big" if max(data) > 7 else "small", [("e" if v % 2 == 0 else "o") for v in data])
while (chunk := data.pop()) > 1:
    print(chunk)
print(data)
`),

  c('statements on one line and multi-line expressions', py`
a = 1; b = 2; c = a + b
print(a, b, c); print("same line")
if a: x = 1; y = 2
print(x, y)
for i in range(2): print(i)
while a < 3: a += 1
def one(): return 1
try: 1 / 0
except ZeroDivisionError: print("zde")
finally: print("fin")
total = (
    a +
    one()  # comment inside parentheses
)
items = [
    1,
    2,
]
long = 1 + \
    2
print(total, items, long, one(
    ))
`),
  c('finally runs on every way out of a loop body', py`
def f():
    for i in range(3):
        try:
            return i
        finally:
            print("finally", i)
print(f())
i = 0
while i < 5:
    i += 1
    try:
        if i == 2:
            continue
        if i == 4:
            break
        print("body", i)
    finally:
        print("finally", i)
print("after", i)
def gen():
    try:
        yield 1
        yield 2
    finally:
        print("gen cleanup")
for v in gen():
    print(v)
`),

  // ── Functions ─────────────────────────────────────────────────────────────
  c('function arguments', py`
def f(a, b=2, *args, c, d=4, **kwargs):
    return a, b, args, c, d, kwargs
print(f(1, c=3), f(1, 2, 3, 4, c=5, e=6), f(a=1, c=2), f(1, d=0, c=9, **{"z": 1}))
def g(a, /, b, *, c):
    return a + b + c
print(g(1, 2, c=3), g(1, b=2, c=3))
def h(x: int, y: str = "a", *rest: int, flag: bool = False, **more) -> str:
    return y * x
print(h(2), h(3, "b"), h.__name__, (lambda x, y=2, *a, **k: (x, y, a, k))(1, z=3))
count: int = 0
label: str
print(count)
`),
  c('function call errors', py`
def f(a, b):
    return a + b
for call in (lambda: f(1), lambda: f(1, 2, 3), lambda: f(1, c=2), lambda: f(1, 2, b=3), lambda: f()):
    try:
        call()
    except TypeError as e:
        print(e)
def k(*, key):
    return key
try:
    k()
except TypeError as e:
    print(e)
try:
    k(1)
except TypeError as e:
    print(e)
len(1, 2)
`, { message: false }),
  c('closures and scopes', py`
def counter():
    count = 0
    def inc(step=1):
        nonlocal count
        count += step
        return count
    return inc
c1, c2 = counter(), counter()
print(c1(), c1(5), c2())
total = 0
def add(n):
    global total
    total += n
add(3); add(4)
print(total)
fns = [lambda: i for i in range(3)]
print([f() for f in fns], [(lambda i=i: i)() for i in range(3)])
def outer():
    x = "outer"
    def inner():
        return x
    x = "rebound"
    return inner()
print(outer())
def make_adders():
    return [lambda x, n=n: x + n for n in range(3)]
print([a(10) for a in make_adders()])
`),
  c('reading a local before assignment', py`
x = 1
def f():
    print(x)
    x = 2
f()
`),
  c('recursion and decorators', py`
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
def memo(fn):
    cache = {}
    def wrapper(n):
        if n not in cache:
            cache[n] = fn(n)
        return cache[n]
    return wrapper
@memo
def fast_fib(n):
    return n if n < 2 else fast_fib(n - 1) + fast_fib(n - 2)
def twice(fn):
    return lambda *a: fn(fn(*a))
@twice
@twice
def inc(x):
    return x + 1
print(fib(15), fast_fib(80), inc(0))
def flatten(xs):
    out = []
    for x in xs:
        out.extend(flatten(x) if isinstance(x, list) else [x])
    return out
print(flatten([1, [2, [3, [4]], 5]]))
`),
  c('infinite recursion is a RecursionError', py`
def f(n):
    return f(n + 1)
try:
    f(0)
except RecursionError as e:
    print("caught", type(e).__name__, isinstance(e, RuntimeError))
f(0)
`, { message: false }),
  c('higher-order builtins are lazy iterators', py`
m = map(str, [1, 2])
print(type(m).__name__, list(m), list(m), type(zip()).__name__, type(enumerate([])).__name__, type(filter(None, [])).__name__)
print(list(map(lambda a, b: a + b, [1, 2], [10, 20])), list(filter(None, [0, 1, "", "a"])), list(filter(lambda x: x > 1, [1, 2, 3])))
print(list(zip([1, 2, 3], "ab")), dict(zip("ab", [1, 2])), list(zip(*[(1, "a"), (2, "b")])), list(reversed([1, 2])), list(enumerate(["a"], start=5)))
it = iter([1, 2, 3])
print(next(it), next(it), list(it), next(it, "done"), sorted(map(abs, [-3, 1])), sum(map(int, "123")))
e = enumerate("ab")
print(next(e), list(e))
`),

  c('keyword arguments of built-in types and functions', py`
print(int('10', base=2), int('ff', base=16), round(number=2.567, ndigits=1), pow(2, 3, mod=5))
for f in (lambda: float(x=5), lambda: list(x=[1]), lambda: ValueError('a', code=5), lambda: int('_1'),
          lambda: 'a'.upper(1), lambda: {}.keys(1), lambda: 'abc'.strip('a', 'b')):
    try:
        f()
        print("no error")
    except (TypeError, ValueError) as e:
        print(type(e).__name__)
def f(**kw):
    return kw
try:
    f(a=1, **{'a': 2})
except TypeError:
    print("duplicate keyword")
`, { message: false }),
  c('finally with break while a return is leaving an inner loop', py`
def f():
    out = []
    for a in [1, 2]:
        try:
            for b in [10, 20]:
                return 'ret'
        finally:
            break
    for c in [7, 8]:
        try: raise ValueError
        except ValueError: out.append(c)
    return out
print(f())
def g():
    for a in [1, 2]:
        for b in [3, 4]:
            try:
                return (a, b)
            finally:
                print("cleanup", a, b)
print(g())
`),
  c('slice assignment from itself and from a large list', py`
a = [1, 2, 3]
a[::-1] = a
print(a)
a = [1, 2, 3]
a[1:1] = a
print(a)
a[0:0] = list(range(300000))
print(len(a))
`),

  // ── Generators ────────────────────────────────────────────────────────────
  c('generators', py`
def count_up(n):
    i = 0
    while i < n:
        yield i
        i += 1
def chain(*its):
    for it in its:
        yield from it
def fib():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b
g = count_up(3)
print(next(g), list(g), list(g), list(chain([1], (2,), "ab", count_up(2))), type(g).__name__)
f = fib()
print([next(f) for _ in range(10)], sum(count_up(5)), max(count_up(5)), sorted(count_up(3), reverse=True))
def pairs():
    yield 1, 2
    yield 3, 4
for a, b in pairs():
    print(a, b)
lazy = (print("evaluated", x) or x for x in [1, 2])
print("before")
print(next(lazy))
`),
  c('generator send and return value', py`
def acc():
    total = 0
    while True:
        value = yield total
        if value is None:
            return total
        total += value
g = acc()
print(next(g), g.send(5), g.send(10))
def inner():
    yield 1
    return "inner result"
def outer():
    result = yield from inner()
    yield result
print(list(outer()))
def done():
    return 5
    yield
try:
    next(done())
except StopIteration as e:
    print("stopped", e.args)
next(iter([]))
`),

  // ── Exceptions ────────────────────────────────────────────────────────────
  c('exceptions are objects', py`
try:
    raise ValueError("bad value", 42)
except ValueError as e:
    print(type(e).__name__, e, repr(e), e.args, str(e), isinstance(e, Exception), type(e) is ValueError)
try:
    raise KeyError("k")
except LookupError as e:
    print(repr(e), str(e), f"{type(e).__name__}: {e}")
try:
    [][1]
except (KeyError, IndexError) as e:
    print("Error: " + str(e), f"{e}", "%s" % e, [e], isinstance(e, LookupError))
try:
    raise TypeError
except TypeError as e:
    print(repr(e), repr(str(e)), e.args)
print(ValueError("x") , repr(Exception()), str(Exception("a", "b")), issubclass(KeyError, Exception))
`),
  c('the exception name is unbound after its handler', py`
try:
    raise ValueError("x")
except ValueError as e:
    kept = e
try:
    print(e)
except NameError:
    print("e is unbound after the handler")
print(kept)
def gen():
    yield 1
    return "done"
g = gen()
next(g)
try:
    next(g)
except StopIteration as stop:
    print(stop.value)
`),
  c('try, except, else, finally ordering', py`
def run(kind):
    log = []
    try:
        log.append("try")
        if kind == "value":
            raise ValueError("v")
        if kind == "key":
            return log + ["returned"]
    except ValueError as e:
        log.append(f"except {e}")
    else:
        log.append("else")
    finally:
        log.append("finally")
    return log
print(run("none"), run("value"), run("key"))
def nested():
    for i in range(3):
        try:
            if i == 0:
                continue
            if i == 1:
                break
        finally:
            print("cleanup", i)
    return "done"
print(nested())
def reraise():
    try:
        try:
            1 / 0
        except ZeroDivisionError:
            print("inner")
            raise
        finally:
            print("inner finally")
    except Exception as e:
        return type(e).__name__
print(reraise())
def swallow():
    try:
        raise ValueError("lost")
    finally:
        return "finally wins"
print(swallow())
`),
  c('exception hierarchy', py`
def kind(fn):
    try:
        fn()
    except ArithmeticError as e:
        return "arithmetic:" + type(e).__name__
    except LookupError as e:
        return "lookup:" + type(e).__name__
    except (TypeError, ValueError) as e:
        return "type-or-value:" + type(e).__name__
    except Exception as e:
        return "other:" + type(e).__name__
print(kind(lambda: 1 / 0), kind(lambda: [][0]), kind(lambda: {}["x"]), kind(lambda: int("x")), kind(lambda: len(1)), kind(lambda: undefined_name), kind(lambda: None.x), kind(lambda: 2.0 ** 10000))
try:
    raise ValueError("first")
except ValueError as e:
    try:
        raise RuntimeError("second") from e
    except RuntimeError as e2:
        print(e2, e)
assert 1 + 1 == 2
try:
    assert False, "with message"
except AssertionError as e:
    print("assert:", e)
assert [] , "empty"
`),
  c('uncaught custom raise', py`
def validate(n):
    if n < 0:
        raise ValueError(f"negative: {n}")
    return n
print(validate(1))
validate(-5)
`),
  c('attribute and name errors', py`
for fn in (lambda: "s".nope, lambda: [].add(1), lambda: (1).real_nope, lambda: None.x, lambda: {}.key):
    try:
        fn()
    except AttributeError as e:
        print(e)
try:
    nope
except NameError as e:
    print(e)
import math
math.nope
`),
  c('type errors on operators', py`
for fn in (lambda: 1 + "a", lambda: [1] + (2,), lambda: None < 1, lambda: [1] < "a", lambda: -"a", lambda: len(5), lambda: 5(), lambda: 5[0], lambda: "a" - 1):
    try:
        fn()
    except TypeError as e:
        print(e)
for x in 5:
    pass
`),

  // ── Builtins ──────────────────────────────────────────────────────────────
  c('type and isinstance', py`
print(type(1), type(1.5), type("s"), type(None), type([]), type({}), type(()), type(set()), type(True), type(range(1)))
print(type(1) == int, type("a") is str, type([]) == list, type(1.0).__name__, type(len).__name__, type(lambda: 0).__name__)
print(isinstance(1, int), isinstance(1.0, (int, float)), isinstance("a", str), isinstance([], (tuple, dict)), isinstance(None, type(None)))
print(int, str, float, list, dict, callable(len), callable(1), callable(int), str(3) + "x", list((1, 2)), bool([]), bool("0"))
`),
  c('min, max, any, all with options', py`
print(min([3, 1, 2]), max(3, 1, 2), min("b", "a"), min([], default=0), max([], default=None), max([1, 5, 3], key=lambda x: -x))
print(min([(2, "b"), (1, "z")]), max({"a": 3, "b": 1}.items(), key=lambda kv: kv[1]), any([]), all([]), any([0, ""]), all([1, "a"]))
max([])
`),
  c('enumerate, zip and range details', py`
print(list(enumerate("abc")), list(zip()), list(zip("ab")), list(range(3))[::-1], range(1, 10, 3)[1], range(5)[-1], 3 in range(5), list(range(5)[1:3]))
print(len(range(0, 10, 3)), range(3) == range(0, 3), list(range(-3, 0)), sum(range(101)), tuple(range(3)), [*range(2)])
range(1, 2, 0)
`),
  c('print formatting', py`
print("a", 1, None, True, 2.5, [1, "b"], sep="|")
print()
print("no args above", (1,), {"k": (1, 2.0)}, {1, 2}, range(2))
print(1.0, -1.5e-10, 1e22, 12345678901234567890, 0.1 + 0.7, 1 / 3 * 3)
`),
  c('getattr, hasattr and __name__', py`
print(getattr("abc", "upper")(), getattr("abc", "nope", "default"), hasattr([], "append"), hasattr([], "nope"))
if __name__ == "__main__":
    print("main guard runs")
`),

  // ── Modules ───────────────────────────────────────────────────────────────
  c('math module', py`
import math
from math import sqrt, floor as fl
print(math.sqrt(16), sqrt(2), math.floor(3.7), fl(-3.2), math.ceil(3.2), math.trunc(-3.7), math.floor(5), math.pi, math.e)
print(math.pow(2, 3), math.fabs(-2), math.log(math.e), math.log(8, 2), math.log10(1000), math.log2(8), math.exp(0))
print(math.isnan(math.nan), math.isinf(math.inf), math.isclose(0.1 + 0.2, 0.3), math.inf > 10 ** 100, -math.inf, math.nan == math.nan)
print(round(math.sin(math.pi / 2), 6), round(math.degrees(math.pi), 6), math.radians(180) == math.pi, type(math.floor(2.5)).__name__)
`),
  c('statistics module', py`
import statistics as st
data = [2, 4, 4, 4, 5, 5, 7, 9]
print(st.mean(data), st.median(data), st.mode(data), st.pstdev(data), st.pvariance(data), round(st.stdev(data), 6), st.variance(data))
print(st.mean([1, 2, 3]), st.mean([1, 2, 3, 4]), st.mean([1.0, 2, 3]), st.median([1, 3]), st.median([3, 1, 2]), st.median([1.5, 2.5]))
print(st.mean([19.99, 5.49, 3.5]), st.mean([1e20, 1, -1e20]), st.mean([0.1, 0.2, 0.3]), st.mean([0.1] * 10), st.mean([5e-324, 5e-324]))
print(st.quantiles([1, 2, 3, 4, 5]), st.quantiles(range(1, 12), n=4, method="inclusive"), st.mode(["a", "b", "a"]), st.mean(x for x in [1, 2]))
try:
    st.mean([])
except st.StatisticsError as e:
    print(type(e).__name__, e, isinstance(e, ValueError))
`),
  c('re module', py`
import re
text = "Order 12 shipped on 2026-01-05, order 7 on 2026-02-11."
print(re.findall(r"\d{4}-\d{2}-\d{2}", text), re.findall(r"(\w+) (\d+)", text), re.search(r"order (\d+)", text).group(1))
m = re.search(r"(?P<y>\d{4})-(?P<m>\d{2})", text)
print(m.group(0), m.group("y"), m.groups(), m.groupdict(), m.start(), m.end(), m.span(1), m[0], m["m"])
print(re.sub(r"\d+", "#", "a1b22"), re.sub(r"(\w)(\d)", r"\2\1", "a1 b2"), re.sub(r"\d", lambda m: str(int(m.group()) * 2), "a1b5"), re.subn("a", "b", "aaa", count=2))
print(re.split(r"[,;]\s*", "a, b;c"), re.split(r"(-)", "a-b"), re.match(r"\d", "a1"), bool(re.fullmatch(r"\w+", "abc")), re.escape("a.b*c"))
p = re.compile(r"(\d+)\s*(kg|g)", re.IGNORECASE)
print(p.findall("5 KG and 20g"), [m.group(2) for m in p.finditer("5 kg, 3 g")], p.pattern, p.sub("?", "1kg"))
print(re.sub(r"(a)(b)?", r"\1[\2]", "ab a"))
print(re.findall("\d+", "non-raw 12 pattern 345"), re.search("x", "abc") is None, re.findall(r"^\w+", "ab cd\nef", re.M))
`),
  c('datetime module', py`
from datetime import datetime, date, timedelta
import datetime as dt
d = date(2026, 3, 15)
t = datetime(2026, 3, 15, 14, 30, 5)
print(d, t, repr(d), repr(t), d.year, t.hour, d.weekday(), d.isoformat(), t.isoformat(), t.date(), str(timedelta(days=1, hours=2)))
print(d + timedelta(days=20), t - timedelta(hours=15), date(2026, 3, 1) - date(2026, 1, 1), (t - datetime(2026, 1, 1)).days, timedelta(hours=36).total_seconds())
print(d.strftime("%Y-%m-%d %A %B %j"), t.strftime("%d/%m/%y %I:%M %p"), f"{t:%Y-%m}", f"{d:%b %d}", datetime.strptime("2026-02-03 04:05", "%Y-%m-%d %H:%M"))
print(date.fromisoformat("2026-12-31"), datetime.fromisoformat("2026-12-31T23:59:59"), d < date(2026, 4, 1), sorted([date(2026, 2, 1), date(2026, 1, 1)]), d.replace(day=1))
print(type(d).__name__, isinstance(t, date), isinstance(d, datetime), dt.date(2026, 1, 31) + dt.timedelta(days=1), timedelta(minutes=90), -timedelta(days=1), timedelta(days=1) * 2.5)
print({date(2026, 1, 1): "new year"}[date(2026, 1, 1)], max(date(2026, 1, 1), date(2026, 6, 1)), timedelta(hours=1) < timedelta(days=1), timedelta(days=7) / timedelta(days=2))
date(2026, 2, 30)
`),
  c('importing an unknown module', py`
try:
    import not_a_real_module
except ImportError as e:
    print(type(e).__name__, e)
from math import nope
`, { message: false }),

  // ── Whole programs ────────────────────────────────────────────────────────
  c('report script', py`
from datetime import date

orders = [
    {"id": 1, "customer": "Acme", "total": 1250.0, "date": "2026-01-15", "status": "paid"},
    {"id": 2, "customer": "Globex", "total": 89.99, "date": "2026-01-20", "status": "open"},
    {"id": 3, "customer": "Acme", "total": 430.5, "date": "2026-02-02", "status": "paid"},
    {"id": 4, "customer": "Initech", "total": None, "date": "2026-02-10", "status": "void"},
]

def parse(row):
    return {**row, "date": date.fromisoformat(row["date"]), "total": row["total"] or 0}

rows = [parse(r) for r in orders]
paid = [r for r in rows if r["status"] == "paid"]
by_customer = {}
for r in rows:
    by_customer[r["customer"]] = by_customer.get(r["customer"], 0) + r["total"]

print(f"Orders: {len(rows)}, paid: {len(paid)} ({len(paid) / len(rows):.0%})")
print(f"Revenue: {sum(r['total'] for r in paid):,.2f}")
for name, total in sorted(by_customer.items(), key=lambda kv: kv[1], reverse=True):
    print(f"  {name:<10} {total:>10,.2f}")
latest = max(rows, key=lambda r: r["date"])
print("Latest:", latest["id"], latest["date"].strftime("%d %b %Y"), (latest["date"] - rows[0]["date"]).days, "days after first")
months = sorted({r["date"].strftime("%Y-%m") for r in rows})
print(months, [r["id"] for r in rows if r["date"].month == 2], any(r["total"] > 1000 for r in rows))
`),
  c('text processing script', py`
text = """The quick brown fox.
It jumps over the lazy dog!
The dog sleeps."""
words = [w.strip(".,!").lower() for w in text.split()]
freq = {}
for w in words:
    freq[w] = freq.get(w, 0) + 1
top = sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
print(top, len(words), len(set(words)))
lines = text.splitlines()
print([len(line) for line in lines], max(lines, key=len), [line.split()[0] for line in lines])
print(" ".join(w.capitalize() for w in words[:4]), "|".join(sorted(sorted(set(words)), key=len, reverse=True)[:2]))
initials = "".join(w[0].upper() for w in words if w[0] in "tqb")
print(initials, text.count("The"), text.find("dog"), text.replace("\n", " / ")[:40] + "...")
`),
  c('matrix and numeric script', py`
def transpose(m):
    return [list(row) for row in zip(*m)]
def matmul(a, b):
    return [[sum(x * y for x, y in zip(row, col)) for col in zip(*b)] for row in a]
m = [[1, 2], [3, 4], [5, 6]]
print(transpose(m), matmul(m, transpose(m)), [sum(row) for row in m], sum(sum(row) for row in m))
primes = [n for n in range(2, 40) if all(n % d for d in range(2, int(n ** 0.5) + 1))]
print(primes, sum(primes) / len(primes), max(primes) - min(primes))
def gcd(a, b):
    while b:
        a, b = b, a % b
    return a
print(gcd(1071, 462), [gcd(12, n) for n in range(1, 7)], 17 % 5, -17 % 5, 2 ** 31 - 1, 7 / 2, 7 // 2)
prices = [19.99, 5.01, 100, 0.1]
print(sum(prices), round(sum(prices) * 1.2, 2), f"{sum(prices) / len(prices):.3f}", [round(p * 0.9, 1) for p in prices])
`),
];
