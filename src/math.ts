/**
 * The whitelisted `math` module.
 *
 * Thin wrappers over JavaScript's Math — which matches CPython on every
 * finite value — plus the domain/range checks CPython performs where JS
 * would silently return NaN or Infinity. Pure computation, no state: the
 * module object is a process-wide singleton.
 */

import { OverflowError, TypeError, ValueError, ZeroDivisionError } from './errors';
import { PyFloat, floatToInt, isIntLike, isNum, toFloat } from './numbers';
import { PyBuiltin, PyModule, PyValue, typeName } from './values';

function numArg(value: PyValue | undefined): number {
  if (value !== undefined && isNum(value)) return toFloat(value);
  throw new TypeError(`must be real number, not ${value === undefined ? 'NoneType' : typeName(value)}`);
}

function domainError(): never {
  throw new ValueError('math domain error');
}

/** A function of `arity` real numbers whose result is a float. */
function fn(name: string, impl: (...args: number[]) => number, arity = 1): PyBuiltin {
  return new PyBuiltin(name, (_rt, args) => {
    const nums: number[] = [];
    for (let i = 0; i < arity; i++) nums.push(numArg(args[i]));
    return new PyFloat(impl(...nums));
  });
}

/** floor/ceil/trunc: float → int, and an int passes through unchanged. */
function toInt(name: string, convert: (x: number) => number): PyBuiltin {
  return new PyBuiltin(name, (_rt, args) => {
    const x = args[0];
    if (x !== undefined && isIntLike(x)) return typeof x === 'boolean' ? (x ? 1 : 0) : x;
    const value = numArg(x);
    if (Number.isNaN(value)) throw new ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(value)) throw new OverflowError('cannot convert float infinity to integer');
    return floatToInt(convert(value));
  });
}

function predicate(name: string, test: (x: number) => boolean): PyBuiltin {
  return new PyBuiltin(name, (_rt, args) => test(numArg(args[0])));
}

function createMathModule(): PyModule {
  const attrs = new Map<string, PyValue>([
    ['pi', new PyFloat(Math.PI)],
    ['e', new PyFloat(Math.E)],
    ['tau', new PyFloat(2 * Math.PI)],
    ['inf', new PyFloat(Infinity)],
    ['nan', new PyFloat(NaN)],

    ['sqrt', fn('sqrt', (x) => (x < 0 ? domainError() : Math.sqrt(x)))],
    ['floor', toInt('floor', Math.floor)],
    ['ceil', toInt('ceil', Math.ceil)],
    ['trunc', toInt('trunc', Math.trunc)],
    ['fabs', fn('fabs', Math.abs)],
    ['exp', fn('exp', (x) => {
      const result = Math.exp(x);
      if (result === Infinity && x !== Infinity) throw new OverflowError('math range error');
      return result;
    })],
    ['pow', fn('pow', (x, y) => {
      if (x === 0 && y < 0) domainError();
      const result = Math.pow(x, y);
      if (Number.isNaN(result) && !Number.isNaN(x) && !Number.isNaN(y)) domainError();
      return result;
    }, 2)],
    ['log10', fn('log10', (x) => (x <= 0 ? domainError() : Math.log10(x)))],
    ['log2', fn('log2', (x) => (x <= 0 ? domainError() : Math.log2(x)))],

    ['isnan', predicate('isnan', (x) => Number.isNaN(x))],
    ['isinf', predicate('isinf', (x) => x === Infinity || x === -Infinity)],
    ['isfinite', predicate('isfinite', (x) => Number.isFinite(x))],

    ['sin', fn('sin', Math.sin)],
    ['cos', fn('cos', Math.cos)],
    ['tan', fn('tan', Math.tan)],
    ['asin', fn('asin', (x) => (x < -1 || x > 1 ? domainError() : Math.asin(x)))],
    ['acos', fn('acos', (x) => (x < -1 || x > 1 ? domainError() : Math.acos(x)))],
    ['atan', fn('atan', Math.atan)],
    ['atan2', fn('atan2', Math.atan2, 2)],
    ['radians', fn('radians', (x) => (x * Math.PI) / 180)],
    ['degrees', fn('degrees', (x) => (x * 180) / Math.PI)],
  ]);

  // log(x) and log(x, base) — base 1 divides by log(1) == 0, like CPython.
  attrs.set('log', new PyBuiltin('log', (_rt, args) => {
    const x = numArg(args[0]);
    if (x <= 0) domainError();
    if (args[1] === undefined) return new PyFloat(Math.log(x));
    const base = numArg(args[1]);
    if (base <= 0) domainError();
    if (Math.log(base) === 0) throw new ZeroDivisionError();
    return new PyFloat(Math.log(x) / Math.log(base));
  }));

  attrs.set('isclose', new PyBuiltin('isclose', (_rt, args, kwargs) => {
    const a = numArg(args[0]);
    const b = numArg(args[1]);
    const relTol = kwargs?.has('rel_tol') ? numArg(kwargs.get('rel_tol')) : 1e-9;
    const absTol = kwargs?.has('abs_tol') ? numArg(kwargs.get('abs_tol')) : 0.0;
    if (relTol < 0 || absTol < 0) throw new ValueError('tolerances must be non-negative');
    if (a === b) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol);
  }, true));

  return new PyModule('math', attrs);
}

export const mathModule: PyModule = createMathModule();
