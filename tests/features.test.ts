/**
 * Comprehensive feature coverage tests.
 * Goal: verify every documented feature and surface anything broken.
 */

import { describe, test, expect } from 'bun:test';
import { createInterpreter, runPython } from '../src';

// ─── Augmented Assignment (extended operators) ───────────────────────────────

describe('Augmented Assignment - extended operators', () => {
  test('//= floor-divide assign', async () => {
    expect(await runPython('x = 10\nx //= 3\nx')).toBe(3);
  });

  test('%=  modulo assign', async () => {
    expect(await runPython('x = 10\nx %= 3\nx')).toBe(1);
  });

  test('**= power assign', async () => {
    expect(await runPython('x = 2\nx **= 8\nx')).toBe(256);
  });

  test('+= on list (extends in-place)', async () => {
    expect(await runPython(`
items = [1, 2]
items += [3, 4]
items
`)).toEqual([1, 2, 3, 4]);
  });

  test('+= on string', async () => {
    expect(await runPython(`
s = "hello"
s += " world"
s
`)).toBe('hello world');
  });

  test('augmented assign to list index', async () => {
    expect(await runPython(`
items = [1, 2, 3]
items[1] += 10
items
`)).toEqual([1, 12, 3]);
  });

  test('augmented assign to dict key', async () => {
    expect(await runPython(`
d = {'x': 5}
d['x'] += 3
d['x']
`)).toBe(8);
  });
});

// ─── Multiple / Chained Assignment ───────────────────────────────────────────

describe('Multiple Assignment', () => {
  test('chained assignment x = y = 5', async () => {
    expect(await runPython('x = y = 5\n[x, y]')).toEqual([5, 5]);
  });

  test('tuple unpacking at statement level: a, b = 1, 2', async () => {
    expect(await runPython('a, b = 1, 2\n[a, b]')).toEqual([1, 2]);
  });

  test('tuple unpacking from list', async () => {
    expect(await runPython('a, b, c = [10, 20, 30]\n[a, b, c]')).toEqual([10, 20, 30]);
  });

  test('swap via tuple unpacking', async () => {
    expect(await runPython('a = 1\nb = 2\na, b = b, a\n[a, b]')).toEqual([2, 1]);
  });
});

// ─── String Methods ───────────────────────────────────────────────────────────

describe('String Methods - additional', () => {
  test('lstrip', async () => {
    expect(await runPython('"  hello  ".lstrip()')).toBe('hello  ');
  });

  test('rstrip', async () => {
    expect(await runPython('"  hello  ".rstrip()')).toBe('  hello');
  });

  test('lstrip with chars', async () => {
    expect(await runPython('"xxxhelloxxx".lstrip("x")')).toBe('helloxxx');
  });

  test('rstrip with chars', async () => {
    expect(await runPython('"xxxhelloxxx".rstrip("x")')).toBe('xxxhello');
  });

  test('strip with chars', async () => {
    expect(await runPython('"  hello  ".strip()')).toBe('hello');
  });

  test('str.index finds position', async () => {
    expect(await runPython('"hello".index("l")')).toBe(2);
  });

  test('str.index raises ValueError if not found', async () => {
    await expect(runPython('"hello".index("z")')).rejects.toThrow();
  });

  test('str.rfind finds last occurrence', async () => {
    expect(await runPython('"hello".rfind("l")')).toBe(3);
  });

  test('str.rfind returns -1 if not found', async () => {
    expect(await runPython('"hello".rfind("z")')).toBe(-1);
  });

  test('str.count with special regex char (dot)', async () => {
    // The dot `.` in regex matches any char — this is a potential bug
    expect(await runPython('"a.b.c".count(".")')).toBe(2);
  });

  test('str.count non-overlapping', async () => {
    expect(await runPython('"aaa".count("aa")')).toBe(1);
  });

  test('str.isdigit false for empty string', async () => {
    expect(await runPython('"".isdigit()')).toBe(false);
  });

  test('str.isdigit false for float string', async () => {
    expect(await runPython('"3.14".isdigit()')).toBe(false);
  });

  test('str.isalpha false for string with space', async () => {
    expect(await runPython('"hello world".isalpha()')).toBe(false);
  });

  test('str.isalpha true for pure alpha', async () => {
    expect(await runPython('"hello".isalpha()')).toBe(true);
  });

  test('str.isspace', async () => {
    expect(await runPython('"   ".isspace()')).toBe(true);
    expect(await runPython('"  a ".isspace()')).toBe(false);
    expect(await runPython('"".isspace()')).toBe(false);
  });

  test('str.split with maxsplit', async () => {
    expect(await runPython('"a,b,c,d".split(",", 2)')).toEqual(['a', 'b', 'c,d']);
  });

  test('str.split without args splits on whitespace', async () => {
    expect(await runPython('"  hello   world  ".split()')).toEqual(['hello', 'world']);
  });

  test('str.ljust', async () => {
    expect(await runPython('"hi".ljust(5)')).toBe('hi   ');
  });

  test('str.rjust', async () => {
    expect(await runPython('"hi".rjust(5)')).toBe('   hi');
  });

  test('str.center', async () => {
    expect(await runPython('"hi".center(6)')).toBe('  hi  ');
  });

  test('chained method calls', async () => {
    expect(await runPython('"hello".upper().lower()')).toBe('hello');
  });

  test('str.replace with count arg', async () => {
    expect(await runPython('"aaa".replace("a", "b", 2)')).toBe('bba');
  });

  test('str multiplication by 0', async () => {
    expect(await runPython('"abc" * 0')).toBe('');
  });

  test('str in operator', async () => {
    expect(await runPython('"ell" in "hello"')).toBe(true);
    expect(await runPython('"xyz" in "hello"')).toBe(false);
  });

  test('str not in operator', async () => {
    expect(await runPython('"xyz" not in "hello"')).toBe(true);
  });
});

// ─── String Type Conversion ───────────────────────────────────────────────────

describe('str() conversions', () => {
  test('str(None)', async () => {
    expect(await runPython('str(None)')).toBe('None');
  });

  test('str(True)', async () => {
    expect(await runPython('str(True)')).toBe('True');
  });

  test('str(False)', async () => {
    expect(await runPython('str(False)')).toBe('False');
  });

  test('str(list)', async () => {
    expect(await runPython('str([1, 2, 3])')).toBe('[1, 2, 3]');
  });

  test('str(dict)', async () => {
    // Dict order is insertion order in Python 3.7+
    expect(await runPython("str({'a': 1})")).toBe("{'a': 1}");
  });

  test('str(float)', async () => {
    expect(await runPython('str(3.14)')).toBe('3.14');
  });
});

// ─── int() conversions ────────────────────────────────────────────────────────

describe('int() conversions', () => {
  test('int(float) truncates', async () => {
    expect(await runPython('int(3.9)')).toBe(3);
    expect(await runPython('int(-3.9)')).toBe(-3);
  });

  test('int(True) is 1', async () => {
    expect(await runPython('int(True)')).toBe(1);
  });

  test('int(False) is 0', async () => {
    expect(await runPython('int(False)')).toBe(0);
  });

  test('int() with invalid string throws', async () => {
    await expect(runPython('int("abc")')).rejects.toThrow();
  });

  test('int() with float string throws', async () => {
    // In Python, int("3.14") raises ValueError
    await expect(runPython('int("3.14")')).rejects.toThrow();
  });
});

// ─── float() conversions ──────────────────────────────────────────────────────

describe('float() conversions', () => {
  test('float(int)', async () => {
    expect(await runPython('float(42)')).toBe(42.0);
  });

  test('float(True)', async () => {
    expect(await runPython('float(True)')).toBe(1.0);
  });

  test('float() with invalid string throws', async () => {
    await expect(runPython('float("abc")')).rejects.toThrow();
  });
});

// ─── Tuple ────────────────────────────────────────────────────────────────────

describe('Tuples', () => {
  test('tuple literal and return', async () => {
    expect(await runPython('(1, 2, 3)')).toEqual([1, 2, 3]);
  });

  test('tuple indexing', async () => {
    expect(await runPython('t = (10, 20, 30)\nt[1]')).toBe(20);
  });

  test('tuple negative indexing', async () => {
    expect(await runPython('t = (10, 20, 30)\nt[-1]')).toBe(30);
  });

  test('tuple slicing', async () => {
    expect(await runPython('t = (1, 2, 3, 4)\nt[1:3]')).toEqual([2, 3]);
  });

  test('len of tuple', async () => {
    expect(await runPython('len((1, 2, 3))')).toBe(3);
  });

  test('single-element tuple', async () => {
    expect(await runPython('(42,)')).toEqual([42]);
  });

  test('empty tuple', async () => {
    expect(await runPython('()')).toEqual([]);
  });

  test('tuple in operator', async () => {
    expect(await runPython('2 in (1, 2, 3)')).toBe(true);
    expect(await runPython('5 in (1, 2, 3)')).toBe(false);
  });

  test('nested tuple unpacking', async () => {
    expect(await runPython('a, (b, c) = 1, (2, 3)\n[a, b, c]')).toEqual([1, 2, 3]);
  });

  test('tuple iteration', async () => {
    expect(await runPython(`
result = []
for x in (1, 2, 3):
    result.append(x)
result
`)).toEqual([1, 2, 3]);
  });

  test('tuple equality', async () => {
    expect(await runPython('(1, 2, 3) == (1, 2, 3)')).toBe(true);
    expect(await runPython('(1, 2) == (1, 2, 3)')).toBe(false);
  });

  test('tuple concatenation', async () => {
    expect(await runPython('(1, 2) + (3, 4)')).toEqual([1, 2, 3, 4]);
  });
});

// ─── List Methods (additional) ────────────────────────────────────────────────

describe('List Methods - additional', () => {
  test('list.extend with list', async () => {
    expect(await runPython(`
a = [1, 2]
a.extend([3, 4])
a
`)).toEqual([1, 2, 3, 4]);
  });

  test('list.extend with tuple', async () => {
    expect(await runPython(`
a = [1, 2]
a.extend((3, 4))
a
`)).toEqual([1, 2, 3, 4]);
  });

  test('list.insert at beginning', async () => {
    expect(await runPython(`
a = [2, 3]
a.insert(0, 1)
a
`)).toEqual([1, 2, 3]);
  });

  test('list.insert past end', async () => {
    expect(await runPython(`
a = [1, 2]
a.insert(100, 3)
a
`)).toEqual([1, 2, 3]);
  });

  test('list.pop with index', async () => {
    expect(await runPython(`
a = [1, 2, 3]
a.pop(0)
`)).toBe(1);
  });

  test('list.pop with negative index', async () => {
    expect(await runPython(`
a = [1, 2, 3]
a.pop(-2)
`)).toBe(2);
  });

  test('list.index', async () => {
    expect(await runPython('[10, 20, 30].index(20)')).toBe(1);
  });

  test('list.index raises when not found', async () => {
    await expect(runPython('[1, 2, 3].index(5)')).rejects.toThrow();
  });

  test('list.count', async () => {
    expect(await runPython('[1, 2, 2, 3, 2].count(2)')).toBe(3);
  });

  test('list.copy is shallow', async () => {
    expect(await runPython(`
original = [1, 2, 3]
copy = original.copy()
copy.append(4)
len(original)
`)).toBe(3);
  });

  test('list.clear', async () => {
    expect(await runPython(`
a = [1, 2, 3]
a.clear()
a
`)).toEqual([]);
  });

  test('list.remove first occurrence', async () => {
    expect(await runPython(`
a = [1, 2, 2, 3]
a.remove(2)
a
`)).toEqual([1, 2, 3]);
  });

  test('list.remove raises if not found', async () => {
    await expect(runPython('[1, 2].remove(5)')).rejects.toThrow();
  });

  test('list.sort mutates in place and returns None', async () => {
    expect(await runPython(`
a = [3, 1, 2]
result = a.sort()
result is None
`)).toBe(true);
  });

  test('sorted() does not mutate original', async () => {
    expect(await runPython(`
original = [3, 1, 2]
s = sorted(original)
original
`)).toEqual([3, 1, 2]);
  });

  test('list in list', async () => {
    expect(await runPython('[[1, 2], [3, 4]][1][0]')).toBe(3);
  });
});

// ─── Dict Methods (additional) ────────────────────────────────────────────────

describe('Dict Methods - additional', () => {
  test('dict.setdefault returns existing value', async () => {
    expect(await runPython(`
d = {'a': 1}
d.setdefault('a', 99)
`)).toBe(1);
  });

  test('dict.setdefault sets and returns new value', async () => {
    expect(await runPython(`
d = {}
d.setdefault('x', 10)
`)).toBe(10);
  });

  test('dict.setdefault sets default in dict', async () => {
    expect(await runPython(`
d = {}
d.setdefault('x', 10)
d['x']
`)).toBe(10);
  });

  test('dict.update from another dict', async () => {
    expect(await runPython(`
d = {'a': 1}
d.update({'b': 2, 'a': 99})
d
`)).toEqual({ a: 99, b: 2 });
  });

  test('dict.copy is shallow', async () => {
    expect(await runPython(`
d = {'a': 1, 'b': 2}
c = d.copy()
c['c'] = 3
'c' in d
`)).toBe(false);
  });

  test('dict.pop removes key and returns value', async () => {
    expect(await runPython(`
d = {'a': 1, 'b': 2}
v = d.pop('a')
v
`)).toBe(1);
  });

  test('dict.pop removes key', async () => {
    expect(await runPython(`
d = {'a': 1, 'b': 2}
d.pop('a')
'a' in d
`)).toBe(false);
  });

  test('dict.pop with default for missing key', async () => {
    expect(await runPython(`
d = {'a': 1}
d.pop('z', 99)
`)).toBe(99);
  });

  test('dict.pop missing key without default raises KeyError', async () => {
    await expect(runPython(`
d = {'a': 1}
d.pop('z')
`)).rejects.toThrow('KeyError');
  });

  test('dict.clear empties dict', async () => {
    expect(await runPython(`
d = {'a': 1}
d.clear()
len(d)
`)).toBe(0);
  });

  test('dict() from list of pairs', async () => {
    expect(await runPython("dict([['a', 1], ['b', 2]])")).toEqual({ a: 1, b: 2 });
  });

  test('dict() from list of tuples', async () => {
    expect(await runPython("dict([('a', 1), ('b', 2)])")).toEqual({ a: 1, b: 2 });
  });

  test('dict() empty', async () => {
    expect(await runPython('dict()')).toEqual({});
  });

  test('dict with numeric keys', async () => {
    expect(await runPython('{1: "one", 2: "two"}[1]')).toBe('one');
  });

  test('dict items() iteration', async () => {
    expect(await runPython(`
d = {'a': 1, 'b': 2}
result = []
for k, v in d.items():
    result.append(f"{k}={v}")
result
`)).toEqual(['a=1', 'b=2']);
  });

  test('dict values() list', async () => {
    expect(await runPython("sorted(list({'a': 1, 'b': 2}.values()))")).toEqual([1, 2]);
  });

  test('dict comprehension with condition', async () => {
    expect(await runPython('{k: v for k, v in {"a": 1, "b": 2, "c": 3}.items() if v > 1}')).toEqual({ b: 2, c: 3 });
  });
});

// ─── Functions (additional) ───────────────────────────────────────────────────

describe('Functions - additional', () => {
  test('function with no return returns None', async () => {
    expect(await runPython(`
def f():
    x = 1
f()
`)).toBe(null);
  });

  test('early return', async () => {
    expect(await runPython(`
def f(x):
    if x > 0:
        return "positive"
    return "non-positive"
f(-1)
`)).toBe('non-positive');
  });

  test('function called with keyword argument', async () => {
    expect(await runPython(`
def greet(name, greeting="Hi"):
    return greeting + " " + name
greet(greeting="Hello", name="World")
`)).toBe('Hello World');
  });

  test('function as argument to another function', async () => {
    expect(await runPython(`
def apply(func, value):
    return func(value)

def double(x):
    return x * 2

apply(double, 5)
`)).toBe(10);
  });

  test('function stored in variable', async () => {
    expect(await runPython(`
def add(a, b):
    return a + b
f = add
f(3, 4)
`)).toBe(7);
  });

  test('nested function definition', async () => {
    expect(await runPython(`
def outer(x):
    def inner(y):
        return x + y
    return inner(10)
outer(5)
`)).toBe(15);
  });

  test('missing required argument throws', async () => {
    await expect(runPython(`
def f(x, y):
    return x + y
f(1)
`)).rejects.toThrow();
  });

  test('recursive fibonacci', async () => {
    expect(await runPython(`
def fib(n):
    if n <= 1:
        return n
    return fib(n-1) + fib(n-2)
fib(10)
`)).toBe(55);
  });

  test('pass in function body', async () => {
    expect(await runPython(`
def noop():
    pass
noop()
`)).toBe(null);
  });

  test('lambda with multiple parameters', async () => {
    expect(await runPython('f = lambda a, b: a + b\nf(3, 4)')).toBe(7);
  });

  test('lambda captures outer variable', async () => {
    expect(await runPython(`
n = 10
add_n = lambda x: x + n
add_n(5)
`)).toBe(15);
  });

  test('lambda in sorted', async () => {
    expect(await runPython("sorted(['banana', 'apple', 'cherry'], key=lambda x: len(x))")).toEqual([
      'apple', 'banana', 'cherry'
    ]);
  });

  test('function returning tuple', async () => {
    expect(await runPython(`
def divmod_py(a, b):
    return a // b, a % b
q, r = divmod_py(17, 5)
[q, r]
`)).toEqual([3, 2]);
  });
});

// ─── Built-ins (additional) ───────────────────────────────────────────────────

describe('Built-ins - additional', () => {
  test('type() on number', async () => {
    expect(await runPython("type(42)")).toBe("<class 'int'>");
  });

  test('type() on string', async () => {
    expect(await runPython("type('hello')")).toBe("<class 'str'>");
  });

  test('type() on list', async () => {
    expect(await runPython("type([])")).toBe("<class 'list'>");
  });

  test('type() on dict', async () => {
    expect(await runPython("type({})")).toBe("<class 'dict'>");
  });

  test('type() on bool', async () => {
    expect(await runPython("type(True)")).toBe("<class 'bool'>");
  });

  test('type() on None', async () => {
    expect(await runPython("type(None)")).toBe("<class 'NoneType'>");
  });

  test('isinstance() with str', async () => {
    expect(await runPython('isinstance("hello", "str")')).toBe(true);
    expect(await runPython('isinstance(42, "str")')).toBe(false);
  });

  test('isinstance() with int', async () => {
    expect(await runPython('isinstance(42, "int")')).toBe(true);
    expect(await runPython('isinstance("x", "int")')).toBe(false);
  });

  test('isinstance() with list', async () => {
    expect(await runPython('isinstance([], "list")')).toBe(true);
    expect(await runPython('isinstance({}, "list")')).toBe(false);
  });

  test('repr() of string', async () => {
    expect(await runPython("repr('hello')")).toBe("'hello'");
  });

  test('repr() of number', async () => {
    expect(await runPython('repr(42)')).toBe('42');
  });

  test('repr() of list', async () => {
    expect(await runPython('repr([1, 2, 3])')).toBe('[1, 2, 3]');
  });

  test('enumerate() with start parameter', async () => {
    expect(await runPython("list(enumerate(['a', 'b', 'c'], 1))")).toEqual([
      [1, 'a'], [2, 'b'], [3, 'c']
    ]);
  });

  test('enumerate() with start=10', async () => {
    expect(await runPython("list(enumerate(['x', 'y'], 10))")).toEqual([
      [10, 'x'], [11, 'y']
    ]);
  });

  test('reversed() on string', async () => {
    expect(await runPython('list(reversed("hello"))')).toEqual(['o', 'l', 'l', 'e', 'h']);
  });

  test('reversed() on tuple', async () => {
    expect(await runPython('list(reversed((1, 2, 3)))')).toEqual([3, 2, 1]);
  });

  test('zip() with 3 iterables', async () => {
    expect(await runPython("list(zip([1, 2], ['a', 'b'], ['x', 'y']))")).toEqual([
      [1, 'a', 'x'], [2, 'b', 'y']
    ]);
  });

  test('zip() stops at shortest iterable', async () => {
    expect(await runPython("list(zip([1, 2, 3], ['a', 'b']))")).toEqual([
      [1, 'a'], [2, 'b']
    ]);
  });

  test('zip() with empty', async () => {
    expect(await runPython("list(zip([], [1, 2]))")).toEqual([]);
  });

  test('any() with empty list is False', async () => {
    expect(await runPython('any([])')).toBe(false);
  });

  test('all() with empty list is True', async () => {
    expect(await runPython('all([])')).toBe(true);
  });

  test('any() with generator', async () => {
    expect(await runPython('any(x > 3 for x in [1, 2, 3, 4])')).toBe(true);
    expect(await runPython('any(x > 10 for x in [1, 2, 3])')).toBe(false);
  });

  test('all() with generator', async () => {
    expect(await runPython('all(x > 0 for x in [1, 2, 3])')).toBe(true);
    expect(await runPython('all(x > 0 for x in [1, -1, 3])')).toBe(false);
  });

  test('sum() with empty list', async () => {
    expect(await runPython('sum([])')).toBe(0);
  });

  test('sum() with start', async () => {
    expect(await runPython('sum([1, 2, 3], 100)')).toBe(106);
  });

  test('min() with strings', async () => {
    expect(await runPython("min('a', 'b', 'c')")).toBe('a');
  });

  test('max() with strings', async () => {
    expect(await runPython("max('a', 'b', 'c')")).toBe('c');
  });

  test('min() empty raises', async () => {
    await expect(runPython('min([])')).rejects.toThrow();
  });

  test('max() empty raises', async () => {
    await expect(runPython('max([])')).rejects.toThrow();
  });

  test('round() negative digits', async () => {
    expect(await runPython('round(1234, -2)')).toBe(1200);
  });

  test('abs() of zero', async () => {
    expect(await runPython('abs(0)')).toBe(0);
  });

  test('abs() of float', async () => {
    expect(await runPython('abs(-3.14)')).toBeCloseTo(3.14);
  });

  test('sorted() on string', async () => {
    expect(await runPython("sorted('dcba')")).toEqual(['a', 'b', 'c', 'd']);
  });

  test('sorted() on dict yields sorted keys', async () => {
    expect(await runPython("sorted({'c': 3, 'a': 1, 'b': 2})")).toEqual(['a', 'b', 'c']);
  });

  test('list() from range', async () => {
    expect(await runPython('list(range(3))')).toEqual([0, 1, 2]);
  });

  test('list() empty', async () => {
    expect(await runPython('list()')).toEqual([]);
  });
});

// ─── Control Flow (additional) ────────────────────────────────────────────────

describe('Control Flow - additional', () => {
  test('break in while loop', async () => {
    expect(await runPython(`
i = 0
while True:
    if i >= 3:
        break
    i += 1
i
`)).toBe(3);
  });

  test('continue in while loop', async () => {
    expect(await runPython(`
i = 0
result = []
while i < 5:
    i += 1
    if i == 3:
        continue
    result.append(i)
result
`)).toEqual([1, 2, 4, 5]);
  });

  test('nested for loops', async () => {
    expect(await runPython(`
result = []
for i in range(3):
    for j in range(3):
        result.append(i * 3 + j)
result
`)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('break in nested loop only breaks inner', async () => {
    expect(await runPython(`
result = []
for i in range(3):
    for j in range(3):
        if j == 1:
            break
        result.append((i, j))
result
`)).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  test('pass in for loop body', async () => {
    expect(await runPython(`
for i in range(5):
    pass
i
`)).toBe(4);
  });

  test('if with pass', async () => {
    expect(await runPython(`
x = 5
if x > 3:
    pass
x
`)).toBe(5);
  });

  test('elif chain with no else', async () => {
    expect(await runPython(`
x = 15
if x < 5:
    r = "small"
elif x < 10:
    r = "medium"
elif x < 20:
    r = "large"
r
`)).toBe('large');
  });

  test('for loop with range and step', async () => {
    expect(await runPython(`
result = []
for i in range(0, 10, 3):
    result.append(i)
result
`)).toEqual([0, 3, 6, 9]);
  });

  test('while with complex condition', async () => {
    expect(await runPython(`
x = 10
y = 0
while x > 0 and y < 20:
    x -= 3
    y += 2
[x, y]
`)).toEqual([-2, 8]);
  });
});

// ─── F-strings (additional) ───────────────────────────────────────────────────

describe('F-strings - additional', () => {
  test('f-string with None', async () => {
    expect(await runPython('x = None\nf"Value: {x}"')).toBe('Value: None');
  });

  test('f-string with bool', async () => {
    expect(await runPython('f"{True} and {False}"')).toBe('True and False');
  });

  test('f-string with ternary', async () => {
    expect(await runPython('x = 5\nf"x is {"big" if x > 3 else "small"}"')).toBe('x is big');
  });

  test('f-string with list comprehension', async () => {
    expect(await runPython('f"{[x*2 for x in range(3)]}"')).toBe('[0, 2, 4]');
  });

  test('f-string format spec :.2f', async () => {
    // This may not be supported
    expect(await runPython('x = 3.14159\nf"{x:.2f}"')).toBe('3.14');
  });

  test('f-string format spec :d', async () => {
    expect(await runPython('x = 42\nf"{x:d}"')).toBe('42');
  });

  test('nested f-string (double-quoted inside single-quoted)', async () => {
    expect(await runPython(`
name = "Alice"
f'Hello, {name}!'
`)).toBe('Hello, Alice!');
  });
});

// ─── Set Comprehension ────────────────────────────────────────────────────────

describe('Set Comprehension', () => {
  test('basic set comprehension', async () => {
    const result = await runPython('{x * x for x in range(4)}');
    expect(Array.isArray(result)).toBe(true);
    expect(result.sort()).toEqual([0, 1, 4, 9]);
  });

  test('set comprehension deduplicates', async () => {
    const result = await runPython('{x % 3 for x in range(9)}');
    expect(result.sort()).toEqual([0, 1, 2]);
  });

  test('set comprehension with condition', async () => {
    const result = await runPython('{x for x in range(10) if x % 2 == 0}');
    expect(result.sort()).toEqual([0, 2, 4, 6, 8]);
  });
});

// ─── Print ────────────────────────────────────────────────────────────────────

describe('Print - additional', () => {
  test('print with multiple args', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: s => output.push(s) });
    await interp.run('print(1, 2, 3)');
    expect(output).toEqual(['1 2 3']);
  });

  test('print with separator (sep not supported - just space)', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: s => output.push(s) });
    await interp.run('print("a", "b", "c")');
    expect(output).toEqual(['a b c']);
  });

  test('print None', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: s => output.push(s) });
    await interp.run('print(None)');
    expect(output).toEqual(['None']);
  });

  test('print bool', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: s => output.push(s) });
    await interp.run('print(True)');
    expect(output).toEqual(['True']);
  });

  test('print without onPrint callback throws', async () => {
    await expect(runPython('print("hello")')).rejects.toThrow();
  });
});

// ─── Operator edge cases ──────────────────────────────────────────────────────

describe('Operator edge cases', () => {
  test('integer division truncates toward negative infinity', async () => {
    expect(await runPython('-7 // 2')).toBe(-4);  // Python: -4 (not -3)
  });

  test('modulo with negative dividend', async () => {
    expect(await runPython('-7 % 3')).toBe(2);  // Python-style
  });

  test('power with negative base', async () => {
    expect(await runPython('(-2) ** 3')).toBe(-8);
  });

  test('power with fractional exponent', async () => {
    expect(await runPython('4 ** 0.5')).toBe(2);
  });

  test('zero power zero', async () => {
    expect(await runPython('0 ** 0')).toBe(1);
  });

  test('floor division by zero raises', async () => {
    await expect(runPython('5 // 0')).rejects.toThrow('Division by zero');
  });

  test('modulo by zero raises', async () => {
    await expect(runPython('5 % 0')).rejects.toThrow('Division by zero');
  });

  test('string comparison operators', async () => {
    expect(await runPython('"a" < "b"')).toBe(true);
    expect(await runPython('"b" > "a"')).toBe(true);
    expect(await runPython('"a" <= "a"')).toBe(true);
    expect(await runPython('"z" >= "a"')).toBe(true);
  });

  test('boolean in arithmetic', async () => {
    expect(await runPython('True + 1')).toBe(2);
    expect(await runPython('False + 1')).toBe(1);
  });

  test('unary plus on number', async () => {
    expect(await runPython('+5')).toBe(5);
    expect(await runPython('+-5')).toBe(-5);
  });
});

// ─── Comprehension edge cases ─────────────────────────────────────────────────

describe('Comprehension edge cases', () => {
  test('list comprehension with multiple conditions', async () => {
    expect(await runPython('[x for x in range(20) if x % 2 == 0 if x % 3 == 0]')).toEqual([0, 6, 12, 18]);
  });

  test('list comprehension with multiple for clauses', async () => {
    expect(await runPython('[x + y for x in [1, 2] for y in [10, 20]]')).toEqual([11, 21, 12, 22]);
  });

  test('dict comprehension from range', async () => {
    expect(await runPython('{str(i): i * i for i in range(3)}')).toEqual({ '0': 0, '1': 1, '2': 4 });
  });

  test('nested list comprehension', async () => {
    expect(await runPython('[sum(row) for row in [[1, 2], [3, 4], [5, 6]]]')).toEqual([3, 7, 11]);
  });
});

// ─── Scope / Closures ─────────────────────────────────────────────────────────

describe('Scope and Closures', () => {
  test('variable defined in if not visible outside', async () => {
    // In Python, if blocks don't create a new scope
    expect(await runPython(`
x = 5
if x > 3:
    y = "inside"
y
`)).toBe('inside');
  });

  test('closure captures variable by reference', async () => {
    expect(await runPython(`
def make_counter():
    count = 0
    def increment():
        return count + 1
    return increment
c = make_counter()
c()
`)).toBe(1);
  });

  test('multiple closures share closure env', async () => {
    expect(await runPython(`
def make_adder(n):
    def add(x):
        return x + n
    return add
add5 = make_adder(5)
add10 = make_adder(10)
[add5(1), add10(1)]
`)).toEqual([6, 11]);
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('Error propagation', () => {
  test('calling non-callable raises TypeError', async () => {
    await expect(runPython('x = 5\nx()')).rejects.toThrow();
  });

  test('attribute access on non-object raises', async () => {
    await expect(runPython('x = 5\nx.foo')).rejects.toThrow();
  });

  test('key error with number key', async () => {
    await expect(runPython('{1: "a"}[2]')).rejects.toThrow('KeyError');
  });

  test('index error on empty list', async () => {
    await expect(runPython('[][0]')).rejects.toThrow();
  });

  test('division by zero in expression', async () => {
    await expect(runPython('1 + 1 / 0')).rejects.toThrow('Division by zero');
  });

  test('NameError in function body', async () => {
    await expect(runPython(`
def f():
    return unknown_var
f()
`)).rejects.toThrow("Name 'unknown_var' is not defined");
  });

  test('TypeError for unsupported operand types', async () => {
    await expect(runPython('[1, 2] - [1]')).rejects.toThrow();
  });
});

// ─── Complex real-world patterns ──────────────────────────────────────────────

describe('Real-world patterns', () => {
  test('groupby pattern', async () => {
    expect(await runPython(`
items = [
    {'name': 'a', 'group': 'x'},
    {'name': 'b', 'group': 'y'},
    {'name': 'c', 'group': 'x'},
]
groups = {}
for item in items:
    g = item['group']
    if g not in groups:
        groups[g] = []
    groups[g].append(item['name'])
groups
`)).toEqual({ x: ['a', 'c'], y: ['b'] });
  });

  test('flatten nested list', async () => {
    expect(await runPython(`
nested = [[1, 2], [3, 4], [5, 6]]
flat = [x for sublist in nested for x in sublist]
flat
`)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('running total', async () => {
    expect(await runPython(`
values = [10, 20, 30, 40]
running = []
total = 0
for v in values:
    total += v
    running.append(total)
running
`)).toEqual([10, 30, 60, 100]);
  });

  test('count unique values', async () => {
    expect(await runPython(`
words = ['apple', 'banana', 'apple', 'cherry', 'banana', 'apple']
counts = {}
for w in words:
    counts[w] = counts.get(w, 0) + 1
counts
`)).toEqual({ apple: 3, banana: 2, cherry: 1 });
  });

  test('find top N pattern', async () => {
    expect(await runPython(`
scores = [
    {'name': 'Alice', 'score': 85},
    {'name': 'Bob', 'score': 92},
    {'name': 'Charlie', 'score': 78},
    {'name': 'Diana', 'score': 95},
]
top2 = sorted(scores, key=lambda x: x['score'], reverse=True)[:2]
[s['name'] for s in top2]
`)).toEqual(['Diana', 'Bob']);
  });

  test('string processing pipeline', async () => {
    expect(await runPython(`
data = "  Alice:30, Bob:25, Charlie:35  "
people = []
for part in data.strip().split(", "):
    name, age = part.split(":")
    people.append({'name': name, 'age': int(age)})
people
`)).toEqual([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ]);
  });

  test('compute statistics', async () => {
    expect(await runPython(`
nums = [2, 4, 4, 4, 5, 5, 7, 9]
n = len(nums)
mean = sum(nums) / n
mean
`)).toBe(5);
  });

  test('transpose matrix', async () => {
    expect(await runPython(`
matrix = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
transposed = [[row[i] for row in matrix] for i in range(3)]
transposed
`)).toEqual([[1, 4, 7], [2, 5, 8], [3, 6, 9]]);
  });
});

// ─── Multiline strings ────────────────────────────────────────────────────────

describe('Multiline strings', () => {
  test('triple double-quoted string', async () => {
    expect(await runPython('"""hello\nworld"""')).toBe('hello\nworld');
  });

  test('triple single-quoted string', async () => {
    expect(await runPython("'''hello\nworld'''")).toBe('hello\nworld');
  });

  test('string with embedded quotes', async () => {
    expect(await runPython('"it\'s a test"')).toBe("it's a test");
  });

  test('string with escaped newline', async () => {
    expect(await runPython('"line1\\nline2"')).toBe('line1\nline2');
  });

  test('string with tab', async () => {
    expect(await runPython('"a\\tb"')).toBe('a\tb');
  });
});

// ─── Number formats ───────────────────────────────────────────────────────────

describe('Number formats', () => {
  test('scientific notation', async () => {
    expect(await runPython('1e3')).toBe(1000);
    expect(await runPython('1.5e2')).toBe(150);
    expect(await runPython('1e-3')).toBeCloseTo(0.001);
  });

  test('negative scientific notation', async () => {
    expect(await runPython('-2.5e2')).toBe(-250);
  });

  test('large integers', async () => {
    expect(await runPython('1000000 * 1000000')).toBe(1000000000000);
  });

  test('floating point arithmetic', async () => {
    expect(await runPython('round(0.1 + 0.2, 10)')).toBeCloseTo(0.3);
  });
});

// ─── Chained comparisons ──────────────────────────────────────────────────────

describe('Chained Comparisons - additional', () => {
  test('four-way chain', async () => {
    expect(await runPython('1 < 2 < 3 < 4')).toBe(true);
    expect(await runPython('1 < 2 < 2 < 4')).toBe(false);
  });

  test('mixed operators in chain', async () => {
    expect(await runPython('1 <= 1 < 2 <= 3')).toBe(true);
  });
});

// ─── Boolean short-circuit with side effects ─────────────────────────────────

describe('Short-circuit evaluation', () => {
  test('or returns first truthy value', async () => {
    expect(await runPython('0 or 1')).toBe(1);
    expect(await runPython('"" or "fallback"')).toBe('fallback');
    expect(await runPython('[] or [1, 2]')).toEqual([1, 2]);
  });

  test('and returns first falsy or last truthy', async () => {
    expect(await runPython('1 and 2')).toBe(2);
    expect(await runPython('0 and 2')).toBe(0);
    expect(await runPython('"a" and "b"')).toBe('b');
  });

  test('or with none', async () => {
    expect(await runPython('None or "default"')).toBe('default');
    expect(await runPython('None or 0')).toBe(0);
  });
});

// ─── Misc builtins ────────────────────────────────────────────────────────────

describe('Misc builtins', () => {
  test('map() with range', async () => {
    expect(await runPython('list(map(lambda x: x * x, range(5)))')).toEqual([0, 1, 4, 9, 16]);
  });

  test('filter() with range', async () => {
    expect(await runPython('list(filter(lambda x: x % 2 == 0, range(8)))')).toEqual([0, 2, 4, 6]);
  });

  test('map + filter chained', async () => {
    expect(await runPython(`
result = list(filter(lambda x: x > 5, map(lambda x: x * 2, [1, 2, 3, 4, 5])))
result
`)).toEqual([6, 8, 10]);
  });

  test('sum of mapped values', async () => {
    expect(await runPython('sum(map(lambda x: x * x, [1, 2, 3, 4]))')).toBe(30);
  });

  test('len of iterator', async () => {
    // len() of a range/iterator - probably not supported
    await expect(runPython('len(range(5))')).rejects.toThrow();
  });
});

// ─── raise statement ────────────────────────────────────────────────────────

describe('raise statement', () => {
  test('raise and catch ValueError', async () => {
    expect(await runPython(`
try:
    raise ValueError("bad input")
except ValueError as e:
    result = str(e)
result
`)).toBe('bad input');
  });

  test('raise and catch generic Exception', async () => {
    expect(await runPython(`
try:
    raise Exception("oops")
except Exception as e:
    result = str(e)
result
`)).toBe('oops');
  });

  test('uncaught raise propagates', async () => {
    await expect(runPython('raise ValueError("nope")')).rejects.toThrow();
  });

  test('raise without argument (bare raise is not supported, but with arg is)', async () => {
    expect(await runPython(`
try:
    raise TypeError("wrong type")
except TypeError:
    x = "caught"
x
`)).toBe('caught');
  });
});

// ─── for...else / while...else ──────────────────────────────────────────────

describe('Loop else clauses', () => {
  test('for-else runs else when no break', async () => {
    expect(await runPython(`
result = "default"
for x in [1, 2, 3]:
    pass
else:
    result = "completed"
result
`)).toBe('completed');
  });

  test('for-else skips else on break', async () => {
    expect(await runPython(`
result = "default"
for x in [1, 2, 3]:
    if x == 2:
        break
else:
    result = "completed"
result
`)).toBe('default');
  });

  test('while-else runs else when condition becomes false', async () => {
    expect(await runPython(`
i = 0
result = "default"
while i < 3:
    i += 1
else:
    result = "done"
result
`)).toBe('done');
  });

  test('while-else skips else on break', async () => {
    expect(await runPython(`
i = 0
result = "default"
while i < 10:
    i += 1
    if i == 5:
        break
else:
    result = "done"
result
`)).toBe('default');
  });
});

// ─── global and nonlocal ────────────────────────────────────────────────────

describe('global and nonlocal', () => {
  test('global lets function modify module-level variable', async () => {
    expect(await runPython(`
x = 10
def change():
    global x
    x = 20
change()
x
`)).toBe(20);
  });

  test('nonlocal lets inner function modify enclosing variable', async () => {
    expect(await runPython(`
def outer():
    x = 10
    def inner():
        nonlocal x
        x = 20
    inner()
    return x
outer()
`)).toBe(20);
  });

  test('without global, assignment creates local', async () => {
    expect(await runPython(`
x = 10
def f():
    x = 99
f()
x
`)).toBe(10);
  });
});

// ─── *args and **kwargs ─────────────────────────────────────────────────────

describe('*args and **kwargs', () => {
  test('*args collects positional arguments', async () => {
    expect(await runPython(`
def f(*args):
    return list(args)
f(1, 2, 3)
`)).toEqual([1, 2, 3]);
  });

  test('**kwargs collects keyword arguments', async () => {
    expect(await runPython(`
def f(**kwargs):
    return kwargs
f(a=1, b=2)
`)).toEqual({ a: 1, b: 2 });
  });

  test('mixed regular and *args', async () => {
    expect(await runPython(`
def f(first, *rest):
    return [first, list(rest)]
f(1, 2, 3)
`)).toEqual([1, [2, 3]]);
  });

  test('*args with sum', async () => {
    expect(await runPython(`
def total(*args):
    return sum(args)
total(1, 2, 3, 4)
`)).toBe(10);
  });
});

// ─── Number literal formats ─────────────────────────────────────────────────

describe('Number literal formats', () => {
  test('hex literal', async () => {
    expect(await runPython('0xff')).toBe(255);
    expect(await runPython('0xFF')).toBe(255);
    expect(await runPython('0x10')).toBe(16);
  });

  test('octal literal', async () => {
    expect(await runPython('0o77')).toBe(63);
    expect(await runPython('0o10')).toBe(8);
  });

  test('binary literal', async () => {
    expect(await runPython('0b1010')).toBe(10);
    expect(await runPython('0b11111111')).toBe(255);
  });

  test('underscore separators', async () => {
    expect(await runPython('1_000_000')).toBe(1000000);
    expect(await runPython('1_000 + 2_000')).toBe(3000);
  });
});

// ─── hex/oct/bin/ord/chr builtins ───────────────────────────────────────────

describe('hex/oct/bin/ord/chr builtins', () => {
  test('hex()', async () => {
    expect(await runPython('hex(255)')).toBe('0xff');
    expect(await runPython('hex(0)')).toBe('0x0');
    expect(await runPython('hex(-42)')).toBe('-0x2a');
  });

  test('oct()', async () => {
    expect(await runPython('oct(8)')).toBe('0o10');
    expect(await runPython('oct(0)')).toBe('0o0');
  });

  test('bin()', async () => {
    expect(await runPython('bin(10)')).toBe('0b1010');
    expect(await runPython('bin(0)')).toBe('0b0');
  });

  test('ord()', async () => {
    expect(await runPython('ord("A")')).toBe(65);
    expect(await runPython('ord("a")')).toBe(97);
    expect(await runPython('ord("0")')).toBe(48);
  });

  test('chr()', async () => {
    expect(await runPython('chr(65)')).toBe('A');
    expect(await runPython('chr(97)')).toBe('a');
    expect(await runPython('chr(48)')).toBe('0');
  });
});

// ─── str.format with named args ─────────────────────────────────────────────

describe('str.format named placeholders', () => {
  test('named placeholders', async () => {
    expect(await runPython('"{name} is {age}".format(name="Alice", age=30)')).toBe('Alice is 30');
  });

  test('mixed positional and named', async () => {
    expect(await runPython('"{0} is {age}".format("Alice", age=30)')).toBe('Alice is 30');
  });
});

// ─── del statement ──────────────────────────────────────────────────────────

describe('del statement', () => {
  test('del variable', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: (s) => output.push(s) });
    await interp.run('x = 5\ndel x');
    await expect(interp.run('x')).rejects.toThrow("not defined");
  });

  test('del dict key', async () => {
    expect(await runPython('d = {"a": 1, "b": 2}\ndel d["a"]\nlist(d.keys())')).toEqual(["b"]);
  });

  test('del list element', async () => {
    expect(await runPython('lst = [1, 2, 3]\ndel lst[1]\nlst')).toEqual([1, 3]);
  });

  test('del negative index', async () => {
    expect(await runPython('lst = [1, 2, 3]\ndel lst[-1]\nlst')).toEqual([1, 2]);
  });
});

// ─── assert statement ───────────────────────────────────────────────────────

describe('assert statement', () => {
  test('assert True passes', async () => {
    expect(await runPython('assert True\n42')).toBe(42);
  });

  test('assert False raises', async () => {
    await expect(runPython('assert False')).rejects.toThrow();
  });

  test('assert with message', async () => {
    await expect(runPython('assert False, "oops"')).rejects.toThrow("oops");
  });

  test('assert expression', async () => {
    expect(await runPython('x = 5\nassert x > 3\nx')).toBe(5);
  });
});

// ─── Bitwise operators ──────────────────────────────────────────────────────

describe('Bitwise operators', () => {
  test('AND &', async () => {
    expect(await runPython('0b1100 & 0b1010')).toBe(0b1000);
  });

  test('OR |', async () => {
    expect(await runPython('0b1100 | 0b1010')).toBe(0b1110);
  });

  test('XOR ^', async () => {
    expect(await runPython('0b1100 ^ 0b1010')).toBe(0b0110);
  });

  test('NOT ~', async () => {
    expect(await runPython('~0')).toBe(-1);
    expect(await runPython('~5')).toBe(-6);
  });

  test('left shift <<', async () => {
    expect(await runPython('1 << 4')).toBe(16);
  });

  test('right shift >>', async () => {
    expect(await runPython('16 >> 2')).toBe(4);
  });

  test('precedence: shifts bind tighter than bitwise and/or', async () => {
    expect(await runPython('1 << 4 | 1')).toBe(17);
  });
});

// ─── Additional builtins ────────────────────────────────────────────────────

describe('pow / divmod / callable builtins', () => {
  test('pow(2, 10)', async () => {
    expect(await runPython('pow(2, 10)')).toBe(1024);
  });

  test('pow with modulo', async () => {
    expect(await runPython('pow(2, 10, 100)')).toBe(24);
  });

  test('divmod(17, 5)', async () => {
    expect(await runPython('divmod(17, 5)')).toEqual([3, 2]);
  });

  test('callable on function', async () => {
    expect(await runPython('def f():\n    pass\ncallable(f)')).toBe(true);
  });

  test('callable on non-function', async () => {
    expect(await runPython('callable(42)')).toBe(false);
  });
});

describe('tuple() constructor', () => {
  test('tuple from list', async () => {
    expect(await runPython('list(tuple([1, 2, 3]))')).toEqual([1, 2, 3]);
  });

  test('tuple from string', async () => {
    expect(await runPython('list(tuple("abc"))')).toEqual(["a", "b", "c"]);
  });

  test('empty tuple()', async () => {
    expect(await runPython('len(tuple())')).toBe(0);
  });
});

describe('int() with base', () => {
  test('int("ff", 16)', async () => {
    expect(await runPython('int("ff", 16)')).toBe(255);
  });

  test('int("1010", 2)', async () => {
    expect(await runPython('int("1010", 2)')).toBe(10);
  });

  test('int("0xff", 16)', async () => {
    expect(await runPython('int("0xff", 16)')).toBe(255);
  });
});

describe('dict() keyword constructor', () => {
  test('dict(a=1, b=2)', async () => {
    const result = await runPython('d = dict(a=1, b=2)\nd["a"]');
    expect(result).toBe(1);
  });

  test('empty dict()', async () => {
    expect(await runPython('len(dict())')).toBe(0);
  });
});

describe('print sep/end', () => {
  test('print with sep', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: (s) => output.push(s) });
    await interp.run('print("a", "b", sep=",")');
    expect(output[0]).toBe('a,b');
  });

  test('print with end', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: (s) => output.push(s) });
    await interp.run('print("hello", end="!")');
    expect(output[0]).toBe('hello!');
  });
});

describe('enumerate(start=N) keyword form', () => {
  test('enumerate with start keyword', async () => {
    expect(await runPython('list(enumerate(["a","b"], start=5))')).toEqual([[5,"a"],[6,"b"]]);
  });
});

describe('isinstance with type builtins', () => {
  test('isinstance(5, int)', async () => {
    expect(await runPython('isinstance(5, int)')).toBe(true);
  });

  test('isinstance("hi", str)', async () => {
    expect(await runPython('isinstance("hi", str)')).toBe(true);
  });

  test('isinstance with tuple of types', async () => {
    expect(await runPython('isinstance(5, (int, str))')).toBe(true);
    expect(await runPython('isinstance("hi", (int, str))')).toBe(true);
    expect(await runPython('isinstance([], (int, str))')).toBe(false);
  });
});

// ─── try/except/else ────────────────────────────────────────────────────────

describe('try/except/else', () => {
  test('else runs when no exception', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: (s) => output.push(s) });
    await interp.run(`
try:
    x = 1
except:
    x = 2
else:
    x = 3
x`);
    expect(await interp.run('x')).toBe(3);
  });

  test('else does not run when exception caught', async () => {
    const interp = createInterpreter({ onPrint: () => {} });
    await interp.run(`
result = 0
try:
    raise ValueError("oops")
except ValueError:
    result = 1
else:
    result = 2
`);
    expect(await interp.run('result')).toBe(1);
  });

  test('try/except/else/finally all together', async () => {
    const output: string[] = [];
    const interp = createInterpreter({ onPrint: (s) => output.push(s) });
    await interp.run(`
result = []
try:
    result.append("try")
except:
    result.append("except")
else:
    result.append("else")
finally:
    result.append("finally")
`);
    expect(await interp.run('result')).toEqual(["try", "else", "finally"]);
  });
});

// ─── sorted() and list.sort() improvements ──────────────────────────────────

describe('sorting improvements', () => {
  test('sorted() compares tuples', async () => {
    expect(await runPython('sorted([(3, "c"), (1, "a"), (2, "b")])')).toEqual([[1,"a"],[2,"b"],[3,"c"]]);
  });

  test('sorted() compares lists', async () => {
    expect(await runPython('sorted([[3, 1], [1, 2], [1, 0]])')).toEqual([[1,0],[1,2],[3,1]]);
  });

  test('list.sort(key=len)', async () => {
    expect(await runPython('x = ["banana", "pie", "a"]\nx.sort(key=len)\nx')).toEqual(["a", "pie", "banana"]);
  });

  test('list.sort(key=lambda with len call)', async () => {
    expect(await runPython('x = ["banana", "pie", "a"]\nx.sort(key=lambda s: len(s))\nx')).toEqual(["a", "pie", "banana"]);
  });
});

// ─── Banker's rounding ──────────────────────────────────────────────────────

describe("round() banker's rounding", () => {
  test('round(0.5) → 0', async () => {
    expect(await runPython('round(0.5)')).toBe(0);
  });

  test('round(1.5) → 2', async () => {
    expect(await runPython('round(1.5)')).toBe(2);
  });

  test('round(2.5) → 2', async () => {
    expect(await runPython('round(2.5)')).toBe(2);
  });

  test('round(3.5) → 4', async () => {
    expect(await runPython('round(3.5)')).toBe(4);
  });
});

// ─── Additional string methods ──────────────────────────────────────────────

describe('additional string methods', () => {
  test('isupper / islower', async () => {
    expect(await runPython('"HELLO".isupper()')).toBe(true);
    expect(await runPython('"hello".islower()')).toBe(true);
    expect(await runPython('"Hello".isupper()')).toBe(false);
    expect(await runPython('"Hello".islower()')).toBe(false);
  });

  test('partition', async () => {
    expect(await runPython('"hello-world".partition("-")')).toEqual(["hello", "-", "world"]);
    expect(await runPython('"hello".partition("-")')).toEqual(["hello", "", ""]);
  });

  test('rpartition', async () => {
    expect(await runPython('"a-b-c".rpartition("-")')).toEqual(["a-b", "-", "c"]);
  });

  test('splitlines', async () => {
    expect(await runPython('"one\\ntwo\\nthree".splitlines()')).toEqual(["one", "two", "three"]);
  });

  test('removeprefix / removesuffix', async () => {
    expect(await runPython('"TestHook".removeprefix("Test")')).toBe("Hook");
    expect(await runPython('"MiscTests".removesuffix("Tests")')).toBe("Misc");
    expect(await runPython('"NoMatch".removeprefix("X")')).toBe("NoMatch");
  });

  test('expandtabs', async () => {
    expect(await runPython('"01\\t012\\t0123\\t01234".expandtabs()')).toBe("01      012     0123    01234");
  });
});

// ─── dict.popitem ───────────────────────────────────────────────────────────

describe('dict.popitem', () => {
  test('removes and returns last item', async () => {
    expect(await runPython('d = {"a": 1, "b": 2}\nd.popitem()')).toEqual(["b", 2]);
  });

  test('raises on empty dict', async () => {
    await expect(runPython('{}.popitem()')).rejects.toThrow();
  });
});
