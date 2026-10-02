import { describe, test, expect } from 'bun:test';
import { createInterpreter, runPython } from '../src';

describe('Interpreter', () => {
  describe('Arithmetic', () => {
    test('addition', async () => {
      expect(await runPython('1 + 2')).toBe(3);
    });

    test('subtraction', async () => {
      expect(await runPython('5 - 3')).toBe(2);
    });

    test('multiplication', async () => {
      expect(await runPython('4 * 3')).toBe(12);
    });

    test('division', async () => {
      expect(await runPython('10 / 4')).toBe(2.5);
    });

    test('floor division', async () => {
      expect(await runPython('10 // 3')).toBe(3);
    });

    test('modulo', async () => {
      expect(await runPython('10 % 3')).toBe(1);
    });

    test('python-style modulo (negative)', async () => {
      expect(await runPython('-7 % 3')).toBe(2);
    });

    test('power', async () => {
      expect(await runPython('2 ** 10')).toBe(1024);
    });

    test('precedence', async () => {
      expect(await runPython('1 + 2 * 3')).toBe(7);
      expect(await runPython('(1 + 2) * 3')).toBe(9);
    });

    test('unary minus', async () => {
      expect(await runPython('-5')).toBe(-5);
      expect(await runPython('--5')).toBe(5);
    });

    test('None treated as 0 in addition', async () => {
      expect(await runPython('5 + None')).toBe(5);
      expect(await runPython('None + 5')).toBe(5);
      expect(await runPython('None + None')).toBe(0);
    });

    test('None treated as 0 in subtraction', async () => {
      expect(await runPython('5 - None')).toBe(5);
      expect(await runPython('None - 5')).toBe(-5);
    });

    test('None treated as 0 in multiplication', async () => {
      expect(await runPython('5 * None')).toBe(0);
      expect(await runPython('None * 5')).toBe(0);
    });
  });

  describe('Variables', () => {
    test('assignment and use', async () => {
      expect(await runPython('x = 5\nx * 2')).toBe(10);
    });

    test('multiple assignments', async () => {
      expect(await runPython('x = 1\ny = 2\nx + y')).toBe(3);
    });

    test('augmented assignment', async () => {
      expect(await runPython('x = 5\nx += 3\nx')).toBe(8);
      expect(await runPython('x = 10\nx -= 3\nx')).toBe(7);
      expect(await runPython('x = 4\nx *= 3\nx')).toBe(12);
      expect(await runPython('x = 10\nx /= 4\nx')).toBe(2.5);
    });
  });

  describe('Strings', () => {
    test('concatenation', async () => {
      expect(await runPython('"hello" + " " + "world"')).toBe('hello world');
    });

    test('repetition', async () => {
      expect(await runPython('"ab" * 3')).toBe('ababab');
    });

    test('indexing', async () => {
      expect(await runPython('"hello"[0]')).toBe('h');
      expect(await runPython('"hello"[-1]')).toBe('o');
    });

    test('slicing', async () => {
      expect(await runPython('"hello"[:3]')).toBe('hel');
      expect(await runPython('"hello"[2:]')).toBe('llo');
      expect(await runPython('"hello"[1:4]')).toBe('ell');
    });

    test('slice with step', async () => {
      expect(await runPython('"hello"[::2]')).toBe('hlo');
      expect(await runPython('"hello"[::-1]')).toBe('olleh');
    });

    test('string methods', async () => {
      expect(await runPython('"hello".upper()')).toBe('HELLO');
      expect(await runPython('"HELLO".lower()')).toBe('hello');
      expect(await runPython('"hello".capitalize()')).toBe('Hello');
      expect(await runPython('"HELLO WORLD".capitalize()')).toBe('Hello world');
      expect(await runPython('"".capitalize()')).toBe('');
      expect(await runPython('"hello world".title()')).toBe('Hello World');
      expect(await runPython('"42".zfill(5)')).toBe('00042');
      expect(await runPython('"-42".zfill(5)')).toBe('-0042');
      expect(await runPython('"test".zfill(2)')).toBe('test');
      expect(await runPython('"  hello  ".strip()')).toBe('hello');
      expect(await runPython('"a,b,c".split(",")')).toEqual(['a', 'b', 'c']);
      expect(await runPython('",".join(["a", "b", "c"])')).toBe('a,b,c');
      expect(await runPython('"hello".replace("l", "x")')).toBe('hexxo');
      expect(await runPython('"hello".startswith("he")')).toBe(true);
      expect(await runPython('"hello".endswith("lo")')).toBe(true);
      expect(await runPython('"hello".find("l")')).toBe(2);
    });

    test('string format', async () => {
      expect(await runPython('"Hello {}!".format("World")')).toBe('Hello World!');
      expect(await runPython('"{0} {1}".format("a", "b")')).toBe('a b');
    });
  });

  describe('Lists', () => {
    test('literal', async () => {
      expect(await runPython('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    test('indexing', async () => {
      expect(await runPython('[1, 2, 3][0]')).toBe(1);
      expect(await runPython('[1, 2, 3][-1]')).toBe(3);
    });

    test('slicing', async () => {
      expect(await runPython('[1, 2, 3, 4, 5][1:4]')).toEqual([2, 3, 4]);
      expect(await runPython('[1, 2, 3, 4, 5][::-1]')).toEqual([5, 4, 3, 2, 1]);
    });

    test('concatenation', async () => {
      expect(await runPython('[1, 2] + [3, 4]')).toEqual([1, 2, 3, 4]);
    });

    test('repetition', async () => {
      expect(await runPython('[1, 2] * 3')).toEqual([1, 2, 1, 2, 1, 2]);
    });

    test('list methods', async () => {
      expect(await runPython(`
items = [1, 2, 3]
items.append(4)
items
`)).toEqual([1, 2, 3, 4]);

      expect(await runPython(`
items = [1, 2, 3]
items.pop()
`)).toBe(3);

      expect(await runPython(`
items = [3, 1, 2]
items.sort()
items
`)).toEqual([1, 2, 3]);

      expect(await runPython(`
items = [1, 2, 3]
items.reverse()
items
`)).toEqual([3, 2, 1]);
    });

    test('list.sort with key function', async () => {
      // Sort dicts by field
      expect(await runPython(`
items = [
    {'name': 'banana', 'price': 2},
    {'name': 'apple', 'price': 1},
    {'name': 'cherry', 'price': 3}
]
items.sort(key=lambda x: x['price'])
items
`)).toEqual([
        { name: 'apple', price: 1 },
        { name: 'banana', price: 2 },
        { name: 'cherry', price: 3 }
      ]);

      // Sort descending with reverse
      expect(await runPython(`
items = [
    {'value': 10},
    {'value': 5},
    {'value': 20}
]
items.sort(key=lambda x: x['value'], reverse=True)
items
`)).toEqual([
        { value: 20 },
        { value: 10 },
        { value: 5 }
      ]);
    });

    test('assignment to list index', async () => {
      expect(await runPython(`
items = [1, 2, 3]
items[1] = 10
items
`)).toEqual([1, 10, 3]);
    });
  });

  describe('Dicts', () => {
    test('literal', async () => {
      expect(await runPython("{'a': 1, 'b': 2}")).toEqual({ a: 1, b: 2 });
    });

    test('access', async () => {
      expect(await runPython("{'a': 1, 'b': 2}['a']")).toBe(1);
    });

    test('assignment', async () => {
      expect(await runPython(`
d = {}
d['x'] = 10
d['x']
`)).toBe(10);
    });

    test('dict methods', async () => {
      expect(await runPython("list({'a': 1, 'b': 2}.keys())")).toEqual(['a', 'b']);
      expect(await runPython("list({'a': 1, 'b': 2}.values())")).toEqual([1, 2]);
      expect(await runPython("{'a': 1}.get('a')")).toBe(1);
      expect(await runPython("{'a': 1}.get('b', 0)")).toBe(0);
    });

    test('dict.get() with None values returns default', async () => {
      // When value is None and default is provided, return default
      expect(await runPython("{'a': None}.get('a', 0)")).toBe(0);
      expect(await runPython("{'a': None}.get('a', 'default')")).toBe('default');
      expect(await runPython("{'a': None}.get('a', [])")).toEqual([]);
      
      // When value is None and no default, return None
      expect(await runPython("{'a': None}.get('a')")).toBe(null);
      
      // When key doesn't exist, return default
      expect(await runPython("{'a': 1}.get('b', 0)")).toBe(0);
      expect(await runPython("{'a': 1}.get('b')")).toBe(null);
      
      // When value exists and is not None, return value regardless of default
      expect(await runPython("{'a': 1}.get('a', 0)")).toBe(1);
      expect(await runPython("{'a': 0}.get('a', 99)")).toBe(0);
      expect(await runPython("{'a': ''}.get('a', 'default')")).toBe('');
      expect(await runPython("{'a': False}.get('a', True)")).toBe(false);
    });

    test('dict.get() with None in data processing pattern', async () => {
      // This is the common pattern that caused the original bug
      const code = `
data = [
    {'name': 'Alice', 'amount': 100},
    {'name': 'Bob', 'amount': None},
    {'name': 'Charlie', 'amount': 50}
]

total = 0
for item in data:
    total = total + item.get('amount', 0)
total
`;
      expect(await runPython(code)).toBe(150);
    });

    test('in operator', async () => {
      expect(await runPython("'a' in {'a': 1}")).toBe(true);
      expect(await runPython("'b' in {'a': 1}")).toBe(false);
    });
  });

  describe('Comparisons', () => {
    test('equality', async () => {
      expect(await runPython('1 == 1')).toBe(true);
      expect(await runPython('1 == 2')).toBe(false);
      expect(await runPython('1 != 2')).toBe(true);
    });

    test('ordering', async () => {
      expect(await runPython('1 < 2')).toBe(true);
      expect(await runPython('2 > 1')).toBe(true);
      expect(await runPython('1 <= 1')).toBe(true);
      expect(await runPython('1 >= 1')).toBe(true);
    });

    test('chained comparison', async () => {
      expect(await runPython('1 < 2 < 3')).toBe(true);
      expect(await runPython('1 < 2 > 3')).toBe(false);
      expect(await runPython('0 <= 5 <= 10')).toBe(true);
    });

    test('in operator', async () => {
      expect(await runPython('1 in [1, 2, 3]')).toBe(true);
      expect(await runPython('4 in [1, 2, 3]')).toBe(false);
      expect(await runPython('"a" in "abc"')).toBe(true);
    });

    test('not in operator', async () => {
      expect(await runPython('4 not in [1, 2, 3]')).toBe(true);
      expect(await runPython('1 not in [1, 2, 3]')).toBe(false);
    });

    test('is None', async () => {
      expect(await runPython('None is None')).toBe(true);
      expect(await runPython('x = None\nx is None')).toBe(true);
      expect(await runPython('1 is None')).toBe(false);
      expect(await runPython('"" is None')).toBe(false);
      expect(await runPython('[] is None')).toBe(false);
    });

    test('is not None', async () => {
      expect(await runPython('None is not None')).toBe(false);
      expect(await runPython('x = None\nx is not None')).toBe(false);
      expect(await runPython('1 is not None')).toBe(true);
      expect(await runPython('"hello" is not None')).toBe(true);
      expect(await runPython('[1, 2] is not None')).toBe(true);
    });

    test('is with other values', async () => {
      // For non-None values, 'is' falls back to equality in our simplified implementation
      expect(await runPython('1 is 1')).toBe(true);
      expect(await runPython('"a" is "a"')).toBe(true);
      expect(await runPython('True is True')).toBe(true);
      expect(await runPython('False is False')).toBe(true);
    });

    test('is not with other values', async () => {
      expect(await runPython('1 is not 2')).toBe(true);
      expect(await runPython('"a" is not "b"')).toBe(true);
      expect(await runPython('True is not False')).toBe(true);
    });

    test('is in if condition', async () => {
      expect(await runPython(`
x = None
if x is None:
    result = "was none"
else:
    result = "was not none"
result
`)).toBe('was none');
    });

    test('is not in if condition', async () => {
      expect(await runPython(`
x = 5
if x is not None:
    result = "has value"
else:
    result = "no value"
result
`)).toBe('has value');
    });

    test('chained is comparisons', async () => {
      expect(await runPython('None is None is None')).toBe(true);
    });
  });

  describe('Boolean Operations', () => {
    test('and', async () => {
      expect(await runPython('True and True')).toBe(true);
      expect(await runPython('True and False')).toBe(false);
    });

    test('or', async () => {
      expect(await runPython('True or False')).toBe(true);
      expect(await runPython('False or False')).toBe(false);
    });

    test('not', async () => {
      expect(await runPython('not True')).toBe(false);
      expect(await runPython('not False')).toBe(true);
    });

    test('short-circuit evaluation', async () => {
      expect(await runPython('False and undefined_var')).toBe(false);
      expect(await runPython('True or undefined_var')).toBe(true);
    });

    test('truthiness', async () => {
      expect(await runPython('bool(0)')).toBe(false);
      expect(await runPython('bool(1)')).toBe(true);
      expect(await runPython('bool("")')).toBe(false);
      expect(await runPython('bool("a")')).toBe(true);
      expect(await runPython('bool([])')).toBe(false);
      expect(await runPython('bool([1])')).toBe(true);
    });
  });

  describe('Control Flow', () => {
    test('if statement', async () => {
      expect(await runPython(`
x = 10
if x > 5:
    result = 'big'
else:
    result = 'small'
result
`)).toBe('big');
    });

    test('if-elif-else', async () => {
      expect(await runPython(`
x = 5
if x > 10:
    result = 'big'
elif x > 3:
    result = 'medium'
else:
    result = 'small'
result
`)).toBe('medium');
    });

    test('for loop', async () => {
      expect(await runPython(`
total = 0
for i in range(5):
    total += i
total
`)).toBe(10);
    });

    test('for loop over list', async () => {
      expect(await runPython(`
items = [1, 2, 3, 4, 5]
total = 0
for item in items:
    total += item
total
`)).toBe(15);
    });

    test('for loop over string', async () => {
      expect(await runPython(`
result = []
for c in "abc":
    result.append(c)
result
`)).toEqual(['a', 'b', 'c']);
    });

    test('for loop over dict', async () => {
      expect(await runPython(`
d = {'a': 1, 'b': 2}
keys = []
for k in d:
    keys.append(k)
keys
`)).toEqual(['a', 'b']);
    });

    test('tuple unpacking in for loop', async () => {
      expect(await runPython(`
pairs = [(1, 2), (3, 4), (5, 6)]
sums = []
for a, b in pairs:
    sums.append(a + b)
sums
`)).toEqual([3, 7, 11]);
    });

    test('tuple unpacking with enumerate', async () => {
      expect(await runPython(`
items = ['a', 'b', 'c']
result = []
for i, item in enumerate(items):
    result.append((i, item))
result
`)).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
    });

    test('tuple unpacking with dict.items()', async () => {
      expect(await runPython(`
d = {'x': 10, 'y': 20}
result = []
for k, v in d.items():
    result.append(k + '=' + str(v))
result
`)).toEqual(['x=10', 'y=20']);
    });

    test('tuple unpacking with zip', async () => {
      expect(await runPython(`
a = [1, 2, 3]
b = [4, 5, 6]
result = []
for x, y in zip(a, b):
    result.append(x * y)
result
`)).toEqual([4, 10, 18]);
    });

    test('nested tuple unpacking', async () => {
      expect(await runPython(`
data = [((1, 2), 3), ((4, 5), 6)]
result = []
for (a, b), c in data:
    result.append(a + b + c)
result
`)).toEqual([6, 15]);
    });

    test('while loop', async () => {
      expect(await runPython(`
x = 5
total = 0
while x > 0:
    total += x
    x -= 1
total
`)).toBe(15);
    });

    test('break', async () => {
      expect(await runPython(`
result = 0
for i in range(10):
    if i == 5:
        break
    result = i
result
`)).toBe(4);
    });

    test('continue', async () => {
      expect(await runPython(`
total = 0
for i in range(5):
    if i == 2:
        continue
    total += i
total
`)).toBe(8);
    });
  });

  describe('Functions', () => {
    test('simple function', async () => {
      expect(await runPython(`
def double(x):
    return x * 2
double(21)
`)).toBe(42);
    });

    test('function with multiple parameters', async () => {
      expect(await runPython(`
def add(a, b):
    return a + b
add(3, 4)
`)).toBe(7);
    });

    test('function with default parameter', async () => {
      expect(await runPython(`
def greet(name, greeting="Hello"):
    return greeting + " " + name
greet("World")
`)).toBe('Hello World');
    });

    test('function with default parameter overridden', async () => {
      expect(await runPython(`
def greet(name, greeting="Hello"):
    return greeting + " " + name
greet("World", "Hi")
`)).toBe('Hi World');
    });

    test('recursive function', async () => {
      expect(await runPython(`
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)
factorial(5)
`)).toBe(120);
    });

    test('closure', async () => {
      expect(await runPython(`
def make_adder(n):
    def adder(x):
        return x + n
    return adder
add5 = make_adder(5)
add5(10)
`)).toBe(15);
    });
  });

  describe('List Comprehensions', () => {
    test('simple comprehension', async () => {
      expect(await runPython('[x * 2 for x in range(5)]')).toEqual([0, 2, 4, 6, 8]);
    });

    test('comprehension with condition', async () => {
      expect(await runPython('[x for x in range(10) if x % 2 == 0]')).toEqual([0, 2, 4, 6, 8]);
    });

    test('comprehension over list', async () => {
      expect(await runPython('[x.upper() for x in ["a", "b", "c"]]')).toEqual(['A', 'B', 'C']);
    });

    test('tuple unpacking in comprehension target', async () => {
      expect(await runPython(`
items = [(1, 2), (3, 4)]
[v for k, v in items]
`)).toEqual([2, 4]);
    });

    test('nested comprehension', async () => {
      expect(await runPython('[[i * j for j in range(3)] for i in range(3)]')).toEqual([
        [0, 0, 0],
        [0, 1, 2],
        [0, 2, 4],
      ]);
    });
  });

  describe('Generator Expressions', () => {
    test('generator expression works with list()', async () => {
      expect(await runPython(`
list(x for x in [1, 2, 3] if x > 1)
`)).toEqual([2, 3]);
    });

    test('generator expression works in join()', async () => {
      expect(await runPython(`
s = "a1.2b"
"".join(c for c in s if c.isdigit() or c == ".")
`)).toBe('1.2');
    });

    test('parenthesized generator expression produces iterator', async () => {
      expect(await runPython(`
g = (x for x in [1, 2, 3])
list(g)
`)).toEqual([1, 2, 3]);
    });

    test('multiple generators in generator expression', async () => {
      expect(await runPython(`
list(x * y for x in [1, 2] for y in [10, 20])
`)).toEqual([10, 20, 20, 40]);
    });
  });

  describe('Dict Comprehensions', () => {
    test('simple dict comprehension', async () => {
      expect(await runPython('{x: x * 2 for x in range(3)}')).toEqual({ 0: 0, 1: 2, 2: 4 });
    });

    test('tuple unpacking in dict comprehension target', async () => {
      expect(await runPython(`
items = [(1, 2), (3, 4)]
{k: v for k, v in items}
`)).toEqual({ 1: 2, 3: 4 });
    });
  });

  describe('Ternary Expression', () => {
    test('simple ternary', async () => {
      expect(await runPython('"yes" if True else "no"')).toBe('yes');
      expect(await runPython('"yes" if False else "no"')).toBe('no');
    });

    test('ternary with expression', async () => {
      expect(await runPython('x = 5\n"big" if x > 3 else "small"')).toBe('big');
    });
  });

  describe('Walrus Operator', () => {
    test('simple assignment expression', async () => {
      expect(await runPython('(x := 5)')).toBe(5);
      expect(await runPython('(x := 5) + x')).toBe(10);
    });

    test('in if condition', async () => {
      expect(await runPython(`
data = [1, 2, 3, 4, 5]
if (n := len(data)) > 3:
    result = f"List has {n} items"
else:
    result = "Small list"
result
`)).toBe('List has 5 items');
    });

    test('in while loop', async () => {
      // 0 + 1 + 2 + 3 + 4 = 10
      expect(await runPython(`
count = 0
total = 0
while (n := count) < 5:
    total += n
    count += 1
total
`)).toBe(10);
    });

    test('in list comprehension condition', async () => {
      expect(await runPython(`
data = ["", "hello", "", "world"]
[upper for s in data if (upper := s.upper())]
`)).toEqual(['HELLO', 'WORLD']);
    });

    test('chained walrus', async () => {
      expect(await runPython('(a := (b := 3) + 1)')).toBe(4);
      expect(await runPython(`
(a := (b := 3) + 1)
(a, b)
`)).toEqual([4, 3]);
    });
  });

  describe('Built-in Functions', () => {
    test('len', async () => {
      expect(await runPython('len([1, 2, 3])')).toBe(3);
      expect(await runPython('len("hello")')).toBe(5);
      expect(await runPython("len({'a': 1, 'b': 2})")).toBe(2);
    });

    test('sum', async () => {
      expect(await runPython('sum([1, 2, 3, 4, 5])')).toBe(15);
      expect(await runPython('sum([1, 2, 3], 10)')).toBe(16);
      // Generator expressions evaluate to an internal `iterator` type; sum() should support that.
      expect(await runPython('sum(x for x in [1, 2, 3, 4, 5])')).toBe(15);
      // range() returns an iterator in this interpreter; sum() should work with it too.
      expect(await runPython('sum(range(5))')).toBe(10);
    });

    test('range', async () => {
      expect(await runPython('list(range(5))')).toEqual([0, 1, 2, 3, 4]);
      expect(await runPython('list(range(2, 5))')).toEqual([2, 3, 4]);
      expect(await runPython('list(range(0, 10, 2))')).toEqual([0, 2, 4, 6, 8]);
      expect(await runPython('list(range(5, 0, -1))')).toEqual([5, 4, 3, 2, 1]);
    });

    test('min/max', async () => {
      expect(await runPython('min([3, 1, 2])')).toBe(1);
      expect(await runPython('max([3, 1, 2])')).toBe(3);
      expect(await runPython('min(3, 1, 2)')).toBe(1);
      expect(await runPython('max(3, 1, 2)')).toBe(3);
    });

    test('abs', async () => {
      expect(await runPython('abs(-5)')).toBe(5);
      expect(await runPython('abs(5)')).toBe(5);
    });

    test('round', async () => {
      expect(await runPython('round(3.7)')).toBe(4);
      expect(await runPython('round(3.14159, 2)')).toBe(3.14);
    });

    test('sorted', async () => {
      expect(await runPython('sorted([3, 1, 2])')).toEqual([1, 2, 3]);
      expect(await runPython('sorted([3, 1, 2], reverse=True)')).toEqual([3, 2, 1]);
    });

    test('sorted with key function', async () => {
      // Sort by field in dict
      expect(await runPython(`
expenses = [
    {'name': 'rent', 'amount': 1000},
    {'name': 'food', 'amount': 300},
    {'name': 'utilities', 'amount': 150}
]
sorted(expenses, key=lambda x: x['amount'])
`)).toEqual([
        { name: 'utilities', amount: 150 },
        { name: 'food', amount: 300 },
        { name: 'rent', amount: 1000 },
      ]);
      
      // Sort descending
      expect(await runPython(`
items = [{'value': 5}, {'value': 2}, {'value': 8}]
sorted(items, key=lambda x: x['value'], reverse=True)
`)).toEqual([
        { value: 8 },
        { value: 5 },
        { value: 2 },
      ]);
    });

    test('min/max with key function', async () => {
      // Find max by field
      expect(await runPython(`
invoices = [
    {'id': 1, 'amount': 500},
    {'id': 2, 'amount': 1200},
    {'id': 3, 'amount': 300}
]
max(invoices, key=lambda x: x['amount'])
`)).toEqual({ id: 2, amount: 1200 });

      // Find min by field
      expect(await runPython(`
items = [{'name': 'a', 'price': 50}, {'name': 'b', 'price': 20}, {'name': 'c', 'price': 80}]
min(items, key=lambda x: x['price'])
`)).toEqual({ name: 'b', price: 20 });
    });

    test('reversed', async () => {
      expect(await runPython('list(reversed([1, 2, 3]))')).toEqual([3, 2, 1]);
    });

    test('enumerate', async () => {
      expect(await runPython('list(enumerate(["a", "b", "c"]))')).toEqual([
        [0, 'a'],
        [1, 'b'],
        [2, 'c'],
      ]);
    });

    test('zip', async () => {
      expect(await runPython('list(zip([1, 2], ["a", "b"]))')).toEqual([
        [1, 'a'],
        [2, 'b'],
      ]);
    });

    test('type conversions', async () => {
      expect(await runPython('int("42")')).toBe(42);
      expect(await runPython('float("3.14")')).toBe(3.14);
      expect(await runPython('str(42)')).toBe('42');
      expect(await runPython('list("abc")')).toEqual(['a', 'b', 'c']);
    });

    test('any/all', async () => {
      expect(await runPython('any([False, False, True])')).toBe(true);
      expect(await runPython('any([False, False, False])')).toBe(false);
      expect(await runPython('all([True, True, True])')).toBe(true);
      expect(await runPython('all([True, False, True])')).toBe(false);
    });

    test('map with lambda', async () => {
      expect(await runPython('list(map(lambda x: x * 2, [1, 2, 3]))')).toEqual([2, 4, 6]);
      expect(await runPython('list(map(lambda x: x.upper(), ["a", "b", "c"]))')).toEqual(['A', 'B', 'C']);
      expect(await runPython('list(map(lambda x: x + 1, range(3)))')).toEqual([1, 2, 3]);
    });

    test('map with function', async () => {
      expect(await runPython(`
def double(x):
    return x * 2
list(map(double, [1, 2, 3]))
`)).toEqual([2, 4, 6]);
    });

    test('filter with lambda', async () => {
      expect(await runPython('list(filter(lambda x: x > 2, [1, 2, 3, 4, 5]))')).toEqual([3, 4, 5]);
      expect(await runPython('list(filter(lambda x: x % 2 == 0, [1, 2, 3, 4, 5]))')).toEqual([2, 4]);
    });

    test('filter with None (truthiness)', async () => {
      expect(await runPython('list(filter(None, [0, 1, "", "a", [], [1]]))')).toEqual([1, 'a', [1]]);
    });

    test('filter with function', async () => {
      expect(await runPython(`
def is_even(x):
    return x % 2 == 0
list(filter(is_even, [1, 2, 3, 4, 5]))
`)).toEqual([2, 4]);
    });

    test('map and filter combined', async () => {
      expect(await runPython(`
numbers = [1, 2, 3, 4, 5]
doubled = list(map(lambda x: x * 2, numbers))
evens = list(filter(lambda x: x > 4, doubled))
evens
`)).toEqual([6, 8, 10]);
    });
  });

  describe('Print', () => {
    test('captures print output', async () => {
      const output: string[] = [];
      const interpreter = createInterpreter({
        onPrint: (s) => output.push(s),
      });
      await interpreter.run('print("hello")\nprint("world")');
      expect(output).toEqual(['hello', 'world']);
    });
  });

  describe('Error Handling', () => {
    test('undefined variable', async () => {
      await expect(runPython('undefined_var')).rejects.toThrow("name 'undefined_var' is not defined");
    });

    test('division by zero', async () => {
      await expect(runPython('1 / 0')).rejects.toThrow('division by zero');
    });

    test('index out of range', async () => {
      await expect(runPython('[1, 2, 3][10]')).rejects.toThrow('list index out of range');
    });

    test('key error', async () => {
      await expect(runPython("{'a': 1}['b']")).rejects.toThrow("KeyError: 'b'");
    });

    test('type error', async () => {
      await expect(runPython('"hello" + 5')).rejects.toThrow('can only concatenate str (not "int") to str');
      await expect(runPython('5 + "hello"')).rejects.toThrow("unsupported operand type(s) for +: 'int' and 'str'");
    });
  });

  describe('Try/Except', () => {
    test('bare except catches all errors', async () => {
      expect(await runPython(`
result = "no error"
try:
    x = undefined_var
except:
    result = "caught"
result
`)).toBe('caught');
    });

    test('except with type catches specific error', async () => {
      expect(await runPython(`
result = "no error"
try:
    x = 1 / 0
except ZeroDivisionError:
    result = "division error"
result
`)).toBe('division error');
    });

    test('except with as binds error message', async () => {
      expect(await runPython(`
result = ""
try:
    x = 1 / 0
except ZeroDivisionError as e:
    result = e
result
`)).toBe('division by zero');
    });

    test('multiple except handlers', async () => {
      expect(await runPython(`
result = ""
try:
    d = {}
    x = d['missing']
except ZeroDivisionError:
    result = "div error"
except KeyError:
    result = "key error"
result
`)).toBe('key error');
    });

    test('finally always runs after success', async () => {
      expect(await runPython(`
result = []
try:
    result.append("try")
except:
    result.append("except")
finally:
    result.append("finally")
result
`)).toEqual(['try', 'finally']);
    });

    test('finally runs after exception', async () => {
      expect(await runPython(`
result = []
try:
    result.append("try")
    x = 1 / 0
except:
    result.append("except")
finally:
    result.append("finally")
result
`)).toEqual(['try', 'except', 'finally']);
    });

    test('unhandled exception still runs finally', async () => {
      await expect(runPython(`
result = []
try:
    x = 1 / 0
except KeyError:
    result.append("wrong handler")
finally:
    result.append("finally")
result
`)).rejects.toThrow('division by zero');
    });

    test('try-finally without except', async () => {
      expect(await runPython(`
result = []
try:
    result.append("try")
finally:
    result.append("finally")
result
`)).toEqual(['try', 'finally']);
    });

    test('Exception catches all errors', async () => {
      expect(await runPython(`
result = "no error"
try:
    x = undefined_var
except Exception:
    result = "caught"
result
`)).toBe('caught');
    });

    test('nested try/except', async () => {
      expect(await runPython(`
result = []
try:
    try:
        x = 1 / 0
    except ZeroDivisionError:
        result.append("inner")
        y = undefined_var
except NameError:
    result.append("outer")
result
`)).toEqual(['inner', 'outer']);
    });

    test('except tuple catches either exception type', async () => {
      expect(await runPython(`
result = "no error"
try:
    x = "hello" + 5
except (ZeroDivisionError, TypeError):
    result = "caught"
result
`)).toBe('caught');
    });

    test('except tuple supports trailing comma', async () => {
      expect(await runPython(`
result = "no error"
try:
    x = 1 / 0
except (ZeroDivisionError, TypeError,):
    result = "caught"
result
`)).toBe('caught');
    });
  });

  describe('Sets', () => {
    test('empty set creation', async () => {
      expect(await runPython('set()')).toEqual([]);
    });

    test('set from list', async () => {
      const result = await runPython('set([1, 2, 3])');
      expect(result.sort()).toEqual([1, 2, 3]);
    });

    test('set removes duplicates', async () => {
      const result = await runPython('set([1, 2, 2, 3, 3, 3])');
      expect(result.sort()).toEqual([1, 2, 3]);
    });

    test('set from string', async () => {
      const result = await runPython('set("hello")');
      expect(result.sort()).toEqual(['e', 'h', 'l', 'o']);
    });

    test('len of set', async () => {
      expect(await runPython('len(set([1, 2, 3]))')).toBe(3);
      expect(await runPython('len(set())')).toBe(0);
    });

    test('in operator', async () => {
      expect(await runPython('1 in set([1, 2, 3])')).toBe(true);
      expect(await runPython('4 in set([1, 2, 3])')).toBe(false);
      expect(await runPython('"a" in set(["a", "b"])')).toBe(true);
    });

    test('not in operator', async () => {
      expect(await runPython('4 not in set([1, 2, 3])')).toBe(true);
      expect(await runPython('1 not in set([1, 2, 3])')).toBe(false);
    });

    test('set.add', async () => {
      const result = await runPython(`
s = set([1, 2])
s.add(3)
s
`);
      expect(result.sort()).toEqual([1, 2, 3]);
    });

    test('set.add duplicate', async () => {
      const result = await runPython(`
s = set([1, 2])
s.add(2)
len(s)
`);
      expect(result).toBe(2);
    });

    test('set.remove', async () => {
      const result = await runPython(`
s = set([1, 2, 3])
s.remove(2)
s
`);
      expect(result.sort()).toEqual([1, 3]);
    });

    test('set.remove raises KeyError', async () => {
      await expect(runPython(`
s = set([1, 2, 3])
s.remove(5)
`)).rejects.toThrow('KeyError');
    });

    test('set.discard', async () => {
      const result = await runPython(`
s = set([1, 2, 3])
s.discard(2)
s
`);
      expect(result.sort()).toEqual([1, 3]);
    });

    test('set.discard missing element does not raise', async () => {
      const result = await runPython(`
s = set([1, 2, 3])
s.discard(5)
len(s)
`);
      expect(result).toBe(3);
    });

    test('set.pop', async () => {
      const result = await runPython(`
s = set([1])
x = s.pop()
(x, len(s))
`);
      expect(result).toEqual([1, 0]);
    });

    test('set.pop from empty raises KeyError', async () => {
      await expect(runPython(`
s = set()
s.pop()
`)).rejects.toThrow('KeyError');
    });

    test('set.clear', async () => {
      expect(await runPython(`
s = set([1, 2, 3])
s.clear()
len(s)
`)).toBe(0);
    });

    test('set.copy', async () => {
      const result = await runPython(`
s1 = set([1, 2, 3])
s2 = s1.copy()
s1.add(4)
len(s2)
`);
      expect(result).toBe(3);
    });

    test('set.update', async () => {
      const result = await runPython(`
s = set([1, 2])
s.update([3, 4])
s
`);
      expect(result.sort()).toEqual([1, 2, 3, 4]);
    });

    test('set.union', async () => {
      const result = await runPython(`
s1 = set([1, 2, 3])
s2 = set([3, 4, 5])
s1.union(s2)
`);
      expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    test('set.intersection', async () => {
      const result = await runPython(`
s1 = set([1, 2, 3])
s2 = set([2, 3, 4])
s1.intersection(s2)
`);
      expect(result.sort()).toEqual([2, 3]);
    });

    test('set.difference', async () => {
      const result = await runPython(`
s1 = set([1, 2, 3])
s2 = set([2, 3, 4])
s1.difference(s2)
`);
      expect(result).toEqual([1]);
    });

    test('set.symmetric_difference', async () => {
      const result = await runPython(`
s1 = set([1, 2, 3])
s2 = set([2, 3, 4])
s1.symmetric_difference(s2)
`);
      expect(result.sort()).toEqual([1, 4]);
    });

    test('set.issubset', async () => {
      expect(await runPython('set([1, 2]).issubset(set([1, 2, 3]))')).toBe(true);
      expect(await runPython('set([1, 2, 3]).issubset(set([1, 2]))')).toBe(false);
      expect(await runPython('set([1, 2]).issubset(set([1, 2]))')).toBe(true);
    });

    test('set.issuperset', async () => {
      expect(await runPython('set([1, 2, 3]).issuperset(set([1, 2]))')).toBe(true);
      expect(await runPython('set([1, 2]).issuperset(set([1, 2, 3]))')).toBe(false);
      expect(await runPython('set([1, 2]).issuperset(set([1, 2]))')).toBe(true);
    });

    test('set.isdisjoint', async () => {
      expect(await runPython('set([1, 2]).isdisjoint(set([3, 4]))')).toBe(true);
      expect(await runPython('set([1, 2]).isdisjoint(set([2, 3]))')).toBe(false);
    });

    test('iterate over set', async () => {
      const result = await runPython(`
s = set([1, 2, 3])
items = []
for x in s:
    items.append(x)
items
`);
      expect(result.sort()).toEqual([1, 2, 3]);
    });

    test('list from set', async () => {
      const result = await runPython('list(set([3, 1, 2]))');
      expect(result.sort()).toEqual([1, 2, 3]);
    });

    test('set truthiness', async () => {
      expect(await runPython('bool(set())')).toBe(false);
      expect(await runPython('bool(set([1]))')).toBe(true);
    });

    test('set equality', async () => {
      expect(await runPython('set([1, 2, 3]) == set([3, 2, 1])')).toBe(true);
      expect(await runPython('set([1, 2]) == set([1, 2, 3])')).toBe(false);
    });

    test('unhashable type error', async () => {
      await expect(runPython('set([[1, 2]])')).rejects.toThrow('unhashable type');
    });

    test('set with strings', async () => {
      const result = await runPython(`
customers = set()
customers.add("Alice")
customers.add("Bob")
customers.add("Alice")
len(customers)
`);
      expect(result).toBe(2);
    });

    test('set for deduplication pattern', async () => {
      const result = await runPython(`
items = [1, 2, 2, 3, 3, 3, 4]
unique = list(set(items))
len(unique)
`);
      expect(result).toBe(4);
    });
  });

  describe('Max Iterations', () => {
    test('prevents infinite loops', async () => {
      const interpreter = createInterpreter({ maxIterations: 100 });
      await expect(interpreter.run(`
while True:
    x = 1
`)).rejects.toThrow('Maximum iterations exceeded');
    });
  });

  describe('F-strings', () => {
    test('simple variable', async () => {
      expect(await runPython('name = "World"\nf"Hello {name}"')).toBe('Hello World');
    });

    test('expression', async () => {
      expect(await runPython('a = 3\nb = 4\nf"Sum is {a + b}"')).toBe('Sum is 7');
    });

    test('method call', async () => {
      expect(await runPython('s = "hello"\nf"Upper: {s.upper()}"')).toBe('Upper: HELLO');
    });

    test('multiple expressions', async () => {
      expect(await runPython('x = 1\ny = 2\nf"{x} + {y} = {x + y}"')).toBe('1 + 2 = 3');
    });

    test('escaped braces', async () => {
      expect(await runPython('f"Braces: {{}}"')).toBe('Braces: {}');
    });

    test('no expressions', async () => {
      expect(await runPython('f"Just a string"')).toBe('Just a string');
    });

    test('with list', async () => {
      expect(await runPython('items = [1, 2, 3]\nf"Items: {items}"')).toBe('Items: [1, 2, 3]');
    });

    test('with dict access', async () => {
      expect(await runPython(`
data = {'name': 'Alice', 'age': 30}
f"Name: {data['name']}, Age: {data['age']}"
`)).toBe('Name: Alice, Age: 30');
    });

    test('nested function call', async () => {
      expect(await runPython('numbers = [1, 2, 3, 4, 5]\nf"Sum: {sum(numbers)}"')).toBe('Sum: 15');
    });

    test('with comparison', async () => {
      expect(await runPython('x = 10\nf"x > 5: {x > 5}"')).toBe('x > 5: True');
    });
  });
});
