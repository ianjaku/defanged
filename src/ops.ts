/**
 * Operators: arithmetic, comparison, membership and subscripting for every
 * value type. The VM handles the int fast paths inline and calls in here for
 * everything else.
 */

import { datetimeBinaryOp, negateTimedelta } from './datetime';
import { IndexError, OverflowError, TypeError, ValueError } from './errors';
import { percentFormat } from './format';
import { PyFloat, intInvert, intNeg, isIntLike, isNum, numBinary } from './numbers';
import {
  MA, PyDict, PyDictView, PyGenerator, PyIterator, PyList, PyObject, PyRange, PySet,
  PySlice, PyTimeDelta, PyTuple, PyValue, Runtime,
  copyDict, dictDelete, dictGet, dictHas, dictSet, isAstral, keyError, pyCompare, pyEquals, pyIs, pySetFrom,
  sameOrEqual, setHas, strChars, andThen, typeName,
} from './values';
import { BinOp, CmpOp, UnOp } from './vm';

const BIN_SYMBOLS = ['+', '-', '*', '/', '//', '%', '**', '&', '|', '^', '<<', '>>'];

// ── Indexing helpers ────────────────────────────────────────────────────────

const MAX_INDEX = Number.MAX_SAFE_INTEGER;

/** An int-like value as a JS number, clamped for huge ints; undefined otherwise. */
export function asIndex(v: PyValue): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v > 0n ? MAX_INDEX : -MAX_INDEX;
  return undefined;
}

/** Resolves a slice against a sequence length: [start, stop, step, count]. */
export function sliceIndices(slice: PySlice, length: number): [number, number, number, number] {
  const part = (v: PyValue): number | null => {
    if (v === null) return null;
    const n = asIndex(v);
    if (n === undefined) throw new TypeError('slice indices must be integers or None or have an __index__ method');
    return n;
  };
  const step = part(slice.step) ?? 1;
  if (step === 0) throw new ValueError('slice step cannot be zero');
  const clamp = (v: number | null, fallback: number): number => {
    if (v === null) return fallback;
    if (v < 0) {
      v += length;
      return v < 0 ? (step < 0 ? -1 : 0) : v;
    }
    return v >= length ? (step < 0 ? length - 1 : length) : v;
  };
  const start = clamp(part(slice.start), step > 0 ? 0 : length - 1);
  const stop = clamp(part(slice.stop), step > 0 ? length : -1);
  const count = step > 0
    ? (stop > start ? Math.ceil((stop - start) / step) : 0)
    : (stop < start ? Math.ceil((start - stop) / -step) : 0);
  return [start, stop, step, count];
}

function sliceArray<T>(items: T[], slice: PySlice): T[] {
  const [start, stop, step, count] = sliceIndices(slice, items.length);
  if (step === 1) return items.slice(start, Math.max(start, stop));
  const out: T[] = new Array(count);
  for (let i = 0, j = start; i < count; i++, j += step) out[i] = items[j];
  return out;
}

function indexError(kind: string): IndexError {
  return new IndexError(`${kind} index out of range`);
}

function badIndex(kind: string, index: PyValue): TypeError {
  return new TypeError(`${kind} indices must be integers or slices, not ${typeName(index)}`);
}

// ── Subscripting ────────────────────────────────────────────────────────────

/** `obj[index]`. With `rt`, a dict subclass may compute a missing value, which
 *  can mean waiting on a tool; without it the lookup is always synchronous. */
export function getItem(obj: PyValue, index: PyValue, rt?: Runtime): MA<PyValue> {
  if (obj instanceof PyList || obj instanceof PyTuple) {
    const items = obj.items;
    if (typeof index === 'number') {
      const i = index < 0 ? index + items.length : index;
      if (i < 0 || i >= items.length) throw indexError(obj instanceof PyList ? 'list' : 'tuple');
      return items[i];
    }
    if (index instanceof PySlice) {
      const out = sliceArray(items, index);
      return obj instanceof PyList ? new PyList(out) : new PyTuple(out);
    }
    const i = asIndex(index);
    if (i === undefined) throw badIndex(obj instanceof PyList ? 'list' : 'tuple', index);
    return getItem(obj, i) as PyValue;
  }
  if (obj instanceof PyDict) {
    const value = dictGet(obj, index);
    if (value !== undefined) return value;
    const supplied = rt ? obj.missing(rt, index) : undefined;
    if (supplied === undefined) throw keyError(index);
    return supplied;
  }
  if (typeof obj === 'string') {
    if (index instanceof PySlice) {
      if (!isAstral(obj)) {
        const [start, stop, step] = sliceIndices(index, obj.length);
        if (step === 1) return obj.slice(start, Math.max(start, stop));
      }
      return sliceArray(strChars(obj), index).join('');
    }
    const n = asIndex(index);
    if (n === undefined) throw new TypeError(`string indices must be integers, not '${typeName(index)}'`);
    if (!isAstral(obj)) {
      const i = n < 0 ? n + obj.length : n;
      if (i < 0 || i >= obj.length) throw indexError('string');
      return obj[i];
    }
    const chars = strChars(obj);
    const i = n < 0 ? n + chars.length : n;
    if (i < 0 || i >= chars.length) throw indexError('string');
    return chars[i];
  }
  if (obj instanceof PyRange) {
    const length = obj.length;
    if (index instanceof PySlice) {
      const [start, stop, step] = sliceIndices(index, length);
      return new PyRange(obj.start + start * obj.step, obj.start + stop * obj.step, obj.step * step);
    }
    const n = asIndex(index);
    if (n === undefined) throw badIndex('range', index);
    const i = n < 0 ? n + length : n;
    if (i < 0 || i >= length) throw new IndexError('range object index out of range');
    return obj.start + i * obj.step;
  }
  if (obj instanceof PyObject) {
    const value = obj.getItem(index);
    if (value !== undefined) return value;
  }
  throw new TypeError(`'${typeName(obj)}' object is not subscriptable`);
}

export function setItem(rt: Runtime, obj: PyValue, index: PyValue, value: PyValue): MA<void> {
  if (obj instanceof PyList) {
    if (index instanceof PySlice) {
      return andThen(rt.collect(value), (items) => {
        const [start, stop, step, count] = sliceIndices(index, obj.items.length);
        // `a[::-1] = a` reads the list it is writing.
        if (items === obj.items) items = items.slice();
        if (step === 1) {
          // Not splice(...items): a large spread overflows the JS stack.
          obj.items = obj.items.slice(0, start).concat(items, obj.items.slice(Math.max(start, stop)));
        } else {
          if (items.length !== count) {
            throw new ValueError(`attempt to assign sequence of size ${items.length} to extended slice of size ${count}`);
          }
          for (let i = 0, j = start; i < count; i++, j += step) obj.items[j] = items[i];
        }
      });
    }
    const n = asIndex(index);
    if (n === undefined) throw badIndex('list', index);
    const i = n < 0 ? n + obj.items.length : n;
    if (i < 0 || i >= obj.items.length) throw new IndexError('list assignment index out of range');
    obj.items[i] = value;
    return;
  }
  if (obj instanceof PyDict) {
    dictSet(obj, index, value);
    return;
  }
  throw new TypeError(`'${typeName(obj)}' object does not support item assignment`);
}

export function deleteItem(obj: PyValue, index: PyValue): void {
  if (obj instanceof PyList) {
    if (index instanceof PySlice) {
      const [start, stop, step, count] = sliceIndices(index, obj.items.length);
      if (step === 1) {
        obj.items.splice(start, Math.max(0, stop - start));
      } else {
        const drop = new Set<number>();
        for (let i = 0, j = start; i < count; i++, j += step) drop.add(j);
        obj.items = obj.items.filter((_, i) => !drop.has(i));
      }
      return;
    }
    const n = asIndex(index);
    if (n === undefined) throw badIndex('list', index);
    const i = n < 0 ? n + obj.items.length : n;
    if (i < 0 || i >= obj.items.length) throw new IndexError('list assignment index out of range');
    obj.items.splice(i, 1);
    return;
  }
  if (obj instanceof PyDict) {
    if (!dictDelete(obj, index)) throw keyError(index);
    return;
  }
  throw new TypeError(`'${typeName(obj)}' object doesn't support item deletion`);
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

function repeatCount(n: PyValue): number {
  if (typeof n === 'bigint' && n > 0n) throw new OverflowError("cannot fit 'int' into an index-sized integer");
  const count = asIndex(n)!;
  return count < 0 ? 0 : count;
}

function repeatItems(rt: Runtime, items: PyValue[], n: PyValue): PyValue[] {
  const count = repeatCount(n);
  if (items.length === 0 || count === 0) return [];
  rt.checkCollection(items.length * count);
  const out: PyValue[] = [];
  for (let i = 0; i < count; i++) for (const item of items) out.push(item);
  return out;
}

function repeatString(rt: Runtime, s: string, n: PyValue): string {
  const count = repeatCount(n);
  if (s === '' || count === 0) return '';
  rt.checkString(s.length * count);
  return s.repeat(count);
}

function asSet(v: PyValue): PySet | undefined {
  if (v instanceof PySet) return v;
  if (v instanceof PyDictView && v.kind !== 'values') return pySetFrom(v.toArray());
  return undefined;
}

function setOperation(op: BinOp, a: PySet, b: PySet): PySet | undefined {
  const out = new PySet();
  switch (op) {
    case BinOp.OR:
      for (const [k, v] of a.map) out.map.set(k, v);
      for (const [k, v] of b.map) if (!out.map.has(k)) out.map.set(k, v);
      return out;
    case BinOp.AND:
      for (const [k, v] of a.map) if (b.map.has(k)) out.map.set(k, v);
      return out;
    case BinOp.SUB:
      for (const [k, v] of a.map) if (!b.map.has(k)) out.map.set(k, v);
      return out;
    case BinOp.XOR:
      for (const [k, v] of a.map) if (!b.map.has(k)) out.map.set(k, v);
      for (const [k, v] of b.map) if (!a.map.has(k)) out.map.set(k, v);
      return out;
    default:
      return undefined;
  }
}

/** Deliberate deviation from CPython: in `+`, `-` and `*`, None next to a
 *  number counts as 0, so sums over rows with null fields don't fail. */
function noneAsZero(op: BinOp, a: PyValue, b: PyValue): PyValue | undefined {
  if (op !== BinOp.ADD && op !== BinOp.SUB && op !== BinOp.MUL) return undefined;
  if (!(a === null || isNum(a)) || !(b === null || isNum(b))) return undefined;
  return numBinary(BIN_SYMBOLS[op], a ?? 0, b ?? 0);
}

/** `+ - * /` when a float meets a float or a small int, and `/` on two
 *  small ints: the common numeric cases, without the general dispatch. */
function floatArithmetic(op: BinOp, a: PyValue, b: PyValue): PyFloat | undefined {
  let x: number;
  let y: number;
  if (a instanceof PyFloat) {
    x = a.v;
    if (b instanceof PyFloat) y = b.v;
    else if (typeof b === 'number') y = b;
    else return undefined;
  } else if (typeof a === 'number') {
    x = a;
    if (b instanceof PyFloat) y = b.v;
    else if (typeof b === 'number' && op === BinOp.DIV) y = b;
    else return undefined;
  } else {
    return undefined;
  }
  switch (op) {
    case BinOp.ADD: return new PyFloat(x + y);
    case BinOp.SUB: return new PyFloat(x - y);
    case BinOp.MUL: return new PyFloat(x * y);
    // Division by zero takes the general path, which raises.
    case BinOp.DIV: return y === 0 ? undefined : new PyFloat(x / y);
    default: return undefined;
  }
}

export function binary(rt: Runtime, op: BinOp, a: PyValue, b: PyValue): PyValue {
  const fast = floatArithmetic(op, a, b);
  if (fast !== undefined) return fast;
  if (isNum(a) && isNum(b)) {
    // & | ^ on two bools stay bool.
    if (typeof a === 'boolean' && typeof b === 'boolean') {
      if (op === BinOp.AND) return a && b;
      if (op === BinOp.OR) return a || b;
      if (op === BinOp.XOR) return a !== b;
    }
    const r = numBinary(BIN_SYMBOLS[op], a, b);
    if (r !== undefined) return r;
  } else if (op === BinOp.ADD) {
    if (typeof a === 'string') {
      if (typeof b !== 'string') throw new TypeError(`can only concatenate str (not "${typeName(b)}") to str`);
      rt.checkString(a.length + b.length);
      return a + b;
    }
    if (a instanceof PyList && b instanceof PyList) {
      rt.checkCollection(a.items.length + b.items.length);
      return new PyList(a.items.concat(b.items));
    }
    if (a instanceof PyTuple && b instanceof PyTuple) {
      rt.checkCollection(a.items.length + b.items.length);
      return new PyTuple(a.items.concat(b.items));
    }
    if (a instanceof PyList || a instanceof PyTuple) {
      const kind = typeName(a);
      throw new TypeError(`can only concatenate ${kind} (not "${typeName(b)}") to ${kind}`);
    }
  } else if (op === BinOp.MUL) {
    if (typeof a === 'string' && isIntLike(b)) return repeatString(rt, a, b);
    if (typeof b === 'string' && isIntLike(a)) return repeatString(rt, b, a);
    if (a instanceof PyList && isIntLike(b)) return new PyList(repeatItems(rt, a.items, b));
    if (b instanceof PyList && isIntLike(a)) return new PyList(repeatItems(rt, b.items, a));
    if (a instanceof PyTuple && isIntLike(b)) return new PyTuple(repeatItems(rt, a.items, b));
    if (b instanceof PyTuple && isIntLike(a)) return new PyTuple(repeatItems(rt, b.items, a));
    if (typeof a === 'string' || a instanceof PyList || a instanceof PyTuple) {
      throw new TypeError(`can't multiply sequence by non-int of type '${typeName(b)}'`);
    }
  } else if (op === BinOp.MOD && typeof a === 'string') {
    return percentFormat(a, b);
  }

  if (a instanceof PyDict) {
    const r = a.binaryOp(BIN_SYMBOLS[op], b, false);
    if (r !== undefined) return r;
  }
  if (b instanceof PyDict) {
    const r = b.binaryOp(BIN_SYMBOLS[op], a, true);
    if (r !== undefined) return r;
  }
  const leftSet = asSet(a);
  if (leftSet) {
    const rightSet = asSet(b);
    if (rightSet) {
      const r = setOperation(op, leftSet, rightSet);
      if (r) return r;
    }
  }
  if (op === BinOp.OR && a instanceof PyDict && b instanceof PyDict) {
    const out = copyDict(a);
    for (const entry of b.map.values()) dictSet(out, entry[0], entry[1]);
    return out;
  }

  const symbol = BIN_SYMBOLS[op];
  const dt = datetimeBinaryOp(symbol, a, b);
  if (dt !== undefined) return dt;
  const lenient = noneAsZero(op, a, b);
  if (lenient !== undefined) return lenient;
  const shown = symbol === '**' ? '** or pow()' : symbol;
  throw new TypeError(`unsupported operand type(s) for ${shown}: '${typeName(a)}' and '${typeName(b)}'`);
}

/** `a op= b`: lists, sets and dicts update in place; everything else rebinds. */
export function inplace(rt: Runtime, op: BinOp, a: PyValue, b: PyValue): MA<PyValue> {
  if (a instanceof PyList) {
    if (op === BinOp.ADD) {
      return andThen(rt.collect(b), (items) => {
        rt.checkCollection(a.items.length + items.length);
        // `a += a` must not chase its own growing tail.
        const source = items === a.items ? items.slice() : items;
        for (const item of source) a.items.push(item);
        return a;
      });
    }
    if (op === BinOp.MUL && isIntLike(b)) {
      a.items = repeatItems(rt, a.items, b);
      return a;
    }
  } else if (a instanceof PySet && b instanceof PySet) {
    const r = setOperation(op, a, b);
    if (r) {
      a.map = r.map;
      return a;
    }
  } else if (a instanceof PyDict && b instanceof PyDict && op === BinOp.OR) {
    for (const entry of b.map.values()) dictSet(a, entry[0], entry[1]);
    return a;
  }
  return binary(rt, op, a, b);
}

/** Unary `-`, `+` and `~`; `not` is handled by the VM. */
export function unary(op: UnOp, v: PyValue): PyValue {
  if (isIntLike(v)) {
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    return op === UnOp.NEG ? intNeg(n) : op === UnOp.POS ? n : intInvert(n);
  }
  if (v instanceof PyFloat && op !== UnOp.INVERT) return op === UnOp.NEG ? new PyFloat(-v.v) : v;
  if (v instanceof PyTimeDelta && op !== UnOp.INVERT) return op === UnOp.NEG ? negateTimedelta(v) : v;
  const symbol = op === UnOp.NEG ? '-' : op === UnOp.POS ? '+' : '~';
  throw new TypeError(`bad operand type for unary ${symbol}: '${typeName(v)}'`);
}

// ── Comparison and membership ───────────────────────────────────────────────

export function contains(rt: Runtime, container: PyValue, item: PyValue): MA<boolean> {
  if (typeof container === 'string') {
    if (typeof item !== 'string') {
      throw new TypeError(`'in <string>' requires string as left operand, not ${typeName(item)}`);
    }
    return container.includes(item);
  }
  if (container instanceof PyList || container instanceof PyTuple) {
    const items = container.items;
    for (let i = 0; i < items.length; i++) if (sameOrEqual(items[i], item)) return true;
    return false;
  }
  if (container instanceof PyDict) return dictHas(container, item);
  if (container instanceof PySet) return setHas(container, item);
  if (container instanceof PyDictView) {
    if (container.kind === 'keys') return dictHas(container.dict, item);
    return container.toArray().some((v) => sameOrEqual(v, item));
  }
  if (container instanceof PyRange) {
    if (!isIntLike(item)) {
      if (!(item instanceof PyFloat) || !Number.isInteger(item.v)) return false;
      item = item.v;
    }
    const n = Number(item);
    const { start, stop, step } = container;
    if (step > 0 ? n < start || n >= stop : n > start || n <= stop) return false;
    return (n - start) % step === 0;
  }
  if (container instanceof PyObject) {
    const items = container.iterate();
    if (items !== undefined) return items.some((v) => sameOrEqual(v, item));
  }
  if (container instanceof PyGenerator || container instanceof PyIterator) {
    let found = false;
    return andThen(rt.forEach(container, (v) => (found = sameOrEqual(v, item))), () => found);
  }
  throw new TypeError(`argument of type '${typeName(container)}' is not a container or iterable`);
}

export function compare(rt: Runtime, op: CmpOp, a: PyValue, b: PyValue): MA<boolean> {
  switch (op) {
    case CmpOp.EQ: return pyEquals(a, b);
    case CmpOp.NE: return !pyEquals(a, b);
    case CmpOp.LT: return pyCompare('<', a, b);
    case CmpOp.GT: return pyCompare('>', a, b);
    case CmpOp.LE: return pyCompare('<=', a, b);
    case CmpOp.GE: return pyCompare('>=', a, b);
    case CmpOp.IN: return contains(rt, b, a);
    case CmpOp.NOT_IN: return andThen(contains(rt, b, a), (r) => !r);
    case CmpOp.IS: return pyIs(a, b);
    default: return !pyIs(a, b);
  }
}


