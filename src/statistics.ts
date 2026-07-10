/**
 * The whitelisted `statistics` module: mean, median, mode, spread, quantiles.
 *
 * Matches CPython's float results by using the same algorithms (two-pass
 * corrected sum-of-squares for variance, CPython 3.9's quantiles
 * interpolation). Pure computation, no state: the module object is a
 * process-wide singleton.
 */

import {
  PyValue,
  PyBuiltin,
  PyModule,
  pyNumber,
  pyString,
  pyList,
  isNumber,
  isString,
  isBoolean,
  isList,
  isTuple,
  isSet,
  setValues,
  pyTypeName,
} from './values';
import { extractKwargs } from './builtins';
import { TypeError, ValueError, StatisticsError } from './errors';

/** Raw element values of an iterable argument (list/tuple/set/iterator). */
function iterableElements(data: PyValue, caller: string): PyValue[] {
  if (isList(data) || isTuple(data)) return data.elements;
  if (data.type === 'iterator') return data.values;
  if (isSet(data)) {
    return setValues(data);
  }
  throw new TypeError(`${caller}: '${pyTypeName(data)}' object is not iterable`, 0, 0);
}

function extractData(data: PyValue, caller: string): number[] {
  return iterableElements(data, caller).map(el => {
    if (isNumber(el)) return el.value;
    if (isBoolean(el)) return el.value ? 1 : 0;
    throw new TypeError(`can't convert type '${el.type === 'string' ? 'str' : el.type}' to numerator/denominator`, 0, 0);
  });
}

function mean(xs: number[]): number {
  return xs.reduce((acc, x) => acc + x, 0) / xs.length;
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

function fn(name: string, impl: (xs: number[]) => number): PyBuiltin {
  return {
    type: 'builtin',
    name: `statistics.${name}`,
    fn: (data: PyValue) => pyNumber(impl(extractData(data, name))),
  };
}

function createStatisticsModule(): PyModule {
  const attrs = new Map<string, PyValue>([
    ['mean', fn('mean', xs => {
      if (xs.length === 0) throw new StatisticsError('mean requires at least one data point', 0, 0);
      return mean(xs);
    })],

    ['median', fn('median', xs => {
      if (xs.length === 0) throw new StatisticsError('no median for empty data', 0, 0);
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    })],

    ['variance', fn('variance', xs => {
      if (xs.length < 2) throw new StatisticsError('variance requires at least two data points', 0, 0);
      return sumSquaredDeviations(xs) / (xs.length - 1);
    })],
    ['stdev', fn('stdev', xs => {
      if (xs.length < 2) throw new StatisticsError('variance requires at least two data points', 0, 0);
      return Math.sqrt(sumSquaredDeviations(xs) / (xs.length - 1));
    })],
    ['pvariance', fn('pvariance', xs => {
      if (xs.length === 0) throw new StatisticsError('pvariance requires at least one data point', 0, 0);
      return sumSquaredDeviations(xs) / xs.length;
    })],
    ['pstdev', fn('pstdev', xs => {
      if (xs.length === 0) throw new StatisticsError('pvariance requires at least one data point', 0, 0);
      return Math.sqrt(sumSquaredDeviations(xs) / xs.length);
    })],
  ]);

  // mode works on raw values (numbers, strings, booleans) for categorical
  // data; ties go to the first-encountered value, like CPython 3.8+.
  attrs.set('mode', {
    type: 'builtin',
    name: 'statistics.mode',
    fn: (data: PyValue) => {
      const elements = iterableElements(data, 'mode');
      if (elements.length === 0) throw new StatisticsError('no mode for empty data', 0, 0);
      const counts = new Map<string, { value: PyValue; count: number }>();
      for (const el of elements) {
        if (!isNumber(el) && !isString(el) && !isBoolean(el)) {
          throw new TypeError(`unhashable type: '${pyTypeName(el)}'`, 0, 0);
        }
        const key = `${el.type}:${el.value}`;
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { value: el, count: 1 });
      }
      let best: { value: PyValue; count: number } | null = null;
      for (const entry of counts.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      return best!.value;
    },
  });

  attrs.set('quantiles', {
    type: 'builtin',
    name: 'statistics.quantiles',
    acceptsKwargs: true,
    fn: (...rawArgs: any[]) => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const n = kwargs.n !== undefined ? (isNumber(kwargs.n) ? kwargs.n.value : NaN) : 4;
      if (!Number.isInteger(n)) throw new TypeError('n must be an integer', 0, 0);
      if (n < 1) throw new StatisticsError('n must be at least 1', 0, 0);
      const method = kwargs.method !== undefined ? (isString(kwargs.method) ? kwargs.method.value : '') : 'exclusive';
      if (method !== 'exclusive' && method !== 'inclusive') {
        throw new ValueError(`Unknown method: '${method}'`, 0, 0);
      }
      const data = [...extractData(args[0], 'quantiles')].sort((a, b) => a - b);
      const ld = data.length;
      if (ld < 2) throw new StatisticsError('must have at least two data points', 0, 0);

      // CPython 3.9's interpolation, both methods.
      const result: PyValue[] = [];
      if (method === 'inclusive') {
        const m = ld - 1;
        for (let i = 1; i < n; i++) {
          const j = Math.floor((i * m) / n);
          const delta = i * m - j * n;
          result.push(pyNumber((data[j] * (n - delta) + data[j + 1] * delta) / n));
        }
      } else {
        const m = ld + 1;
        for (let i = 1; i < n; i++) {
          let j = Math.floor((i * m) / n);
          j = j < 1 ? 1 : j > ld - 1 ? ld - 1 : j;
          const delta = i * m - j * n;
          result.push(pyNumber((data[j - 1] * (n - delta) + data[j] * delta) / n));
        }
      }
      return pyList(result);
    },
  });

  // StatisticsError constructor, importable for raise/except — the same
  // tagged-string pattern as the global exception constructors.
  attrs.set('StatisticsError', {
    type: 'builtin',
    name: 'StatisticsError',
    fn: (msg?: PyValue): PyValue => {
      const message = msg ? (isString(msg) ? msg.value : String((msg as any).value ?? '')) : '';
      const val = pyString(message);
      (val as any).exceptionName = 'StatisticsError';
      (val as any).exceptionMessage = message;
      return val;
    },
  });

  return { type: 'module', name: 'statistics', attrs };
}

export const statisticsModule: PyModule = createStatisticsModule();
