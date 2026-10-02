/**
 * The whitelisted `statistics` module: mean, median, mode, spread, quantiles.
 *
 * CPython computes these with exact fractions. The mean here is exact too;
 * the spread uses a corrected two-pass sum of squares, which agrees with
 * CPython on ordinary data but can differ in the last digit.
 * Pure computation, no state: the module object is a process-wide singleton.
 */

import { StatisticsError, TypeError, ValueError } from './errors';
import { PyFloat, floatParts, intTrueDiv, isIntLike, isNum, toFloat } from './numbers';
import {
  HashKey, PyBuiltin, PyList, PyModule, PyValue, exceptionType, hashKey, andThen, typeName,
} from './values';

interface Data {
  values: number[];
  /** True when every element was an int or bool: exact results stay ints. */
  allInt: boolean;
}

function toData(items: PyValue[]): Data {
  let allInt = true;
  const values = items.map((el) => {
    if (!isNum(el)) throw new TypeError(`can't convert type '${typeName(el)}' to numerator/denominator`);
    if (!isIntLike(el)) allInt = false;
    return toFloat(el);
  });
  return { values, allInt };
}

/** An exact result of int data is an int, like CPython; anything else a float. */
function result(value: number, data: Data): PyValue {
  return data.allInt && Number.isSafeInteger(value) ? value : new PyFloat(value);
}

/** The mean as CPython computes it: the exact sum of the values divided by
 *  their count, rounded once. `mean([19.99, 5.49, 3.5])` is 9.66. */
function mean(xs: number[]): number {
  if (!xs.every(Number.isFinite)) return xs.reduce((acc, x) => acc + x, 0) / xs.length;
  const parts = xs.map(floatParts);
  const scale = Math.min(...parts.map(([, exponent]) => exponent));
  let sum = 0n;
  for (const [mantissa, exponent] of parts) sum += mantissa << BigInt(exponent - scale);
  const count = BigInt(xs.length);
  if (sum === 0n) return 0;
  return scale >= 0 ? intTrueDiv(sum << BigInt(scale), count) : intTrueDiv(sum, count << BigInt(-scale));
}

/** Corrected two-pass sum of squared deviations, as CPython computes it. */
function sumSquaredDeviations(xs: number[]): number {
  const c = mean(xs);
  let ss = 0;
  let compensation = 0;
  for (const x of xs) {
    ss += (x - c) ** 2;
    compensation += x - c;
  }
  return ss - compensation ** 2 / xs.length;
}

function fn(name: string, impl: (data: Data) => PyValue): PyBuiltin {
  return new PyBuiltin(name, (rt, args) => andThen(rt.collect(args[0]), (items) => impl(toData(items))));
}

function requirePoints(data: Data, min: number, message: string): void {
  if (data.values.length < min) throw new StatisticsError(message);
}

function createStatisticsModule(): PyModule {
  const attrs = new Map<string, PyValue>([
    ['mean', fn('mean', (data) => {
      requirePoints(data, 1, 'mean requires at least one data point');
      return result(mean(data.values), data);
    })],

    ['median', fn('median', (data) => {
      requirePoints(data, 1, 'no median for empty data');
      const sorted = [...data.values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      // The middle element keeps its type; the average of two is a float.
      return sorted.length % 2 ? result(sorted[mid], data) : new PyFloat((sorted[mid - 1] + sorted[mid]) / 2);
    })],

    ['variance', fn('variance', (data) => {
      requirePoints(data, 2, 'variance requires at least two data points');
      return result(sumSquaredDeviations(data.values) / (data.values.length - 1), data);
    })],
    ['stdev', fn('stdev', (data) => {
      requirePoints(data, 2, 'variance requires at least two data points');
      return new PyFloat(Math.sqrt(sumSquaredDeviations(data.values) / (data.values.length - 1)));
    })],
    ['pvariance', fn('pvariance', (data) => {
      requirePoints(data, 1, 'pvariance requires at least one data point');
      return result(sumSquaredDeviations(data.values) / data.values.length, data);
    })],
    ['pstdev', fn('pstdev', (data) => {
      requirePoints(data, 1, 'pvariance requires at least one data point');
      return new PyFloat(Math.sqrt(sumSquaredDeviations(data.values) / data.values.length));
    })],
  ]);

  // mode works on any hashable values, for categorical data; ties go to the
  // first-encountered value, like CPython 3.8+.
  attrs.set('mode', new PyBuiltin('mode', (rt, args) => andThen(rt.collect(args[0]), (items) => {
    if (items.length === 0) throw new StatisticsError('no mode for empty data');
    const counts = new Map<HashKey, { value: PyValue; count: number }>();
    for (const item of items) {
      const key = hashKey(item);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { value: item, count: 1 });
    }
    let best: { value: PyValue; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    return best!.value;
  })));

  attrs.set('quantiles', new PyBuiltin('quantiles', (rt, args, kwargs) => andThen(rt.collect(args[0]), (items) => {
    const nArg = kwargs?.get('n') ?? 4;
    if (typeof nArg !== 'number') throw new TypeError('n must be an integer');
    const n = nArg;
    if (n < 1) throw new StatisticsError('n must be at least 1');
    const method = kwargs?.get('method') ?? 'exclusive';
    if (method !== 'exclusive' && method !== 'inclusive') {
      throw new ValueError(`Unknown method: '${typeof method === 'string' ? method : typeName(method)}'`);
    }
    const data = [...toData(items).values].sort((a, b) => a - b);
    const ld = data.length;
    if (ld < 2) throw new StatisticsError('must have at least two data points');

    // CPython 3.9's interpolation, both methods.
    const out: PyValue[] = [];
    if (method === 'inclusive') {
      const m = ld - 1;
      for (let i = 1; i < n; i++) {
        const j = Math.floor((i * m) / n);
        const delta = i * m - j * n;
        out.push(new PyFloat((data[j] * (n - delta) + data[j + 1] * delta) / n));
      }
    } else {
      const m = ld + 1;
      for (let i = 1; i < n; i++) {
        let j = Math.floor((i * m) / n);
        j = j < 1 ? 1 : j > ld - 1 ? ld - 1 : j;
        const delta = i * m - j * n;
        out.push(new PyFloat((data[j - 1] * (n - delta) + data[j] * delta) / n));
      }
    }
    return new PyList(out);
  }), true));

  attrs.set('StatisticsError', exceptionType(StatisticsError));

  return new PyModule('statistics', attrs);
}

export const statisticsModule: PyModule = createStatisticsModule();
