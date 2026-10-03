/**
 * Methods and attributes of the built-in types.
 *
 * Each table maps a method name to its implementation; the VM calls straight
 * into a table for `obj.method(...)`, and `getAttribute` wraps an entry in a
 * bound function when the method is used as a value.
 */

import { getDatetimeAttr } from './datetime';
import {
  AttributeError, IndexError, InterpreterError, KeyError, StopIteration, TypeError, ValueError,
} from './errors';
import { strFormat } from './format';
import { PyFloat, bitLength, isIntLike } from './numbers';
import { asIndex, getItem, objectOrder } from './ops';
import {
  DONE, Kwargs, MA, PyBuiltin, PyDate, PyDateTime, PyDict, PyDictView, PyFunction, PyGenerator, PyList,
  PyModule, PyObject, PySet, PyTimeDelta, PyTuple, PyType, PyValue, Runtime,
  T_DICT, T_LIST, T_SET, T_STR, T_TUPLE,
  copyDict, copySet, dictDelete, dictGet, dictSet, hashKey, isAstral, isSubset, keyError, pySetFrom, sameOrEqual,
  setAdd, sortCompare, strChars, strLength, andThen, typeName, typeOf,
} from './values';

export type Method = (rt: Runtime, self: any, args: PyValue[], kwargs: Kwargs) => MA<PyValue>;
type MethodTable = Record<string, Method>;

// ── Argument helpers ────────────────────────────────────────────────────────

export function arity(name: string, args: PyValue[], min: number, max: number = min): void {
  if (args.length >= min && args.length <= max) return;
  if (min === max) {
    const expected = min === 0 ? 'no arguments' : min === 1 ? 'exactly one argument' : `exactly ${min} arguments`;
    throw new TypeError(`${name}() takes ${expected} (${args.length} given)`);
  }
  throw new TypeError(args.length < min
    ? `${name}() takes at least ${min} argument${min === 1 ? '' : 's'} (${args.length} given)`
    : `${name}() takes at most ${max} argument${max === 1 ? '' : 's'} (${args.length} given)`);
}

function str(name: string, v: PyValue, position: string = 'argument'): string {
  if (typeof v !== 'string') throw new TypeError(`${name}() ${position} must be str, not ${typeName(v)}`);
  return v;
}

function int(name: string, v: PyValue): number {
  const n = asIndex(v);
  if (n === undefined) throw new TypeError(`${name}(): '${typeName(v)}' object cannot be interpreted as an integer`);
  return n;
}

/** Takes an argument by position or keyword, like `sep` in `s.split(sep=",")`. */
function arg(args: PyValue[], kwargs: Kwargs, index: number, name: string): PyValue | undefined {
  if (index < args.length) return args[index];
  return kwargs?.get(name);
}

function rejectUnknown(method: string, kwargs: Kwargs, allowed: string[]): void {
  if (kwargs === null) return;
  for (const key of kwargs.keys()) {
    if (!allowed.includes(key)) throw new TypeError(`${method}() got an unexpected keyword argument '${key}'`);
  }
}

// ── Sorting ─────────────────────────────────────────────────────────────────

/** Calls `fn(item)` for each item, staying synchronous unless a call awaits. */
export function mapCall(rt: Runtime, fn: PyValue, items: PyValue[]): MA<PyValue[]> {
  const out: PyValue[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const r = rt.call(fn, [items[i]]);
    if (r instanceof Promise) return mapCallAsync(rt, fn, items, out, i, r);
    out[i] = r;
  }
  return out;
}

async function mapCallAsync(
  rt: Runtime, fn: PyValue, items: PyValue[], out: PyValue[], from: number, pending: Promise<PyValue>,
): Promise<PyValue[]> {
  out[from] = await pending;
  for (let i = from + 1; i < items.length; i++) {
    const r = rt.call(fn, [items[i]]);
    out[i] = r instanceof Promise ? await r : r;
  }
  return out;
}

/** Stable merge sort for comparisons that may wait on Python (cmp_to_key).
 *  Equal elements keep their order: the left run wins ties. */
function mergeSort(indices: number[], cmp: (a: number, b: number) => MA<number>): MA<number[]> {
  if (indices.length <= 1) return indices;
  const mid = indices.length >> 1;
  return andThen(mergeSort(indices.slice(0, mid), cmp), (left) =>
    andThen(mergeSort(indices.slice(mid), cmp), (right) => {
      const out: number[] = [];
      let i = 0;
      let j = 0;
      const take = (c: number): void => { out.push(c <= 0 ? left[i++] : right[j++]); };
      const merge = (): MA<number[]> => {
        while (i < left.length && j < right.length) {
          const c = cmp(left[i], right[j]);
          if (c instanceof Promise) return c.then((n) => { take(n); return merge(); });
          take(c);
        }
        while (i < left.length) out.push(left[i++]);
        while (j < right.length) out.push(right[j++]);
        return out;
      };
      return merge();
    }));
}

/** A new array with `items` in sorted order. Stable, like Python's sort:
 *  equal items keep their original order, also under `reverse`. */
export function sortItems(rt: Runtime, items: PyValue[], key: PyValue | undefined, reverse: boolean): MA<PyValue[]> {
  const order = (keys: PyValue[]): MA<PyValue[]> => {
    const indices = items.map((_, i) => i);
    if (keys.some((k) => k instanceof PyObject)) {
      const cmp = (a: number, b: number): MA<number> =>
        andThen(objectOrder(rt, '<', keys[a], keys[b]), (c) => (reverse ? -c : c));
      return andThen(mergeSort(indices, cmp), (sorted) => sorted.map((i) => items[i]));
    }
    indices.sort((a, b) => {
      const c = sortCompare(keys[a], keys[b]);
      return c !== 0 ? (reverse ? -c : c) : a - b;
    });
    return indices.map((i) => items[i]);
  };
  if (key === undefined || key === null) return order(items);
  return andThen(mapCall(rt, key, items), order);
}

// ── str ─────────────────────────────────────────────────────────────────────

function stripChars(s: string, args: PyValue[], left: boolean, right: boolean, name: string): string {
  arity(name, args, 0, 1);
  const chars = args[0];
  if (chars === undefined || chars === null) {
    return left && right ? s.trim() : left ? s.trimStart() : s.trimEnd();
  }
  const set = new Set(strChars(str(name, chars, 'arg')));
  const cs = strChars(s);
  let start = 0;
  let end = cs.length;
  if (left) while (start < end && set.has(cs[start])) start++;
  if (right) while (end > start && set.has(cs[end - 1])) end--;
  return cs.slice(start, end).join('');
}

/** Code-point offset → UTF-16 offset. */
function unitOffset(s: string, cp: number): number {
  let units = 0;
  for (let i = 0; i < cp && units < s.length; i++) {
    const c = s.charCodeAt(units);
    units += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return units;
}

/** Resolves optional [start, end) arguments to UTF-16 offsets within `s`. */
function range(s: string, args: PyValue[], from: number, name: string): [number, number] {
  const astral = isAstral(s);
  const length = astral ? strLength(s) : s.length;
  const clamp = (v: PyValue | undefined, fallback: number): number => {
    if (v === undefined || v === null) return fallback;
    let n = int(name, v);
    if (n < 0) n = Math.max(0, n + length);
    return Math.min(n, length);
  };
  const start = clamp(args[from], 0);
  const end = clamp(args[from + 1], length);
  return astral ? [unitOffset(s, start), unitOffset(s, end)] : [start, end];
}

/** UTF-16 offset → code-point index, the form find()/index() return. */
function cpIndex(s: string, unit: number): number {
  return unit < 0 || !isAstral(s) ? unit : strLength(s.slice(0, unit));
}

function find(s: string, args: PyValue[], name: string, reverse: boolean): number {
  arity(name, args, 1, 3);
  const sub = str(name, args[0]);
  const [start, end] = range(s, args, 1, name);
  if (end - start < sub.length) return -1;
  const window = s.slice(start, end);
  const at = reverse ? window.lastIndexOf(sub) : window.indexOf(sub);
  return at < 0 ? -1 : cpIndex(s, at + start);
}

function affix(s: string, args: PyValue[], name: string, test: (text: string, part: string) => boolean): boolean {
  arity(name, args, 1, 3);
  const [start, end] = range(s, args, 1, name);
  const text = s.slice(start, end);
  const candidates = args[0] instanceof PyTuple ? args[0].items : [args[0]];
  for (const c of candidates) {
    if (typeof c !== 'string') {
      throw new TypeError(`${name} first arg must be str or a tuple of str, not ${typeName(c)}`);
    }
    if (test(text, c)) return true;
  }
  return false;
}

function justify(rt: Runtime, s: string, args: PyValue[], name: string, side: 'left' | 'right' | 'center'): string {
  arity(name, args, 1, 2);
  const width = int(name, args[0]);
  const fill = args.length > 1 ? str(name, args[1]) : ' ';
  if (strLength(fill) !== 1) throw new TypeError('The fill character must be exactly one character long');
  const padding = width - strLength(s);
  if (padding <= 0) return s;
  rt.checkString(width);
  if (side === 'left') return s + fill.repeat(padding);
  if (side === 'right') return fill.repeat(padding) + s;
  // CPython puts the odd extra character on the left when the width is odd.
  const left = Math.floor(padding / 2) + (padding & width & 1);
  return fill.repeat(left) + s + fill.repeat(padding - left);
}

function split(s: string, args: PyValue[], kwargs: Kwargs, name: string, fromRight: boolean): PyValue {
  rejectUnknown(name, kwargs, ['sep', 'maxsplit']);
  const sepArg = arg(args, kwargs, 0, 'sep');
  const maxArg = arg(args, kwargs, 1, 'maxsplit');
  const maxsplit = maxArg === undefined ? -1 : int(name, maxArg);

  if (sepArg === undefined || sepArg === null) {
    const words = s.trim() === '' ? [] : s.trim().split(/\s+/);
    if (maxsplit < 0 || words.length <= maxsplit) return new PyList(words);
    // The unsplit remainder is kept verbatim: only the side that was split
    // from loses its whitespace.
    if (!fromRight) {
      let rest = s.trimStart();
      const head: string[] = [];
      for (let i = 0; i < maxsplit; i++) {
        const m = /^(\S+)\s+/.exec(rest)!;
        head.push(m[1]);
        rest = rest.slice(m[0].length);
      }
      return new PyList([...head, rest]);
    }
    let rest = s.trimEnd();
    const tail: string[] = [];
    for (let i = 0; i < maxsplit; i++) {
      const m = /\s+(\S+)$/.exec(rest)!;
      tail.unshift(m[1]);
      rest = rest.slice(0, rest.length - m[0].length);
    }
    return new PyList([rest, ...tail]);
  }

  const sep = str(name, sepArg, 'sep');
  if (sep === '') throw new ValueError('empty separator');
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length <= maxsplit + 1) return new PyList(parts);
  if (!fromRight) {
    return new PyList([...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)]);
  }
  const keep = parts.length - maxsplit;
  return new PyList([parts.slice(0, keep).join(sep), ...parts.slice(keep)]);
}

const CASED = /\p{L}/u;

/** A method that takes no arguments. */
function nullary<T>(name: string, impl: (self: T) => PyValue): Method {
  return (_rt, self, args, kwargs) => {
    if (args.length > 0 || (kwargs !== null && kwargs.size > 0)) {
      throw new TypeError(`${name}() takes no arguments (${args.length + (kwargs?.size ?? 0)} given)`);
    }
    return impl(self);
  };
}

const STR: MethodTable = Object.assign(Object.create(null), {
  upper: nullary('upper', (s: string) => s.toUpperCase()),
  lower: nullary('lower', (s: string) => s.toLowerCase()),
  casefold: nullary('casefold', (s: string) => s.toLowerCase()),
  strip: (_rt, s: string, args) => stripChars(s, args, true, true, 'strip'),
  lstrip: (_rt, s: string, args) => stripChars(s, args, true, false, 'lstrip'),
  rstrip: (_rt, s: string, args) => stripChars(s, args, false, true, 'rstrip'),

  replace(rt, s: string, args, kwargs) {
    arity('replace', args, 2, 3);
    const from = str('replace', args[0], 'argument 1');
    const to = str('replace', args[1], 'argument 2');
    const countArg = arg(args, kwargs, 2, 'count');
    let count = countArg === undefined ? -1 : int('replace', countArg);
    if (count === 0) return s;
    if (from === '') {
      const chars = strChars(s);
      const slots = count < 0 ? chars.length + 1 : Math.min(count, chars.length + 1);
      rt.checkString(s.length + slots * to.length);
      let out = '';
      for (let i = 0; i <= chars.length; i++) {
        if (i < slots) out += to;
        if (i < chars.length) out += chars[i];
      }
      return out;
    }
    if (to.length > from.length) {
      rt.checkString(s.length + Math.floor(s.length / from.length) * (to.length - from.length));
    }
    if (count < 0) return s.split(from).join(to);
    let out = '';
    let at = 0;
    while (count-- > 0) {
      const next = s.indexOf(from, at);
      if (next < 0) break;
      out += s.slice(at, next) + to;
      at = next + from.length;
    }
    return out + s.slice(at);
  },

  split: (_rt, s: string, args, kwargs) => split(s, args, kwargs, 'split', false),
  rsplit: (_rt, s: string, args, kwargs) => split(s, args, kwargs, 'rsplit', true),

  splitlines(_rt, s: string, args, kwargs) {
    const keepends = arg(args, kwargs, 0, 'keepends');
    const lines: string[] = [];
    const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
    let at = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      lines.push(s.slice(at, keepends ? re.lastIndex : m.index));
      at = re.lastIndex;
    }
    if (at < s.length) lines.push(s.slice(at));
    return new PyList(lines);
  },

  startswith: (_rt, s: string, args) => affix(s, args, 'startswith', (text, p) => text.startsWith(p)),
  endswith: (_rt, s: string, args) => affix(s, args, 'endswith', (text, p) => text.endsWith(p)),
  find: (_rt, s: string, args) => find(s, args, 'find', false),
  rfind: (_rt, s: string, args) => find(s, args, 'rfind', true),
  index(_rt, s: string, args) {
    const at = find(s, args, 'index', false);
    if (at < 0) throw new ValueError('substring not found');
    return at;
  },
  rindex(_rt, s: string, args) {
    const at = find(s, args, 'rindex', true);
    if (at < 0) throw new ValueError('substring not found');
    return at;
  },

  count(_rt, s: string, args) {
    arity('count', args, 1, 3);
    const sub = str('count', args[0]);
    const [start, end] = range(s, args, 1, 'count');
    const text = s.slice(start, end);
    if (sub === '') return strLength(text) + 1;
    let n = 0;
    for (let at = text.indexOf(sub); at >= 0; at = text.indexOf(sub, at + sub.length)) n++;
    return n;
  },

  join(rt, sep: string, args) {
    arity('join', args, 1);
    return andThen(rt.collect(args[0]), (items) => {
      let total = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item !== 'string') {
          throw new TypeError(`sequence item ${i}: expected str instance, ${typeName(item)} found`);
        }
        total += item.length + sep.length;
      }
      rt.checkString(total);
      return items.join(sep);
    });
  },

  isdigit: nullary('isdigit', (s: string) => /^[\p{Nd}²³¹⁰-⁹₀-₉]+$/u.test(s)),
  isdecimal: nullary('isdecimal', (s: string) => /^\p{Nd}+$/u.test(s)),
  isnumeric: nullary('isnumeric', (s: string) => /^\p{N}+$/u.test(s)),
  isalpha: nullary('isalpha', (s: string) => /^\p{L}+$/u.test(s)),
  isalnum: nullary('isalnum', (s: string) => /^[\p{L}\p{N}]+$/u.test(s)),
  isspace: nullary('isspace', (s: string) => /^\s+$/.test(s)),
  isascii: nullary('isascii', (s: string) => /^[\x00-\x7f]*$/.test(s)),
  isupper: nullary('isupper', (s: string) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s)),
  islower: nullary('islower', (s: string) => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s)),
  isidentifier: nullary('isidentifier', (s: string) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(s)),
  isprintable: nullary('isprintable', (s: string) => !/[\p{C}\p{Z}]/u.test(s.replace(/ /g, ''))),
  istitle(_rt, s: string) {
    let sawCased = false;
    let previousCased = false;
    for (const ch of s) {
      const upper = /\p{Lu}/u.test(ch);
      const lower = /\p{Ll}/u.test(ch);
      if (upper) {
        if (previousCased) return false;
        sawCased = true;
      } else if (lower && !previousCased) {
        return false;
      }
      previousCased = upper || lower;
    }
    return sawCased;
  },

  title(_rt, s: string) {
    let out = '';
    let previousCased = false;
    for (const ch of s) {
      const cased = CASED.test(ch);
      out += cased ? (previousCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      previousCased = cased;
    }
    return out;
  },
  capitalize(_rt, s: string) {
    const chars = strChars(s);
    return chars.length === 0 ? s : chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
  },
  swapcase(_rt, s: string) {
    let out = '';
    for (const ch of s) {
      const upper = ch.toUpperCase();
      out += ch === upper ? ch.toLowerCase() : upper;
    }
    return out;
  },

  zfill(rt, s: string, args) {
    arity('zfill', args, 1);
    const width = int('zfill', args[0]);
    const padding = width - strLength(s);
    if (padding <= 0) return s;
    rt.checkString(width);
    const signed = s[0] === '+' || s[0] === '-';
    return signed ? s[0] + '0'.repeat(padding) + s.slice(1) : '0'.repeat(padding) + s;
  },
  ljust: (rt, s: string, args) => justify(rt, s, args, 'ljust', 'left'),
  rjust: (rt, s: string, args) => justify(rt, s, args, 'rjust', 'right'),
  center: (rt, s: string, args) => justify(rt, s, args, 'center', 'center'),

  format: (_rt, s: string, args, kwargs) => strFormat(s, args, kwargs, getAttribute, (obj, key) => getItem(obj, key) as PyValue),
  format_map(_rt, s: string, args) {
    arity('format_map', args, 1);
    const mapping = args[0];
    if (!(mapping instanceof PyDict)) throw new TypeError('format_map() argument must be a dict');
    const kwargs = new Map<string, PyValue>();
    for (const [k, v] of mapping.map.values()) if (typeof k === 'string') kwargs.set(k, v);
    return strFormat(s, [], kwargs, getAttribute, (obj, key) => getItem(obj, key) as PyValue);
  },

  partition(_rt, s: string, args) {
    arity('partition', args, 1);
    const sep = str('partition', args[0]);
    if (sep === '') throw new ValueError('empty separator');
    const at = s.indexOf(sep);
    return new PyTuple(at < 0 ? [s, '', ''] : [s.slice(0, at), sep, s.slice(at + sep.length)]);
  },
  rpartition(_rt, s: string, args) {
    arity('rpartition', args, 1);
    const sep = str('rpartition', args[0]);
    if (sep === '') throw new ValueError('empty separator');
    const at = s.lastIndexOf(sep);
    return new PyTuple(at < 0 ? ['', '', s] : [s.slice(0, at), sep, s.slice(at + sep.length)]);
  },

  expandtabs(rt, s: string, args, kwargs) {
    const sizeArg = arg(args, kwargs, 0, 'tabsize');
    const size = sizeArg === undefined ? 8 : int('expandtabs', sizeArg);
    let out = '';
    let column = 0;
    for (const ch of s) {
      if (ch === '\t') {
        const spaces = size > 0 ? size - (column % size) : 0;
        out += ' '.repeat(spaces);
        column += spaces;
      } else {
        out += ch;
        column = ch === '\n' || ch === '\r' ? 0 : column + 1;
      }
      rt.checkString(out.length);
    }
    return out;
  },

  removeprefix(_rt, s: string, args) {
    arity('removeprefix', args, 1);
    const prefix = str('removeprefix', args[0]);
    return prefix !== '' && s.startsWith(prefix) ? s.slice(prefix.length) : s;
  },
  removesuffix(_rt, s: string, args) {
    arity('removesuffix', args, 1);
    const suffix = str('removesuffix', args[0]);
    return suffix !== '' && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
  },

  translate(_rt, s: string, args) {
    arity('translate', args, 1);
    const table = args[0];
    if (!(table instanceof PyDict)) throw new TypeError('translate() argument must be a dict');
    let out = '';
    for (const ch of s) {
      const mapped = dictGet(table, ch.codePointAt(0)!);
      if (mapped === undefined) out += ch;
      else if (mapped === null) continue;
      else if (typeof mapped === 'string') out += mapped;
      else if (typeof mapped === 'number') out += String.fromCodePoint(mapped);
      else throw new TypeError('character mapping must return integer, None or str');
    }
    return out;
  },
} satisfies MethodTable);

function maketrans(_rt: Runtime, args: PyValue[]): PyValue {
  arity('maketrans', args, 1, 3);
  const table = new PyDict();
  const [x, y, z] = args;
  if (args.length === 1) {
    if (!(x instanceof PyDict)) throw new TypeError('if you give only one argument to maketrans it must be a dict');
    for (const [k, v] of x.map.values()) {
      if (typeof k === 'string') {
        if (strLength(k) !== 1) throw new ValueError('string keys in translate table must be of length 1');
        dictSet(table, k.codePointAt(0)!, v);
      } else {
        dictSet(table, k, v);
      }
    }
    return table;
  }
  const from = strChars(str('maketrans', x, 'argument 1'));
  const to = strChars(str('maketrans', y, 'argument 2'));
  if (from.length !== to.length) throw new ValueError('the first two maketrans arguments must have equal length');
  from.forEach((ch, i) => dictSet(table, ch.codePointAt(0)!, to[i].codePointAt(0)!));
  if (z !== undefined) {
    for (const ch of strChars(str('maketrans', z, 'argument 3'))) dictSet(table, ch.codePointAt(0)!, null);
  }
  return table;
}

// ── list ────────────────────────────────────────────────────────────────────

function indexOf(items: PyValue[], args: PyValue[], name: string): number {
  arity('index', args, 1, 3);
  const length = items.length;
  const clamp = (v: PyValue | undefined, fallback: number) => {
    if (v === undefined) return fallback;
    let n = int('index', v);
    if (n < 0) n = Math.max(0, n + length);
    return Math.min(n, length);
  };
  const end = clamp(args[2], length);
  for (let i = clamp(args[1], 0); i < end; i++) if (sameOrEqual(items[i], args[0])) return i;
  throw new ValueError(name === 'list' ? 'list.index(x): x not in list' : 'tuple.index(x): x not in tuple');
}

function countOf(items: PyValue[], args: PyValue[]): number {
  arity('count', args, 1);
  let n = 0;
  for (const item of items) if (sameOrEqual(item, args[0])) n++;
  return n;
}

const LIST: MethodTable = Object.assign(Object.create(null), {
  append(_rt, list: PyList, args) {
    arity('append', args, 1);
    list.items.push(args[0]);
    return null;
  },
  extend(rt, list: PyList, args) {
    arity('extend', args, 1);
    return andThen(rt.collect(args[0]), (items) => {
      rt.checkCollection(list.items.length + items.length);
      const source = items === list.items ? items.slice() : items;
      for (const item of source) list.items.push(item);
      return null;
    });
  },
  insert(_rt, list: PyList, args) {
    arity('insert', args, 2);
    let at = int('insert', args[0]);
    if (at < 0) at = Math.max(0, at + list.items.length);
    list.items.splice(Math.min(at, list.items.length), 0, args[1]);
    return null;
  },
  pop(_rt, list: PyList, args) {
    arity('pop', args, 0, 1);
    const length = list.items.length;
    if (length === 0) throw new IndexError('pop from empty list');
    if (args.length === 0) return list.items.pop()!;
    const n = int('pop', args[0]);
    const at = n < 0 ? n + length : n;
    if (at < 0 || at >= length) throw new IndexError('pop index out of range');
    return list.items.splice(at, 1)[0];
  },
  remove(_rt, list: PyList, args) {
    arity('remove', args, 1);
    const at = list.items.findIndex((item) => sameOrEqual(item, args[0]));
    if (at < 0) throw new ValueError('list.remove(x): x not in list');
    list.items.splice(at, 1);
    return null;
  },
  index: (_rt, list: PyList, args) => indexOf(list.items, args, 'list'),
  count: (_rt, list: PyList, args) => countOf(list.items, args),
  reverse(_rt, list: PyList, args) {
    arity('reverse', args, 0);
    list.items.reverse();
    return null;
  },
  sort(rt, list: PyList, args, kwargs) {
    arity('sort', args, 0);
    rejectUnknown('sort', kwargs, ['key', 'reverse']);
    const reverse = kwargs?.get('reverse');
    return andThen(sortItems(rt, list.items, kwargs?.get('key'), reverse !== undefined && reverse !== false && reverse !== 0 && reverse !== null), (sorted) => {
      list.items = sorted;
      return null;
    });
  },
  clear(_rt, list: PyList, args) {
    arity('clear', args, 0);
    list.items = [];
    return null;
  },
  copy(_rt, list: PyList, args) {
    arity('copy', args, 0);
    return new PyList(list.items.slice());
  },
} satisfies MethodTable);

const TUPLE: MethodTable = Object.assign(Object.create(null), {
  index: (_rt, tuple: PyTuple, args) => indexOf(tuple.items, args, 'tuple'),
  count: (_rt, tuple: PyTuple, args) => countOf(tuple.items, args),
} satisfies MethodTable);

// ── dict ────────────────────────────────────────────────────────────────────

/** dict.update / dict(): merges a mapping or an iterable of key/value pairs. */
export function dictUpdate(rt: Runtime, dict: PyDict, source: PyValue | undefined, kwargs: Kwargs): MA<void> {
  const addKeywords = () => {
    if (kwargs) for (const [k, v] of kwargs) dictSet(dict, k, v);
  };
  if (source === undefined) return addKeywords();
  if (source instanceof PyDict) {
    for (const [k, v] of source.map.values()) dictSet(dict, k, v);
    return addKeywords();
  }
  return andThen(rt.collect(source), (pairs) => {
    pairs.forEach((pair, i) => {
      const items = pair instanceof PyTuple || pair instanceof PyList ? pair.items
        : typeof pair === 'string' ? strChars(pair) : undefined;
      if (items === undefined) {
        throw new TypeError(`cannot convert dictionary update sequence element #${i} to a sequence`);
      }
      if (items.length !== 2) {
        throw new ValueError(`dictionary update sequence element #${i} has length ${items.length}; 2 is required`);
      }
      dictSet(dict, items[0], items[1]);
    });
    addKeywords();
  });
}

const DICT: MethodTable = Object.assign(Object.create(null), {
  keys: nullary('keys', (dict: PyDict) => new PyDictView(dict, 'keys')),
  values: nullary('values', (dict: PyDict) => new PyDictView(dict, 'values')),
  items: nullary('items', (dict: PyDict) => new PyDictView(dict, 'items')),

  // Deliberate deviation from CPython: with a default given, a key holding
  // None also returns the default, so `row.get("amount", 0)` survives JSON nulls.
  get(_rt, dict: PyDict, args) {
    arity('get', args, 1, 2);
    const value = dictGet(dict, args[0]);
    if (value === undefined || (value === null && args.length > 1)) return args.length > 1 ? args[1] : null;
    return value;
  },
  pop(_rt, dict: PyDict, args) {
    arity('pop', args, 1, 2);
    const value = dictGet(dict, args[0]);
    if (value !== undefined) {
      dictDelete(dict, args[0]);
      return value;
    }
    if (args.length > 1) return args[1];
    throw keyError(args[0]);
  },
  popitem(_rt, dict: PyDict, args) {
    arity('popitem', args, 0);
    let last: [PyValue, PyValue] | undefined;
    for (const entry of dict.map.values()) last = entry;
    if (!last) throw new KeyError("'popitem(): dictionary is empty'");
    dictDelete(dict, last[0]);
    return new PyTuple([last[0], last[1]]);
  },
  setdefault(_rt, dict: PyDict, args) {
    arity('setdefault', args, 1, 2);
    const existing = dictGet(dict, args[0]);
    if (existing !== undefined) return existing;
    const value = args.length > 1 ? args[1] : null;
    dictSet(dict, args[0], value);
    return value;
  },
  update(rt, dict: PyDict, args, kwargs) {
    arity('update', args, 0, 1);
    return andThen(dictUpdate(rt, dict, args[0], kwargs), () => null);
  },
  clear: nullary('clear', (dict: PyDict) => {
    dict.map.clear();
    return null;
  }),
  copy: nullary('copy', (dict: PyDict) => copyDict(dict)),
} satisfies MethodTable);

function fromkeys(rt: Runtime, args: PyValue[]): MA<PyValue> {
  arity('fromkeys', args, 1, 2);
  const value = args.length > 1 ? args[1] : null;
  return andThen(rt.collect(args[0]), (keys) => {
    const dict = new PyDict();
    for (const key of keys) dictSet(dict, key, value);
    return dict;
  });
}

// ── set ─────────────────────────────────────────────────────────────────────

/** Folds every iterable in `others` into one set of their members. */
function setOf(rt: Runtime, others: PyValue[]): MA<PySet[]> {
  const out: PySet[] = [];
  const step = (i: number): MA<PySet[]> => {
    for (; i < others.length; i++) {
      const other = others[i];
      if (other instanceof PySet) {
        out.push(other);
        continue;
      }
      const items = rt.collect(other);
      if (items instanceof Promise) {
        const at = i;
        return items.then((resolved) => {
          out.push(pySetFrom(resolved));
          return step(at + 1);
        });
      }
      out.push(pySetFrom(items));
    }
    return out;
  };
  return step(0);
}

function combine(kind: 'union' | 'intersection' | 'difference' | 'symmetric', base: PySet, others: PySet[]): PySet {
  let result = copySet(base);
  for (const other of others) {
    if (kind === 'union') {
      for (const [k, v] of other.map) if (!result.map.has(k)) result.map.set(k, v);
    } else if (kind === 'intersection') {
      for (const k of Array.from(result.map.keys())) if (!other.map.has(k)) result.map.delete(k);
    } else if (kind === 'difference') {
      for (const k of other.map.keys()) result.map.delete(k);
    } else {
      const next = new PySet();
      for (const [k, v] of result.map) if (!other.map.has(k)) next.map.set(k, v);
      for (const [k, v] of other.map) if (!result.map.has(k)) next.map.set(k, v);
      result = next;
    }
  }
  return result;
}

function setMethod(kind: Parameters<typeof combine>[0], inPlace: boolean): Method {
  return (rt, set: PySet, args) => andThen(setOf(rt, args), (others) => {
    const result = combine(kind, set, others);
    if (!inPlace) return result;
    set.map = result.map;
    return null;
  });
}

const SET: MethodTable = Object.assign(Object.create(null), {
  add(_rt, set: PySet, args) {
    arity('add', args, 1);
    setAdd(set, args[0]);
    return null;
  },
  remove(_rt, set: PySet, args) {
    arity('remove', args, 1);
    if (!set.map.delete(hashKey(args[0], 'set element'))) throw keyError(args[0]);
    return null;
  },
  discard(_rt, set: PySet, args) {
    arity('discard', args, 1);
    set.map.delete(hashKey(args[0], 'set element'));
    return null;
  },
  pop(_rt, set: PySet, args) {
    arity('pop', args, 0);
    for (const [k, v] of set.map) {
      set.map.delete(k);
      return v;
    }
    throw new KeyError("'pop from an empty set'");
  },
  clear: nullary('clear', (set: PySet) => {
    set.map.clear();
    return null;
  }),
  copy: nullary('copy', (set: PySet) => copySet(set)),
  union: setMethod('union', false),
  intersection: setMethod('intersection', false),
  difference: setMethod('difference', false),
  symmetric_difference: setMethod('symmetric', false),
  update: setMethod('union', true),
  intersection_update: setMethod('intersection', true),
  difference_update: setMethod('difference', true),
  symmetric_difference_update: setMethod('symmetric', true),
  issubset: (rt, set: PySet, args) => andThen(setOf(rt, args.slice(0, 1)), ([other]) => isSubset(set, other)),
  issuperset: (rt, set: PySet, args) => andThen(setOf(rt, args.slice(0, 1)), ([other]) => isSubset(other, set)),
  isdisjoint: (rt, set: PySet, args) => andThen(setOf(rt, args.slice(0, 1)), ([other]) => {
    for (const k of set.map.keys()) if (other.map.has(k)) return false;
    return true;
  }),
} satisfies MethodTable);

// ── Lookup ──────────────────────────────────────────────────────────────────

/** The method table entry for `obj.name`, when obj is a built-in container or str. */
export function findMethod(obj: PyValue, name: string): Method | undefined {
  if (typeof obj === 'string') return STR[name];
  if (obj instanceof PyList) return LIST[name];
  if (obj instanceof PyDict) {
    const extra = obj.extraMethods;
    if (extra !== null && Object.hasOwn(extra, name)) return extra[name] as Method;
    return DICT[name];
  }
  if (obj instanceof PySet) return SET[name];
  if (obj instanceof PyTuple) return TUPLE[name];
  return undefined;
}

const TYPE_METHODS = new Map<PyType, MethodTable>([
  [T_STR, STR], [T_LIST, LIST], [T_DICT, DICT], [T_SET, SET], [T_TUPLE, TUPLE],
]);

const STATIC_METHODS = new Map<PyType, Record<string, PyBuiltin>>([
  [T_STR, { maketrans: new PyBuiltin('maketrans', (rt, args) => maketrans(rt, args)) }],
  [T_DICT, { fromkeys: new PyBuiltin('fromkeys', (rt, args) => fromkeys(rt, args)) }],
]);

function noAttribute(obj: PyValue, name: string): AttributeError {
  return new AttributeError(`'${typeName(obj)}' object has no attribute '${name}'`);
}

/** `T.name`: a static method, or a method that takes the instance first (`str.upper`). */
function typeAttribute(type: PyType, name: string): PyValue {
  if (name === '__name__') return type.name;
  const own = type.attrs?.get(name);
  if (own !== undefined) return own;
  const fixed = STATIC_METHODS.get(type);
  if (fixed && Object.hasOwn(fixed, name)) return fixed[name];
  const method = TYPE_METHODS.get(type)?.[name];
  if (method) {
    return new PyBuiltin(name, (rt, args, kwargs) => {
      if (args.length === 0 || typeOf(args[0]) !== type) {
        throw new TypeError(`descriptor '${name}' for '${type.name}' objects doesn't apply to a '${args.length ? typeName(args[0]) : 'NoneType'}' object`);
      }
      return method(rt, args[0], args.slice(1), kwargs);
    }, true);
  }
  throw new AttributeError(`type object '${type.name}' has no attribute '${name}'`);
}

function generatorAttribute(gen: PyGenerator, name: string): PyValue | undefined {
  switch (name) {
    case 'send':
      return new PyBuiltin('send', (rt, args) => {
        arity('send', args, 1);
        return andThen(rt.resume(gen, args[0]), (v) => {
          if (v === DONE) throw stopIteration(gen.returnValue);
          return v;
        });
      });
    case 'close':
      return new PyBuiltin('close', () => {
        gen.state = 'done';
        gen.frame = null;
        return null;
      });
    default:
      return undefined;
  }
}

/** StopIteration carrying a generator's return value, like CPython. */
export function stopIteration(value: PyValue = null): InterpreterError {
  const error = new StopIteration();
  if (value !== null) error.args = [value];
  return error;
}

export function getAttribute(obj: PyValue, name: string): PyValue {
  if (obj instanceof PyTuple) {
    const field = obj.getAttr(name);
    if (field !== undefined) return field;
  }
  const method = findMethod(obj, name);
  if (method !== undefined) {
    return new PyBuiltin(name, (rt, args, kwargs) => method(rt, obj, args, kwargs), true);
  }
  if (obj instanceof PyModule) {
    const value = obj.attrs.get(name);
    if (value === undefined) throw new AttributeError(`module '${obj.name}' has no attribute '${name}'`);
    return value;
  }
  if (obj instanceof PyType) return typeAttribute(obj, name);
  if (obj instanceof PyDate || obj instanceof PyDateTime || obj instanceof PyTimeDelta) {
    return getDatetimeAttr(obj, name);
  }
  let value: PyValue | undefined;
  if (obj instanceof PyObject) {
    value = obj.getAttr(name);
  } else if (obj instanceof InterpreterError) {
    if (name === 'args') value = new PyTuple(obj.args as PyValue[]);
    else if (name === 'value' && obj instanceof StopIteration) value = (obj.args[0] as PyValue | undefined) ?? null;
  } else if (obj instanceof PyGenerator) {
    value = generatorAttribute(obj, name);
  } else if (obj instanceof PyFunction || obj instanceof PyBuiltin) {
    if (name === '__name__') value = obj.name;
    else if (obj instanceof PyBuiltin) value = obj.attrs?.get(name);
  } else if (obj instanceof PyFloat) {
    if (name === 'is_integer') value = new PyBuiltin(name, () => Number.isInteger(obj.v));
  } else if (isIntLike(obj)) {
    if (name === 'bit_length') value = new PyBuiltin(name, () => bitLength(BigInt(obj)));
  }
  if (value === undefined) throw noAttribute(obj, name);
  return value;
}

