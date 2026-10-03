/**
 * The `functools` module: `reduce`, `partial`, `lru_cache`/`cache`,
 * `cmp_to_key`, `wraps`, as an opt-in plugin.
 *
 *   import { functools } from 'defanged/functools';
 *   createInterpreter({ modules: [functools] });
 *
 * `total_ordering` and `singledispatch` need classes and are left out.
 * `wraps` returns the wrapper unchanged, since functions here carry no
 * `__name__` or `__doc__` to copy.
 */

import { TypeError } from './errors';
import { PyFloat, isNum, numCompare } from './numbers';
import {
  HashKey, Kwargs, MA, OrderOp, PyBuiltin, PyDict, PyFunction, PyModule, PyObject, PyTuple, PyType, PyValue, Runtime,
  andThen, dictSet, hashKey, namedType, pyRepr, typeOf,
} from './values';

function isCallable(v: PyValue): boolean {
  return v instanceof PyFunction || v instanceof PyBuiltin || (v instanceof PyType && v.construct !== null);
}

function positional(name: string, args: PyValue[], min: number, max: number): void {
  if (args.length < min) throw new TypeError(`${name}() takes at least ${min} positional arguments (${args.length} given)`);
  if (args.length > max) throw new TypeError(`${name}() takes at most ${max} positional arguments (${args.length} given)`);
}

function noKeywords(name: string, kwargs: Kwargs): void {
  if (kwargs !== null && kwargs.size > 0) throw new TypeError(`${name}() takes no keyword arguments`);
}

// ── reduce ──────────────────────────────────────────────────────────────────

function reduce(rt: Runtime, args: PyValue[], kwargs: Kwargs): MA<PyValue> {
  positional('reduce', args, 2, 3);
  for (const key of kwargs?.keys() ?? []) {
    if (key !== 'initial') throw new TypeError(`reduce() got an unexpected keyword argument '${key}'`);
  }
  const fn = args[0];
  const initial = args.length > 2 ? args[2] : kwargs?.get('initial');
  let collected: MA<PyValue[]>;
  try {
    collected = rt.collect(args[1]);
  } catch (e) {
    if (e instanceof TypeError && e.message.endsWith('is not iterable')) throw new TypeError('reduce() arg 2 must support iteration');
    throw e;
  }
  return andThen(collected, (items) => {
    let i = 0;
    let acc: PyValue;
    if (initial !== undefined) acc = initial;
    else if (items.length === 0) throw new TypeError('reduce() of empty iterable with no initial value');
    else acc = items[i++];
    const fold = (): MA<PyValue> => {
      for (; i < items.length; i++) {
        const r = rt.call(fn, [acc, items[i]]);
        if (r instanceof Promise) {
          return r.then((v) => {
            acc = v;
            i++;
            return fold();
          });
        }
        acc = r;
      }
      return acc;
    };
    return fold();
  });
}

// ── partial ─────────────────────────────────────────────────────────────────

interface Partial { func: PyValue; args: PyValue[]; keywords: Map<string, PyValue> }
const partials = new WeakMap<PyBuiltin, Partial>();

function partial(_rt: Runtime, args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length < 1) throw new TypeError('type \'partial\' takes at least one argument');
  let func = args[0];
  if (!isCallable(func)) throw new TypeError('the first argument must be callable');
  let bound = args.slice(1);
  let keywords = new Map(kwargs ?? []);
  // A partial of a partial flattens, so `.func` is always the original.
  const inner = func instanceof PyBuiltin ? partials.get(func) : undefined;
  if (inner) {
    func = inner.func;
    bound = [...inner.args, ...bound];
    keywords = new Map([...inner.keywords, ...keywords]);
  }
  const target = func;
  const wrapper = new PyBuiltin('partial', (rt, callArgs, callKwargs) => {
    const merged = keywords.size === 0 && callKwargs === null ? null : new Map([...keywords, ...(callKwargs ?? [])]);
    return rt.call(target, bound.length === 0 ? callArgs : [...bound, ...callArgs], merged);
  }, true);
  const keywordDict = new PyDict();
  for (const [k, v] of keywords) dictSet(keywordDict, k, v);
  wrapper.attrs = new Map<string, PyValue>([
    ['func', target],
    ['args', new PyTuple(bound)],
    ['keywords', keywordDict],
  ]);
  partials.set(wrapper, { func: target, args: bound, keywords });
  return wrapper;
}

// ── lru_cache / cache ───────────────────────────────────────────────────────

const T_CACHE_INFO = namedType('functools.CacheInfo');
const CACHE_INFO_FIELDS = ['hits', 'misses', 'maxsize', 'currsize'];

class CacheInfo extends PyTuple {
  get pyType(): PyType {
    return T_CACHE_INFO;
  }
  getAttr(name: string): PyValue | undefined {
    const at = CACHE_INFO_FIELDS.indexOf(name);
    return at >= 0 ? this.items[at] : undefined;
  }
  reprWith(): string {
    return `CacheInfo(${CACHE_INFO_FIELDS.map((f, i) => `${f}=${pyRepr(this.items[i])}`).join(', ')})`;
  }
}

/** Separates positional from keyword arguments in a cache key. */
class KwMark extends PyObject {
  readonly typeName = 'object';
}
const KW_MARK = new KwMark();

function cacheKey(args: PyValue[], kwargs: Kwargs, typed: boolean): HashKey {
  // CPython keys a lone int or str by the value itself, so f(1) and f(1.0)
  // are separate entries while f(1, 2) and f(1.0, 2) share one.
  if (!typed && args.length === 1 && (kwargs === null || kwargs.size === 0)) {
    const a = args[0];
    if (typeof a === 'number' || typeof a === 'bigint' || typeof a === 'string') return hashKey(a);
  }
  const parts = args.slice();
  if (kwargs !== null && kwargs.size > 0) {
    parts.push(KW_MARK);
    for (const [k, v] of kwargs) parts.push(k, v);
  }
  if (typed) {
    for (const v of args) parts.push(typeOf(v));
    if (kwargs !== null) for (const v of kwargs.values()) parts.push(typeOf(v));
  }
  return hashKey(new PyTuple(parts));
}

function wrapCached(fn: PyValue, maxsize: number | null, typed: boolean): PyBuiltin {
  if (!isCallable(fn)) throw new TypeError('the first argument must be callable');
  // Map iteration order doubles as recency: a hit moves its entry to the end.
  const entries = new Map<HashKey, PyValue>();
  let hits = 0;
  let misses = 0;
  const wrapper = new PyBuiltin('lru_cache', (rt, args, kwargs) => {
    const key = cacheKey(args, kwargs, typed);
    if (entries.has(key)) {
      hits++;
      const value = entries.get(key)!;
      if (maxsize !== null) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    }
    misses++;
    return andThen(rt.call(fn, args, kwargs), (value) => {
      if (maxsize === 0) return value;
      entries.set(key, value);
      if (maxsize !== null && entries.size > maxsize) entries.delete(entries.keys().next().value!);
      return value;
    });
  }, true);
  wrapper.attrs = new Map<string, PyValue>([
    ['cache_info', new PyBuiltin('cache_info', () => new CacheInfo([hits, misses, maxsize, entries.size]))],
    ['cache_clear', new PyBuiltin('cache_clear', () => {
      entries.clear();
      hits = misses = 0;
      return null;
    })],
    ['cache_parameters', new PyBuiltin('cache_parameters', () => {
      const d = new PyDict();
      dictSet(d, 'maxsize', maxsize);
      dictSet(d, 'typed', typed);
      return d;
    })],
    ['__wrapped__', fn],
  ]);
  return wrapper;
}

function lruCache(_rt: Runtime, args: PyValue[], kwargs: Kwargs): PyValue {
  positional('lru_cache', args, 0, 2);
  for (const key of kwargs?.keys() ?? []) {
    if (key !== 'maxsize' && key !== 'typed') throw new TypeError(`lru_cache() got an unexpected keyword argument '${key}'`);
  }
  const typed = (args.length > 1 ? args[1] : kwargs?.get('typed') ?? false) === true;
  const first = args.length > 0 ? args[0] : kwargs?.get('maxsize');
  // `@lru_cache` without parentheses passes the function itself.
  if (first !== undefined && isCallable(first)) return wrapCached(first, 128, typed);
  let maxsize: number | null;
  if (first === undefined) maxsize = 128;
  else if (first === null) maxsize = null;
  else if (typeof first === 'number' || typeof first === 'boolean') maxsize = Math.max(0, Number(first));
  else if (typeof first === 'bigint') maxsize = first < 0n ? 0 : Number.MAX_SAFE_INTEGER;
  else throw new TypeError('Expected first argument to be an integer, a callable, or None');
  return new PyBuiltin('lru_cache', (_rt2, inner) => {
    if (inner.length !== 1) throw new TypeError(`lru_cache() takes exactly one argument (${inner.length} given)`);
    return wrapCached(inner[0], maxsize, typed);
  });
}

function cache(_rt: Runtime, args: PyValue[], kwargs: Kwargs): PyValue {
  noKeywords('cache', kwargs);
  if (args.length !== 1) throw new TypeError(`cache() takes exactly one argument (${args.length} given)`);
  return wrapCached(args[0], null, false);
}

// ── cmp_to_key ──────────────────────────────────────────────────────────────

class KeyObject extends PyObject {
  readonly typeName = 'functools.KeyWrapper';
  constructor(readonly cmp: PyValue, readonly obj: PyValue) {
    super();
  }
  getAttr(name: string): PyValue | undefined {
    return name === 'obj' ? this.obj : undefined;
  }
  compareTo(rt: Runtime, other: PyValue, op: OrderOp): MA<number> {
    if (!(other instanceof KeyObject)) throw new TypeError('other argument must be K instance');
    return andThen(rt.call(this.cmp, [this.obj, other.obj]), (r) => {
      // CPython compares the cmp result with 0, so a non-number fails there.
      if (!isNum(r)) throw new TypeError(`'${op}' not supported between instances of '${typeOf(r).name}' and 'int'`);
      return r instanceof PyFloat ? Math.sign(r.v) : numCompare(r, 0);
    });
  }
}

function cmpToKey(_rt: Runtime, args: PyValue[], kwargs: Kwargs): PyValue {
  const cmp = args.length === 1 ? args[0] : kwargs?.get('mycmp');
  if (cmp === undefined || args.length > 1) throw new TypeError('cmp_to_key() missing required argument \'mycmp\' (pos 1)');
  return new PyBuiltin('K', (_rt2, inner, innerKwargs) => {
    noKeywords('K', innerKwargs);
    if (inner.length !== 1) throw new TypeError(`K() takes exactly one argument (${inner.length} given)`);
    return new KeyObject(cmp, inner[0]);
  }, true);
}

// ── wraps ───────────────────────────────────────────────────────────────────

function wraps(_rt: Runtime, args: PyValue[]): PyValue {
  if (args.length < 1) throw new TypeError('wraps() missing 1 required positional argument: \'wrapped\'');
  return new PyBuiltin('update_wrapper', (_rt2, inner) => {
    if (inner.length !== 1) throw new TypeError(`update_wrapper() takes exactly one argument (${inner.length} given)`);
    return inner[0];
  }, true);
}

function updateWrapper(_rt: Runtime, args: PyValue[]): PyValue {
  if (args.length < 2) throw new TypeError('update_wrapper() missing required positional arguments');
  return args[0];
}

export const functools: PyModule = new PyModule('functools', new Map<string, PyValue>([
  ['reduce', new PyBuiltin('reduce', reduce, true)],
  ['partial', new PyBuiltin('partial', partial, true)],
  ['lru_cache', new PyBuiltin('lru_cache', lruCache, true)],
  ['cache', new PyBuiltin('cache', cache, true)],
  ['cmp_to_key', new PyBuiltin('cmp_to_key', cmpToKey, true)],
  ['wraps', new PyBuiltin('wraps', wraps, true)],
  ['update_wrapper', new PyBuiltin('update_wrapper', updateWrapper, true)],
]));
