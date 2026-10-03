# Writing a module

A module is something a script can `import`. The six that ship with the package (`json`, `itertools`, `collections`, `functools`, `string`, `random`) are built with the API below, and so can yours: a `metrics` module with your company's formulas, a `table` module with the group-by and pivot you want the model to use instead of pandas. Everything here is exported from `defanged`. The names in this guide are the stable surface: they change only with a major version.

Two rules, the same ones the shipped modules follow. A module does pure computation; anything that reads the outside world goes through a tool, not a module. And a module behaves like CPython where CPython has an opinion: `len()` of your object, `repr()` of it, the error messages.

## The smallest module

```typescript
import { PyModule, PyBuiltin, TypeError, typeName, type PyValue } from "defanged";

function percent_change(_rt: unknown, args: PyValue[]): PyValue {
  if (args.length !== 2) throw new TypeError(`percent_change() takes exactly 2 arguments (${args.length} given)`);
  const [before, after] = args;
  if (typeof before !== "number" || typeof after !== "number") {
    throw new TypeError(`percent_change() arguments must be numbers, not ${typeName(before)} and ${typeName(after)}`);
  }
  return new PyFloat(before === 0 ? 0 : ((after - before) / before) * 100);
}

export const metrics = new PyModule("metrics", new Map<string, PyValue>([
  ["percent_change", new PyBuiltin("percent_change", percent_change)],
  ["VERSION", "1.0"],
]));
```

```typescript
createInterpreter({ modules: [metrics] });
// import metrics            -> works
// from metrics import *     -> works
// metrics.percent_change(80, 100)  -> 25.0
```

A `PyModule` is a name and a `Map` of attributes. Values in the map are Python values: a JS `string`, `number` (an `int`), `boolean`, `null` (`None`), a `PyFloat`, a `PyList`, a `PyDict`, a `PyBuiltin` (a function), a `PyType`, or an object of your own (below).

If your module keeps state (a counter, a cache, a generator), give `PyModule` a third argument, a function that builds a fresh copy; each interpreter then gets its own. `random` does this.

## Values

| Python | In TypeScript |
|---|---|
| `str`, `bool`, `None` | `string`, `boolean`, `null` |
| `int` | `number`, or `bigint` past 2^53 |
| `float` | `PyFloat` (`new PyFloat(2.5)`, read `.v`) |
| `list`, `tuple` | `PyList`, `PyTuple` (read `.items`) |
| `dict` | `PyDict`; use `dictGet`, `dictSet`, `dictHas`, `dictDelete`, never `.map` directly |
| `set`, `frozenset` | `PySet`, `PyFrozenSet`; `setAdd`, `setHas` |
| `datetime`, `date`, `timedelta` | `PyDateTime`, `PyDate`, `PyTimeDelta` |

`typeName(v)` is CPython's name for a value's type, for error messages. `pyRepr(v)` and `pyStr(v)` are `repr()` and `str()`. `truthy(v)` is `bool(v)`. `pyEquals(a, b)` is `==`. `hashKey(v)` is the key a dict would use, and throws CPython's `unhashable type` error.

`jsToValue(js)` and `valueToJs(v)` convert whole structures both ways (objects to dicts, arrays to lists, `Date` to `datetime`); they are what tool arguments and results go through, and the lazy way to build a module from plain JS.

## Functions

A built-in is `(rt, args, kwargs) => value`. `args` is an array of Python values, `kwargs` a `Map<string, PyValue>` or `null`. Pass `true` as the third `PyBuiltin` argument to accept keywords; without it, a call with keywords raises CPython's `takes no keyword arguments`.

Raise errors with the exported classes: `TypeError`, `ValueError`, `KeyError`, `IndexError`, `OverflowError`, `ZeroDivisionError`, and the rest of `EXCEPTION_CLASSES`. A new exception type is `defineException("MetricsError", ValueError)`; put `exceptionType(MetricsError)` in the module's attributes so scripts can `except metrics.MetricsError`.

### Calling back into Python

`rt` is the `Runtime`: `rt.call(fn, args)` calls a Python function or built-in, `rt.collect(iterable)` gives an iterable's items as an array, `rt.forEach(iterable, visit)` visits them, `rt.iter`/`rt.next` drive an iterator by hand.

Each of these returns either a value or a `Promise` of one. The promise case means the Python code it ran called a tool and the script is paused. A built-in must return that promise, or chain on it; a dropped one leaves frames behind. `andThen(value, fn)` applies `fn` now when the value is ready and after it resolves when it is not, so one code path serves both:

```typescript
function apply_all(rt: Runtime, args: PyValue[]): MA<PyValue> {
  const [fn, items] = args;
  return andThen(rt.collect(items), (list) => {
    const out: PyValue[] = [];
    const step = (i: number): MA<PyValue> => {
      for (; i < list.length; i++) {
        const r = rt.call(fn, [list[i]]);
        if (r instanceof Promise) return r.then((v) => { out.push(v); return step(i + 1); });
        out.push(r);
      }
      return new PyList(out);
    };
    return step(0);
  });
}
```

`MA<T>` is the type `T | Promise<T>`.

### Limits

Before building something large, call `rt.checkString(length)` or `rt.checkCollection(size)`. They raise `MemoryError` past the host's `limits`, which is how `"x" * 10**9` fails instead of taking the process down. `itertools.count` relies on this: `list(count())` stops at the collection limit.

## Objects

Extend `PyObject` for a value with its own behaviour. Override only what applies:

```typescript
class Series extends PyObject {
  readonly typeName = "metrics.Series";
  constructor(readonly values: number[]) { super(); }

  length() { return this.values.length; }                    // len(s)
  iterate() { return this.values; }                           // for x in s, list(s), sum(s)
  getItem(key: PyValue) {                                     // s[i]
    if (typeof key !== "number") throw new TypeError(`Series indices must be integers, not ${typeName(key)}`);
    const i = key < 0 ? key + this.values.length : key;
    if (i < 0 || i >= this.values.length) throw new IndexError("Series index out of range");
    return this.values[i];
  }
  getAttr(name: string) {                                     // s.mean(), s.values
    if (name === "values") return new PyList(this.values.slice());
    if (name === "mean") return new PyBuiltin("mean", () => new PyFloat(this.values.reduce((a, b) => a + b, 0) / this.values.length));
    return undefined;                                         // -> AttributeError
  }
  repr() { return `Series(${pyRepr(new PyList(this.values))})`; }
}
```

`typeName` is the type's qualified name: `type(s).__name__` is the part after the last dot, and error messages use the whole thing (`'metrics.Series' object has no attribute 'x'`), as CPython does for types defined in C modules. `compareTo(rt, other, op)` makes `<` and sorting work, as `functools.cmp_to_key` uses it. A `PyObject` is hashed by identity, so it can be a dict key.

To let scripts construct one, add a `PyType` to the module:

```typescript
const T_SERIES = namedType("metrics.Series");
T_SERIES.construct = (rt, args) => andThen(rt.collect(args[0]), (items) => new Series(items.map(Number)));
attrs.set("Series", T_SERIES);
// Series([1, 2, 3]), isinstance(s, metrics.Series), type(s) is metrics.Series
```

A `PyDict` or `PyTuple` subclass is the way to make something that *is* a dict or tuple with extras: `collections.Counter` and `namedtuple` are built that way, with the `pyType`, `extraMethods`, `missing`, `binaryOp`, `getAttr` and `reprWith` hooks on those classes.

## Iterators

A lazy iterator extends `PyIterator`: a `typeName` and `next(rt)` that returns the next item or `DONE`. The VM drives it from `for`, `list()`, `sum()` and the rest, and the loop budget counts each item, so an endless one cannot hang the script. `itertools` is nothing but these.

## Testing a module

Register it in a test and run Python against it, the way `tests/modules.test.ts` does. When CPython has a reference for the behaviour, the strongest test is a conformance case: a program whose output is recorded from CPython and compared.
