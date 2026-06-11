/**
 * The whitelisted `math` module.
 *
 * Thin wrappers over JavaScript's Math — which matches CPython on every
 * finite value — plus the domain/range checks CPython performs where JS
 * would silently return NaN or Infinity. Pure computation, no state: the
 * module object is a process-wide singleton.
 */

import { PyValue, PyBuiltin, PyModule, pyNumber, pyBoolean, isNumber, isBoolean } from './values';
import { extractKwargs } from './builtins';
import { TypeError, ValueError, ZeroDivisionError, OverflowError } from './errors';

function numArg(value: PyValue | undefined, fnName: string): number {
  if (value !== undefined) {
    if (isNumber(value)) return value.value;
    if (isBoolean(value)) return value.value ? 1 : 0;
  }
  throw new TypeError(`must be real number, not ${value === undefined ? 'NoneType' : value.type}`, 0, 0);
}

function domainError(): never {
  throw new ValueError('math domain error', 0, 0);
}

/** floor/ceil/trunc share CPython's float→int conversion errors. */
function toIntChecked(x: number, convert: (x: number) => number): PyValue {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) throw new ValueError('cannot convert float NaN to integer', 0, 0);
    throw new OverflowError('cannot convert float infinity to integer', 0, 0);
  }
  return pyNumber(convert(x));
}

function fn(name: string, impl: (...args: number[]) => number | PyValue, arity = 1): PyBuiltin {
  return {
    type: 'builtin',
    name: `math.${name}`,
    fn: (...args: PyValue[]) => {
      const nums: number[] = [];
      for (let i = 0; i < arity; i++) nums.push(numArg(args[i], name));
      const result = impl(...nums);
      return typeof result === 'number' ? pyNumber(result) : result;
    },
  };
}

function createMathModule(): PyModule {
  const attrs = new Map<string, PyValue>([
    ['pi', pyNumber(Math.PI)],
    ['e', pyNumber(Math.E)],
    ['tau', pyNumber(2 * Math.PI)],
    ['inf', pyNumber(Infinity)],
    ['nan', pyNumber(NaN)],

    ['sqrt', fn('sqrt', x => (x < 0 ? domainError() : Math.sqrt(x)))],
    ['floor', fn('floor', x => toIntChecked(x, Math.floor))],
    ['ceil', fn('ceil', x => toIntChecked(x, Math.ceil))],
    ['trunc', fn('trunc', x => toIntChecked(x, Math.trunc))],
    ['fabs', fn('fabs', Math.abs)],
    ['exp', fn('exp', x => {
      const result = Math.exp(x);
      if (result === Infinity && x !== Infinity) throw new OverflowError('math range error', 0, 0);
      return result;
    })],
    ['pow', fn('pow', (x, y) => {
      if (x === 0 && y < 0) domainError();
      const result = Math.pow(x, y);
      if (Number.isNaN(result) && !Number.isNaN(x) && !Number.isNaN(y)) domainError();
      return result;
    }, 2)],
    ['log10', fn('log10', x => (x <= 0 ? domainError() : Math.log10(x)))],
    ['log2', fn('log2', x => (x <= 0 ? domainError() : Math.log2(x)))],

    ['isnan', fn('isnan', x => pyBoolean(Number.isNaN(x)))],
    ['isinf', fn('isinf', x => pyBoolean(x === Infinity || x === -Infinity))],
    ['isfinite', fn('isfinite', x => pyBoolean(Number.isFinite(x)))],

    ['sin', fn('sin', Math.sin)],
    ['cos', fn('cos', Math.cos)],
    ['tan', fn('tan', Math.tan)],
    ['asin', fn('asin', x => (x < -1 || x > 1 ? domainError() : Math.asin(x)))],
    ['acos', fn('acos', x => (x < -1 || x > 1 ? domainError() : Math.acos(x)))],
    ['atan', fn('atan', Math.atan)],
    ['atan2', fn('atan2', Math.atan2, 2)],
    ['radians', fn('radians', x => (x * Math.PI) / 180)],
    ['degrees', fn('degrees', x => (x * 180) / Math.PI)],
  ]);

  // log(x) and log(x, base) — base 1 divides by log(1) == 0, like CPython.
  attrs.set('log', {
    type: 'builtin',
    name: 'math.log',
    fn: (xVal: PyValue, baseVal?: PyValue) => {
      const x = numArg(xVal, 'log');
      if (x <= 0) domainError();
      if (baseVal === undefined) return pyNumber(Math.log(x));
      const base = numArg(baseVal, 'log');
      if (base <= 0) domainError();
      if (Math.log(base) === 0) throw new ZeroDivisionError(0, 0);
      return pyNumber(Math.log(x) / Math.log(base));
    },
  });

  attrs.set('isclose', {
    type: 'builtin',
    name: 'math.isclose',
    acceptsKwargs: true,
    fn: (...rawArgs: any[]) => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const a = numArg(args[0], 'isclose');
      const b = numArg(args[1], 'isclose');
      const relTol = kwargs.rel_tol !== undefined ? numArg(kwargs.rel_tol, 'isclose') : 1e-9;
      const absTol = kwargs.abs_tol !== undefined ? numArg(kwargs.abs_tol, 'isclose') : 0.0;
      if (relTol < 0 || absTol < 0) throw new ValueError('tolerances must be non-negative', 0, 0);
      if (a === b) return pyBoolean(true);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return pyBoolean(false);
      return pyBoolean(Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol));
    },
  });

  return { type: 'module', name: 'math', attrs };
}

export const mathModule: PyModule = createMathModule();
