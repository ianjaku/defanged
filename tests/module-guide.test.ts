/**
 * The example from docs/modules.md, built from the package's public exports
 * only, so the guide cannot drift from what the API offers.
 */

import { describe, test, expect } from 'bun:test';
import {
  createInterpreter, IndexError, PyBuiltin, PyFloat, PyList, PyModule, PyObject, PyValue, Runtime, TypeError,
  andThen, exceptionType, defineException, namedType, pyRepr, typeName, ValueError,
} from '../src';

const MetricsError = defineException('MetricsError', ValueError);

class Series extends PyObject {
  readonly typeName = 'metrics.Series';
  constructor(readonly values: number[]) { super(); }
  length() { return this.values.length; }
  iterate() { return this.values; }
  getItem(key: PyValue) {
    if (typeof key !== 'number') throw new TypeError(`Series indices must be integers, not ${typeName(key)}`);
    const i = key < 0 ? key + this.values.length : key;
    if (i < 0 || i >= this.values.length) throw new IndexError('Series index out of range');
    return this.values[i];
  }
  getAttr(name: string) {
    if (name === 'values') return new PyList(this.values.slice());
    if (name === 'mean') return new PyBuiltin('mean', () => {
      if (this.values.length === 0) throw new MetricsError('mean of an empty Series');
      return new PyFloat(this.values.reduce((a, b) => a + b, 0) / this.values.length);
    });
    return undefined;
  }
  repr() { return `Series(${pyRepr(new PyList(this.values))})`; }
}

const T_SERIES = namedType('metrics.Series');
T_SERIES.construct = (rt: Runtime, args: PyValue[]) => andThen(rt.collect(args[0]), (items) => new Series(items.map(Number)));

function percent_change(_rt: Runtime, args: PyValue[]): PyValue {
  if (args.length !== 2) throw new TypeError(`percent_change() takes exactly 2 arguments (${args.length} given)`);
  const [before, after] = args;
  if (typeof before !== 'number' || typeof after !== 'number') {
    throw new TypeError(`percent_change() arguments must be numbers, not ${typeName(before)} and ${typeName(after)}`);
  }
  return new PyFloat(before === 0 ? 0 : ((after - before) / before) * 100);
}

const metrics = new PyModule('metrics', new Map<string, PyValue>([
  ['percent_change', new PyBuiltin('percent_change', percent_change)],
  ['Series', T_SERIES],
  ['MetricsError', exceptionType(MetricsError)],
  ['VERSION', '1.0'],
]));

describe('a module written against the public API', () => {
  const it = createInterpreter({ modules: [metrics], tools: { later: (v: number) => Promise.resolve(v) } });

  test('functions, constants and import forms', async () => {
    expect(await it.run('import metrics\nmetrics.percent_change(80, 100)')).toBe(25);
    expect(await it.run('from metrics import percent_change, VERSION\n(percent_change(0, 5), VERSION)')).toEqual([0, '1.0']);
    await expect(it.run('import metrics\nmetrics.percent_change("a", 1)')).rejects.toThrow('percent_change() arguments must be numbers, not str and int');
  });

  test('an object type: len, iteration, indexing, attributes, repr, isinstance', async () => {
    expect(await it.run('from metrics import Series\ns = Series([1, 2, 3])\n(len(s), list(s), sum(s), s[-1], s.values, s.mean(), repr(s), type(s).__name__, isinstance(s, Series), s in [s])'))
      .toEqual([3, [1, 2, 3], 6, 3, [1, 2, 3], 2, 'Series([1, 2, 3])', 'Series', true, true]);
    expect(await it.run('from metrics import Series\ntry:\n    Series([])[0]\nexcept IndexError as e:\n    str(e)')).toBe('Series index out of range');
    expect(await it.run('from metrics import Series\ntry:\n    Series([]).nope\nexcept AttributeError as e:\n    str(e)')).toBe("'metrics.Series' object has no attribute 'nope'");
  });

  test('a module exception can be caught by its name or its base', async () => {
    expect(await it.run('import metrics\ntry:\n    metrics.Series([]).mean()\nexcept metrics.MetricsError as e:\n    str(e)')).toBe('mean of an empty Series');
    expect(await it.run('import metrics\ntry:\n    metrics.Series([]).mean()\nexcept ValueError:\n    "base"')).toBe('base');
  });

  test('a constructor fed by a tool-driven generator waits like any built-in', async () => {
    expect(await it.run('from metrics import Series\nSeries(later(x) for x in [4, 5]).mean()')).toBe(4.5);
  });
});
