/**
 * Built-in functions and type constructors.
 */

import {
  EXCEPTION_CLASSES, InterpreterError, KeyError, OverflowError, RuntimeError, TypeError, ValueError,
} from './errors';
import { asciiRepr, formatValue } from './format';
import { arity, dictUpdate, getAttribute, mapCall, sortItems, stopIteration } from './methods';
import {
  PyFloat, PyInt, floatToInt, intAdd, intNeg, intPowMod, isIntLike, isNum, normBig, parseFloatString,
  parseIntString, roundHalfEven, toFixedPy, toFloat,
} from './numbers';
import { asIndex, binary } from './ops';
import {
  DONE, Done, ELLIPSIS, Kwargs, MA, NativeFn, PyBuiltin, PyDict, PyDictView, PyFunction, PyGenerator,
  PyIterator, PyList, PyRange, PySet, PySlice, PyTimeDelta, PyTuple, PyType, PyValue, Runtime, SeqIterator,
  T_BOOL, T_DICT, T_FLOAT, T_INT, T_LIST, T_NONE, T_RANGE, T_SET, T_SLICE, T_STR, T_TUPLE, T_TYPE,
  dictGet, exceptionType, hashKey, identityOf, pyCompare, pyRepr, pySetFrom, pyStr, strChars, strLength,
  andThen, truthy, typeName, typeOf, valueToJs,
} from './values';
import { BinOp } from './vm';

export type PrintCallback = (output: string) => void;

export interface ChartOptions {
  type: string;
  data: unknown[];
  x: string;
  y: string | string[];
  title?: string;
}

export interface TableOptions {
  data: unknown[];
  columns: Array<{ key: string; label: string; format?: string }>;
  title?: string;
}

export type ChartCallback = (options: ChartOptions) => void;
export type TableCallback = (options: TableOptions) => void;

export interface BuiltinCallbacks {
  onPrint?: PrintCallback;
  onChart?: ChartCallback;
  onTable?: TableCallback;
}

// ── Argument helpers ────────────────────────────────────────────────────────

function onlyKeywords(name: string, kwargs: Kwargs, allowed: string[]): void {
  if (kwargs === null) return;
  for (const key of kwargs.keys()) {
    if (!allowed.includes(key)) throw new TypeError(`${name}() got an unexpected keyword argument '${key}'`);
  }
}

function integer(v: PyValue, what: string): PyInt {
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`'${typeName(v)}' object cannot be interpreted as an integer${what ? ` (${what})` : ''}`);
}

// ── Lazy iterators ──────────────────────────────────────────────────────────

class EnumerateIterator extends PyIterator {
  readonly typeName = 'enumerate';
  constructor(private readonly inner: PyValue, private index: PyInt) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    return andThen(rt.next(this.inner), (v) => {
      if (v === DONE) return DONE;
      const pair = new PyTuple([this.index, v]);
      this.index = intAdd(this.index, 1);
      return pair;
    });
  }
}

/** Advances every iterator once; DONE as soon as one is exhausted. */
function nextOfEach(rt: Runtime, iterators: PyValue[], strict: boolean): MA<PyValue[] | Done> {
  const items: PyValue[] = [];
  const step = (i: number): MA<PyValue[] | Done> => {
    for (; i < iterators.length; i++) {
      const r = rt.next(iterators[i]);
      if (r instanceof Promise) {
        const at = i;
        return r.then((v) => {
          if (v === DONE) return finish(at);
          items.push(v);
          return step(at + 1);
        });
      }
      if (r === DONE) return finish(i);
      items.push(r);
    }
    return items;
  };
  const finish = (i: number): Done => {
    if (strict && i > 0) {
      throw new ValueError(`zip() argument ${i + 1} is shorter than argument${i === 1 ? '' : 's'} 1${i === 1 ? '' : `-${i}`}`);
    }
    return DONE;
  };
  return step(0);
}

class ZipIterator extends PyIterator {
  readonly typeName = 'zip';
  constructor(private readonly iterators: PyValue[], private readonly strict: boolean) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    if (this.iterators.length === 0) return DONE;
    return andThen(nextOfEach(rt, this.iterators, this.strict), (items) => (items === DONE ? DONE : new PyTuple(items)));
  }
}

class MapIterator extends PyIterator {
  readonly typeName = 'map';
  constructor(private readonly fn: PyValue, private readonly iterators: PyValue[]) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    return andThen(nextOfEach(rt, this.iterators, false), (items) => (items === DONE ? DONE : rt.call(this.fn, items)));
  }
}

class FilterIterator extends PyIterator {
  readonly typeName = 'filter';
  constructor(private readonly fn: PyValue, private readonly inner: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    for (;;) {
      const item = rt.next(this.inner);
      if (item instanceof Promise) return this.nextAsync(rt, item);
      if (item === DONE) return DONE;
      if (this.fn === null) {
        if (truthy(item)) return item;
        continue;
      }
      const keep = rt.call(this.fn, [item]);
      if (keep instanceof Promise) return keep.then((k) => (truthy(k) ? item : this.next(rt)));
      if (truthy(keep)) return item;
    }
  }
  private async nextAsync(rt: Runtime, pending: Promise<PyValue | Done>): Promise<PyValue | Done> {
    const item = await pending;
    if (item === DONE) return DONE;
    const keep = this.fn === null ? item : await rt.call(this.fn, [item]);
    return truthy(keep) ? item : this.next(rt);
  }
}

// ── Numbers ─────────────────────────────────────────────────────────────────

function toInt(args: PyValue[], kwargs: Kwargs): PyValue {
  arity('int', args, 0, 2);
  onlyKeywords('int', kwargs, ['base']);
  if (args.length === 0) return 0;
  const x = args[0];
  const baseArg = args.length > 1 ? args[1] : kwargs?.get('base');
  if (baseArg !== undefined) {
    if (typeof x !== 'string') throw new TypeError("int() can't convert non-string with explicit base");
    const base = Number(integer(baseArg, ''));
    if (base !== 0 && (base < 2 || base > 36)) throw new ValueError('int() base must be >= 2 and <= 36, or 0');
    const parsed = parseIntString(x, base);
    if (parsed === undefined) throw new ValueError(`invalid literal for int() with base ${base}: ${pyRepr(x)}`);
    return parsed;
  }
  if (typeof x === 'string') {
    const parsed = parseIntString(x, 10);
    if (parsed === undefined) throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(x)}`);
    return parsed;
  }
  if (x instanceof PyFloat) return floatToInt(x.v);
  if (isIntLike(x)) return typeof x === 'boolean' ? (x ? 1 : 0) : x;
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(x)}'`);
}

function toFloatValue(args: PyValue[]): PyValue {
  arity('float', args, 0, 1);
  if (args.length === 0) return new PyFloat(0);
  const x = args[0];
  if (typeof x === 'string') {
    const parsed = parseFloatString(x);
    if (parsed === undefined) throw new ValueError(`could not convert string to float: ${pyRepr(x)}`);
    return new PyFloat(parsed);
  }
  if (x instanceof PyFloat) return x;
  if (isNum(x)) return new PyFloat(toFloat(x));
  throw new TypeError(`float() argument must be a string or a real number, not '${typeName(x)}'`);
}

function round(args: PyValue[], kwargs: Kwargs): PyValue {
  arity('round', args, 0, 2);
  onlyKeywords('round', kwargs, ['number', 'ndigits']);
  const x = args.length > 0 ? args[0] : kwargs?.get('number');
  if (x === undefined) throw new TypeError("round() missing required argument 'number' (pos 1)");
  const digitsArg = args.length > 1 ? args[1] : kwargs?.get('ndigits');
  const digits = digitsArg === undefined || digitsArg === null ? null : Number(integer(digitsArg, ''));
  if (isIntLike(x)) {
    const n: PyInt = typeof x === 'boolean' ? (x ? 1 : 0) : x;
    if (digits === null || digits >= 0) return n;
    // Round half to even at a power of ten, exactly.
    const unit = 10n ** BigInt(-digits);
    const big = BigInt(n);
    let q = big / unit;
    const r = big - q * unit;
    const twice = (r < 0n ? -r : r) * 2n;
    if (twice > unit || (twice === unit && q % 2n !== 0n)) q += big < 0n ? -1n : 1n;
    return normBig(q * unit);
  }
  if (!(x instanceof PyFloat)) throw new TypeError(`type ${typeName(x)} doesn't define __round__ method`);
  if (digits === null) return floatToInt(roundHalfEven(x.v));
  if (!Number.isFinite(x.v)) return x;
  if (digits >= 0) return new PyFloat(Number(toFixedPy(x.v, digits)));
  const unit = 10 ** -digits;
  return new PyFloat(roundHalfEven(x.v / unit) * unit);
}

/** sum(): floats use compensated (Neumaier) summation like CPython 3.12+. */
function sum(rt: Runtime, args: PyValue[], kwargs: Kwargs): MA<PyValue> {
  arity('sum', args, 1, 2);
  let total: PyValue = args.length > 1 ? args[1] : kwargs?.get('start') ?? 0;
  if (typeof total === 'string') throw new TypeError("sum() can't sum strings [use ''.join(seq) instead]");
  let floating = false;
  let partial = 0;
  let compensation = 0;

  const addFloat = (x: number) => {
    const t = partial + x;
    if (Number.isFinite(t)) {
      compensation += Math.abs(partial) >= Math.abs(x) ? (partial - t) + x : (x - t) + partial;
    }
    partial = t;
  };
  const leaveFloat = () => {
    total = new PyFloat(partial + compensation);
    floating = false;
  };

  const done = rt.forEach(args[0], (item) => {
    if (floating) {
      if (isNum(item)) {
        addFloat(toFloat(item));
        return;
      }
      leaveFloat();
    } else if (item instanceof PyFloat && isNum(total)) {
      floating = true;
      partial = toFloat(total);
      compensation = 0;
      addFloat(item.v);
      return;
    }
    total = binary(rt, BinOp.ADD, total, item);
    if (total instanceof PyFloat) {
      floating = true;
      partial = total.v;
      compensation = 0;
    }
  });
  return andThen(done, () => {
    if (floating) leaveFloat();
    return total;
  });
}

function extreme(rt: Runtime, name: 'min' | 'max', args: PyValue[], kwargs: Kwargs): MA<PyValue> {
  onlyKeywords(name, kwargs, ['key', 'default']);
  if (args.length === 0) throw new TypeError(`${name} expected at least 1 argument, got 0`);
  const key = kwargs?.get('key');
  const fallback = kwargs?.get('default');
  if (args.length > 1 && fallback !== undefined) {
    throw new TypeError(`Cannot specify a default for ${name}() with multiple positional arguments`);
  }
  const op = name === 'max' ? '>' : '<';
  const pick = (items: PyValue[], keys: PyValue[]): PyValue => {
    if (items.length === 0) {
      if (fallback !== undefined) return fallback;
      throw new ValueError(`${name}() iterable argument is empty`);
    }
    let best = 0;
    for (let i = 1; i < items.length; i++) if (pyCompare(op, keys[i], keys[best])) best = i;
    return items[best];
  };
  return andThen(args.length === 1 ? rt.collect(args[0]) : args, (items) => {
    if (key === undefined || key === null) return pick(items, items);
    return andThen(mapCall(rt, key, items), (keys) => pick(items, keys));
  });
}

function prefixed(name: string, prefix: string, radix: number): NativeFn {
  return (_rt, args) => {
    arity(name, args, 1);
    const n = integer(args[0], '');
    return n < 0 ? `-${prefix}${intNeg(n).toString(radix)}` : `${prefix}${n.toString(radix)}`;
  };
}

function stringHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h;
}

// ── Types ───────────────────────────────────────────────────────────────────

const TYPES_BY_NAME = new Map<string, PyType>();

function isInstance(obj: PyValue, type: PyValue): boolean {
  if (type instanceof PyTuple) return type.items.some((t) => isInstance(obj, t));
  // A type given by name ("int") is accepted for backward compatibility.
  const resolved = typeof type === 'string' ? TYPES_BY_NAME.get(type) : type;
  if (!(resolved instanceof PyType)) {
    throw new TypeError('isinstance() arg 2 must be a type, a tuple of types, or a union');
  }
  if (resolved.jsClass) return obj instanceof resolved.jsClass;
  return typeOf(obj).isSubtypeOf(resolved);
}

function makeException(cls: typeof InterpreterError, args: PyValue[]): InterpreterError {
  const error = new cls();
  error.args = args;
  const text = pyStr(error);
  error.baseMessage = error instanceof KeyError ? `KeyError: ${text}` : text;
  error.message = error.baseMessage;
  return error;
}

/** Built-ins that exist in CPython but are deliberately absent here, with
 *  what to do instead. Looked up when a name is not found. */
export const UNSUPPORTED_BUILTINS: Record<string, string> = {
  open: 'file access is not available in this sandbox; data comes in through tool functions',
  input: 'there is no interactive input in this sandbox; data comes in through tool functions',
  eval: 'dynamic code execution is not available in this sandbox',
  exec: 'dynamic code execution is not available in this sandbox',
  compile: 'dynamic code execution is not available in this sandbox',
  __import__: 'use an import statement; only whitelisted modules can be imported',
  globals: 'introspection of interpreter state is not available in this sandbox',
  locals: 'introspection of interpreter state is not available in this sandbox',
  vars: 'introspection of interpreter state is not available in this sandbox',
  bytes: 'binary data is not supported in this sandbox; use str',
  bytearray: 'binary data is not supported in this sandbox; use str',
};

export function createBuiltins(callbacks: BuiltinCallbacks = {}): Map<string, PyValue> {
  const { onPrint, onChart, onTable } = callbacks;
  const builtins = new Map<string, PyValue>();

  const fn = (name: string, impl: NativeFn, kw: boolean = false) => {
    builtins.set(name, new PyBuiltin(name, impl, kw));
  };
  /** Registers a type; it rejects keyword arguments unless `kw` is set. */
  const type = (t: PyType, construct: NativeFn, kw: boolean = false) => {
    t.construct = kw ? construct : (rt, args, kwargs) => {
      if (kwargs !== null && kwargs.size > 0) throw new TypeError(`${t.name}() takes no keyword arguments`);
      return construct(rt, args, null);
    };
    builtins.set(t.name, t);
    TYPES_BY_NAME.set(t.name, t);
  };

  // ── Type constructors ───────────────────────────────────────────────────

  type(T_INT, (_rt, args, kwargs) => toInt(args, kwargs), true);
  type(T_FLOAT, (_rt, args) => toFloatValue(args));
  type(T_BOOL, (_rt, args) => {
    arity('bool', args, 0, 1);
    return args.length > 0 && truthy(args[0]);
  });
  type(T_STR, (_rt, args) => {
    arity('str', args, 0, 1);
    return args.length === 0 ? '' : pyStr(args[0]);
  });
  type(T_LIST, (rt, args) => {
    arity('list', args, 0, 1);
    if (args.length === 0) return new PyList([]);
    return andThen(rt.collect(args[0]), (items) => new PyList(items.slice()));
  });
  type(T_TUPLE, (rt, args) => {
    arity('tuple', args, 0, 1);
    if (args.length === 0) return new PyTuple([]);
    if (args[0] instanceof PyTuple) return args[0];
    return andThen(rt.collect(args[0]), (items) => new PyTuple(items.slice()));
  });
  type(T_SET, (rt, args) => {
    arity('set', args, 0, 1);
    if (args.length === 0) return new PySet();
    return andThen(rt.collect(args[0]), (items) => pySetFrom(items));
  });
  type(T_DICT, (rt, args, kwargs) => {
    arity('dict', args, 0, 1);
    const dict = new PyDict();
    return andThen(dictUpdate(rt, dict, args[0], kwargs), () => dict);
  }, true);
  type(T_RANGE, (_rt, args) => {
    arity('range', args, 1, 3);
    const nums = args.map((a) => {
      if (!isIntLike(a)) throw new TypeError(`'${typeName(a)}' object cannot be interpreted as an integer`);
      if (typeof a === 'bigint') throw new OverflowError('range() bounds beyond 2**53 are not supported in this sandbox');
      return asIndex(a)!;
    });
    if (nums.length === 1) return new PyRange(0, nums[0], 1);
    if (nums.length === 2) return new PyRange(nums[0], nums[1], 1);
    if (nums[2] === 0) throw new ValueError('range() arg 3 must not be zero');
    return new PyRange(nums[0], nums[1], nums[2]);
  });
  type(T_SLICE, (_rt, args) => {
    arity('slice', args, 1, 3);
    if (args.length === 1) return new PySlice(null, args[0], null);
    return new PySlice(args[0], args[1], args.length > 2 ? args[2] : null);
  });
  type(T_TYPE, (_rt, args) => {
    if (args.length !== 1) throw new TypeError('type() takes 1 argument');
    return typeOf(args[0]);
  });
  TYPES_BY_NAME.set('NoneType', T_NONE);

  for (const cls of EXCEPTION_CLASSES) {
    const t = exceptionType(cls);
    t.construct = (_rt, args, kwargs) => {
      if (kwargs !== null && kwargs.size > 0) throw new TypeError(`${t.name}() takes no keyword arguments`);
      return makeException(cls, args);
    };
    builtins.set(t.name, t);
  }

  // ── Functions ───────────────────────────────────────────────────────────

  fn('len', (_rt, args) => {
    arity('len', args, 1);
    const v = args[0];
    if (typeof v === 'string') return strLength(v);
    if (v instanceof PyList || v instanceof PyTuple) return v.items.length;
    if (v instanceof PyDict || v instanceof PySet) return v.map.size;
    if (v instanceof PyRange) return v.length;
    if (v instanceof PyDictView) return v.dict.map.size;
    throw new TypeError(`object of type '${typeName(v)}' has no len()`);
  });

  fn('sum', sum, true);
  fn('min', (rt, args, kwargs) => extreme(rt, 'min', args, kwargs), true);
  fn('max', (rt, args, kwargs) => extreme(rt, 'max', args, kwargs), true);

  fn('abs', (_rt, args) => {
    arity('abs', args, 1);
    const v = args[0];
    if (isIntLike(v)) {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      return n < 0 ? intNeg(n) : n;
    }
    if (v instanceof PyFloat) return new PyFloat(Math.abs(v.v));
    if (v instanceof PyTimeDelta) return v.days < 0 ? binary(_rt, BinOp.MUL, v, -1) : v;
    throw new TypeError(`bad operand type for abs(): '${typeName(v)}'`);
  });

  fn('round', (_rt, args, kwargs) => round(args, kwargs), true);

  fn('pow', (_rt, args, kwargs) => {
    arity('pow', args, 2, 3);
    onlyKeywords('pow', kwargs, ['mod']);
    const [base, exp] = args;
    const mod = args.length > 2 ? args[2] : kwargs?.get('mod');
    if (mod !== undefined && mod !== null) {
      if (!isIntLike(base) || !isIntLike(exp) || !isIntLike(mod)) {
        throw new TypeError('pow() 3rd argument not allowed unless all arguments are integers');
      }
      return intPowMod(integer(base, ''), integer(exp, ''), integer(mod, ''));
    }
    return binary(_rt, BinOp.POW, base, exp);
  }, true);

  fn('divmod', (rt, args) => {
    arity('divmod', args, 2);
    return new PyTuple([binary(rt, BinOp.FLOORDIV, args[0], args[1]), binary(rt, BinOp.MOD, args[0], args[1])]);
  });

  fn('hex', prefixed('hex', '0x', 16));
  fn('oct', prefixed('oct', '0o', 8));
  fn('bin', prefixed('bin', '0b', 2));

  fn('ord', (_rt, args) => {
    arity('ord', args, 1);
    const c = args[0];
    if (typeof c !== 'string') throw new TypeError(`ord() expected string of length 1, but ${typeName(c)} found`);
    const length = strLength(c);
    if (length !== 1) throw new TypeError(`ord() expected a character, but string of length ${length} found`);
    return c.codePointAt(0)!;
  });

  fn('chr', (_rt, args) => {
    arity('chr', args, 1);
    const n = integer(args[0], '');
    if (n < 0 || n > 0x10ffff) throw new ValueError('chr() arg not in range(0x110000)');
    return String.fromCodePoint(Number(n));
  });

  fn('sorted', (rt, args, kwargs) => {
    arity('sorted', args, 1);
    onlyKeywords('sorted', kwargs, ['key', 'reverse']);
    const reverse = kwargs?.get('reverse');
    return andThen(rt.collect(args[0]), (items) =>
      andThen(sortItems(rt, items, kwargs?.get('key'), reverse !== undefined && truthy(reverse)), (sorted) => new PyList(sorted)));
  }, true);

  fn('reversed', (rt, args) => {
    arity('reversed', args, 1);
    const v = args[0];
    let items: PyValue[];
    if (v instanceof PyList || v instanceof PyTuple) items = v.items.slice();
    else if (typeof v === 'string') items = strChars(v);
    else if (v instanceof PyRange) {
      rt.checkCollection(v.length);
      items = valueToJs(v) as number[];
    }
    else if (v instanceof PyDict) items = Array.from(v.map.values(), (e) => e[0]);
    else if (v instanceof PyDictView) items = v.toArray();
    else throw new TypeError(`'${typeName(v)}' object is not reversible`);
    return new SeqIterator(items.reverse(), 'reversed');
  });

  fn('enumerate', (rt, args, kwargs) => {
    arity('enumerate', args, 1, 2);
    onlyKeywords('enumerate', kwargs, ['start']);
    const start = args.length > 1 ? args[1] : kwargs?.get('start') ?? 0;
    return new EnumerateIterator(rt.iter(args[0]), integer(start, ''));
  }, true);

  fn('zip', (rt, args, kwargs) => {
    onlyKeywords('zip', kwargs, ['strict']);
    const strict = kwargs?.get('strict');
    return new ZipIterator(args.map((a) => rt.iter(a)), strict !== undefined && truthy(strict));
  }, true);

  fn('map', (rt, args) => {
    if (args.length < 2) throw new TypeError('map() must have at least two arguments.');
    return new MapIterator(args[0], args.slice(1).map((a) => rt.iter(a)));
  });

  fn('filter', (rt, args) => {
    arity('filter', args, 2);
    return new FilterIterator(args[0], rt.iter(args[1]));
  });

  fn('any', (rt, args) => {
    arity('any', args, 1);
    let found = false;
    return andThen(rt.forEach(args[0], (v) => (found = truthy(v))), () => found);
  });

  fn('all', (rt, args) => {
    arity('all', args, 1);
    let ok = true;
    return andThen(rt.forEach(args[0], (v) => !(ok = truthy(v))), () => ok);
  });

  fn('iter', (rt, args) => {
    arity('iter', args, 1);
    return rt.iter(args[0]);
  });

  fn('next', (rt, args) => {
    arity('next', args, 1, 2);
    const it = args[0];
    if (!(it instanceof PyGenerator) && !(it instanceof PyIterator)) {
      throw new TypeError(`'${typeName(it)}' object is not an iterator`);
    }
    return andThen(rt.next(it), (v) => {
      if (v !== DONE) return v;
      if (args.length > 1) return args[1];
      throw stopIteration(it instanceof PyGenerator ? it.returnValue : null);
    });
  });

  fn('print', (_rt, args, kwargs) => {
    if (!onPrint) {
      throw new RuntimeError('print() is not available. Use print_table(data, title, columns) for tables or show_chart(type, data, title) for charts.');
    }
    const sep = kwargs?.get('sep');
    const end = kwargs?.get('end');
    const output = args.map(pyStr).join(typeof sep === 'string' ? sep : ' ');
    // One callback per print(): the default trailing newline is implied.
    onPrint(output + (typeof end === 'string' && end !== '\n' ? end : ''));
    return null;
  }, true);

  fn('repr', (_rt, args) => {
    arity('repr', args, 1);
    return pyRepr(args[0]);
  });

  fn('ascii', (_rt, args) => {
    arity('ascii', args, 1);
    return asciiRepr(args[0]);
  });

  fn('format', (_rt, args) => {
    arity('format', args, 1, 2);
    const spec = args.length > 1 ? args[1] : '';
    if (typeof spec !== 'string') throw new TypeError(`format() argument 2 must be str, not ${typeName(spec)}`);
    return formatValue(args[0], spec);
  });

  fn('callable', (_rt, args) => {
    arity('callable', args, 1);
    const v = args[0];
    return v instanceof PyFunction || v instanceof PyBuiltin || (v instanceof PyType && v.construct !== null);
  });

  fn('isinstance', (_rt, args) => {
    arity('isinstance', args, 2);
    return isInstance(args[0], args[1]);
  });

  fn('issubclass', (_rt, args) => {
    arity('issubclass', args, 2);
    const [cls, parent] = args;
    if (!(cls instanceof PyType)) throw new TypeError('issubclass() arg 1 must be a class');
    const parents = parent instanceof PyTuple ? parent.items : [parent];
    return parents.some((p) => {
      if (!(p instanceof PyType)) throw new TypeError('issubclass() arg 2 must be a class, a tuple of classes, or a union');
      return cls.isSubtypeOf(p);
    });
  });

  fn('hash', (_rt, args) => {
    arity('hash', args, 1);
    // Numbers hash to themselves like CPython ints; everything else gets a
    // string hash of its canonical key.
    const key = hashKey(args[0]);
    if (typeof key !== 'number') return stringHash(key);
    return Number.isInteger(key) ? key : stringHash(String(key));
  });

  fn('id', (_rt, args) => {
    arity('id', args, 1);
    const v = args[0];
    if (v !== null && typeof v === 'object') return identityOf(v);
    // Equal immutable values share an id, as interned objects do in CPython.
    return stringHash(typeof v + ':' + String(v)) >>> 0;
  });

  fn('getattr', (_rt, args) => {
    arity('getattr', args, 2, 3);
    if (typeof args[1] !== 'string') throw new TypeError(`attribute name must be string, not '${typeName(args[1])}'`);
    if (args.length < 3) return getAttribute(args[0], args[1]);
    try {
      return getAttribute(args[0], args[1]);
    } catch (error) {
      if (error instanceof InterpreterError && error.name === 'AttributeError') return args[2];
      throw error;
    }
  });

  fn('hasattr', (_rt, args) => {
    arity('hasattr', args, 2);
    if (typeof args[1] !== 'string') throw new TypeError(`attribute name must be string, not '${typeName(args[1])}'`);
    try {
      getAttribute(args[0], args[1]);
      return true;
    } catch (error) {
      if (error instanceof InterpreterError && error.name === 'AttributeError') return false;
      throw error;
    }
  });

  // print_chart(type, data, x, y, title=None) - Render a chart visualization
  fn('print_chart', (_rt, args, kwargs) => {
    if (!onChart) throw new Error('print_chart() is not available in this context');

    // Parameters come from kwargs (preferred) or positional args
    const typeArg = kwargs?.get('type') ?? args[0];
    const chartType = typeArg ? pyStr(typeArg) : null;
    const dataArg = kwargs?.get('data') ?? args[1];
    const xArg = kwargs?.get('x') ?? args[2];
    const yArg = kwargs?.get('y') ?? args[3];
    const titleArg = kwargs?.get('title');

    if (!chartType || !['bar', 'line', 'pie', 'area'].includes(chartType)) {
      throw new TypeError('print_chart() requires type to be one of: bar, line, pie, area');
    }
    if (!(dataArg instanceof PyList)) {
      throw new TypeError('print_chart() requires data to be a list of dictionaries');
    }
    if (!xArg) throw new TypeError('print_chart() requires x parameter (key for x-axis)');
    if (!yArg) throw new TypeError('print_chart() requires y parameter (key(s) for y-axis)');

    const data = dataArg.items.map((row) => {
      if (!(row instanceof PyDict)) throw new TypeError('print_chart() data must be a list of dictionaries');
      return valueToJs(row);
    });
    const MAX_DATA_POINTS = 200;
    if (data.length > MAX_DATA_POINTS) {
      throw new TypeError(`print_chart() data exceeds maximum of ${MAX_DATA_POINTS} points (got ${data.length})`);
    }

    onChart({
      type: chartType,
      data,
      x: pyStr(xArg),
      y: yArg instanceof PyList ? yArg.items.map(pyStr) : pyStr(yArg),
      title: titleArg ? pyStr(titleArg) : undefined,
    });
    return null;
  }, true);

  // print_table(data, columns=None, title=None) - Render a data table
  fn('print_table', (_rt, args, kwargs) => {
    if (!onTable) throw new Error('print_table() is not available in this context');

    const dataArg = kwargs?.get('data') ?? args[0];
    const columnsArg = kwargs?.get('columns') ?? args[1];
    const titleArg = kwargs?.get('title');

    if (!(dataArg instanceof PyList)) {
      throw new TypeError('print_table() requires data to be a list of dictionaries');
    }
    const data = dataArg.items.map((row) => {
      if (!(row instanceof PyDict)) throw new TypeError('print_table() data must be a list of dictionaries');
      return valueToJs(row) as Record<string, unknown>;
    });
    const MAX_ROWS = 500;
    if (data.length > MAX_ROWS) {
      throw new TypeError(`print_table() data exceeds maximum of ${MAX_ROWS} rows (got ${data.length})`);
    }

    let columns: TableOptions['columns'];
    if (columnsArg instanceof PyList) {
      columns = columnsArg.items.map((column) => {
        if (typeof column === 'string') return { key: column, label: column };
        if (column instanceof PyDict) {
          const key = dictGet(column, 'key');
          const label = dictGet(column, 'label');
          const format = dictGet(column, 'format');
          if (typeof key !== 'string') throw new TypeError('Column definition requires "key" string');
          return {
            key,
            label: typeof label === 'string' ? label : key,
            format: typeof format === 'string' ? format : undefined,
          };
        }
        throw new TypeError('Column must be a string or dictionary with key/label/format');
      });
    } else if (data.length > 0) {
      // Infer columns from the first row
      columns = Object.keys(data[0]).slice(0, 20).map((key) => ({ key, label: key }));
    } else {
      columns = [];
    }

    onTable({ data, columns, title: titleArg ? pyStr(titleArg) : undefined });
    return null;
  }, true);

  builtins.set('Ellipsis', ELLIPSIS);
  builtins.set('__name__', '__main__');
  return builtins;
}

