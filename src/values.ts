/**
 * Runtime values.
 *
 * Python values map onto JS as directly as possible: str/bool/None are JS
 * string/boolean/null, an int is a number (or bigint when large), and
 * everything else is an instance of one of the classes below.
 */

import type { Code } from './compiler';
import type { Frame } from './vm';
import { datetimeOrdering, datetimeRepr, datetimeStr, isoformatDate, isoformatDatetime } from './datetime';
import { InterpreterError, KeyError, MemoryError, RuntimeError, TypeError } from './errors';
import { PyFloat, floatRepr, intToString, isNum, normBig, numCompare, numEquals } from './numbers';

export { PyFloat };

// ── Value classes ───────────────────────────────────────────────────────────

export class PyList {
  constructor(public items: PyValue[]) {}
}

export class PyTuple {
  /** Its dict/set key once computed; a tuple and its hashable items never change. */
  hash: HashKey | undefined = undefined;
  constructor(public readonly items: PyValue[]) {}

  /** Subclasses such as namedtuple report their own type. */
  get pyType(): PyType {
    return T_TUPLE;
  }
  /** Subclasses may expose attributes; undefined means none by that name. */
  getAttr(_name: string): PyValue | undefined {
    return undefined;
  }
  /** How to print it; subclasses wrap the plain tuple text. */
  reprWith(inner: string): string {
    return inner;
  }
}

/**
 * Canonical Map key for a hashable value: two values share a key exactly
 * when they compare equal in Python (so True, 1 and 1.0 are one key).
 */
export type HashKey = string | number;

export class PyDict {
  /** hash key → [original key, value] */
  map = new Map<HashKey, [PyValue, PyValue]>();

  /** Subclasses such as Counter and defaultdict report their own type. */
  get pyType(): PyType {
    return T_DICT;
  }
  /** Methods a subclass adds on top of dict's; looked up before dict's own. */
  get extraMethods(): Record<string, unknown> | null {
    return null;
  }
  /** `d[key]` for a key that is absent; undefined means raise KeyError. May
   *  return a promise when producing the value had to wait on a tool. */
  missing(_rt: Runtime, _key: PyValue): MA<PyValue> | undefined {
    return undefined;
  }
  /** A binary operator the subclass defines; undefined means not handled. */
  binaryOp(_op: string, _other: PyValue, _reversed: boolean): PyValue | undefined {
    return undefined;
  }
  /** How to print it; subclasses wrap the `{...}` text. */
  reprWith(inner: string): string {
    return inner;
  }
}

export class PySet {
  /** hash key → member */
  map = new Map<HashKey, PyValue>();
}

export class PyRange {
  constructor(public readonly start: number, public readonly stop: number, public readonly step: number) {}

  get length(): number {
    const { start, stop, step } = this;
    if (step > 0) return stop > start ? Math.ceil((stop - start) / step) : 0;
    return stop < start ? Math.ceil((start - stop) / -step) : 0;
  }
}

export class PySlice {
  constructor(public readonly start: PyValue, public readonly stop: PyValue, public readonly step: PyValue) {}
}

/** Live view returned by dict.keys() / .values() / .items(). */
export class PyDictView {
  constructor(public readonly dict: PyDict, public readonly kind: 'keys' | 'values' | 'items') {}

  toArray(): PyValue[] {
    const out: PyValue[] = [];
    for (const [k, v] of this.dict.map.values()) {
      out.push(this.kind === 'keys' ? k : this.kind === 'values' ? v : new PyTuple([k, v]));
    }
    return out;
  }
}

export type Kwargs = Map<string, PyValue> | null;
export type MA<T> = T | Promise<T>;
export type NativeFn = (rt: Runtime, args: PyValue[], kwargs: Kwargs) => MA<PyValue>;

export class PyBuiltin {
  /** Attributes reachable as `fn.name`, such as `itertools.chain.from_iterable`. */
  attrs: Map<string, PyValue> | null = null;

  constructor(
    public readonly name: string,
    public readonly fn: NativeFn,
    /** Whether the function accepts keyword arguments at all. */
    public readonly kw: boolean = false,
  ) {}
}

/** A closure variable shared between a function and the scopes it captures. */
export class Cell {
  constructor(public v: PyValue | undefined = undefined) {}
}

export class PyFunction {
  constructor(
    public readonly name: string,
    public readonly code: Code,
    /** Defaults for the trailing positional parameters, evaluated at def time. */
    public readonly defaults: PyValue[],
    /** Defaults for keyword-only parameters, by name. */
    public readonly kwDefaults: Map<string, PyValue> | null,
    public readonly closure: Cell[] | null,
  ) {}
}

export class PyGenerator {
  state: 'created' | 'suspended' | 'running' | 'done' = 'created';
  /** Value of the generator's `return`, readable by `yield from`. */
  returnValue: PyValue = null;
  constructor(public readonly name: string, public frame: Frame | null) {}
}

/** The top-level variables of one interpreter, one fixed slot per name.
 *  An empty slot means the script has not defined that name. */
export class Globals {
  private readonly slots = new Map<string, number>();
  readonly names: string[] = [];
  readonly values: (PyValue | undefined)[] = [];

  slot(name: string): number {
    let index = this.slots.get(name);
    if (index === undefined) {
      index = this.names.length;
      this.slots.set(name, index);
      this.names.push(name);
      this.values.push(undefined);
    }
    return index;
  }

  set(name: string, value: PyValue): void {
    this.values[this.slot(name)] = value;
  }
}

/** Marks the end of iteration; never visible to scripts. */
export const DONE: unique symbol = Symbol('DONE');
export type Done = typeof DONE;

/** A lazy iterator implemented in JS (list iterators, zip, map, ...). */
export abstract class PyIterator {
  abstract readonly typeName: string;
  abstract next(rt: Runtime): MA<PyValue | Done>;
}

export class PyType {
  /** Called for `T(...)`; null means the type cannot be instantiated. */
  construct: NativeFn | null = null;
  /** Attributes reachable as `T.name` (static methods, constants). */
  attrs: Map<string, PyValue> | null = null;
  /** For exception types: the JS class instances are created from. */
  jsClass: (new (message?: string) => InterpreterError) | null = null;
  /** The shared type this one stands in for; identity checks compare these. */
  canonical: PyType = this;

  constructor(
    public readonly name: string,
    public readonly base: PyType | null = null,
    /** Dotted name used in error messages and repr, e.g. `datetime.date`. */
    public readonly qualName: string = name,
  ) {}

  isSubtypeOf(other: PyType): boolean {
    const target = other.canonical;
    for (let t: PyType | null = this.canonical; t; t = t.base) if (t.canonical === target) return true;
    return false;
  }
}

export class PyModule {
  constructor(
    public readonly name: string,
    public readonly attrs: Map<string, PyValue>,
    /** For a module with state (`random`): builds the copy one interpreter owns. */
    public readonly fresh: (() => PyModule) | null = null,
  ) {}
}

/** Base for objects defined by modules (regex patterns, match objects). */
export abstract class PyObject {
  abstract readonly typeName: string;
  getAttr(_name: string): PyValue | undefined {
    return undefined;
  }
  /** `obj[key]`; undefined means the object is not subscriptable. */
  getItem(_key: PyValue): PyValue | undefined {
    return undefined;
  }
  /** `len(obj)`; undefined means it has no length. */
  length(): number | undefined {
    return undefined;
  }
  /** The items `for x in obj` visits; undefined means not iterable. */
  iterate(): PyValue[] | undefined {
    return undefined;
  }
  /** Three-way ordering against `other` for `<` and sorting; undefined means
   *  the two cannot be ordered. May wait, since it can call back into Python. */
  compareTo(_rt: Runtime, _other: PyValue, _op: OrderOp): MA<number> | undefined {
    return undefined;
  }
  repr(): string {
    return `<${this.typeName} object>`;
  }
}

export class PyDate {
  constructor(public readonly year: number, public readonly month: number, public readonly day: number) {}
}

export class PyDateTime {
  constructor(
    public readonly year: number, public readonly month: number, public readonly day: number,
    public readonly hour: number, public readonly minute: number, public readonly second: number,
    public readonly microsecond: number,
  ) {}
}

/** Normalized like CPython: 0 <= seconds < 86400, 0 <= microseconds < 1e6 */
export class PyTimeDelta {
  constructor(public readonly days: number, public readonly seconds: number, public readonly microseconds: number) {}
}

class PyEllipsisType {}
export const ELLIPSIS = new PyEllipsisType();

export type PyValue =
  | number | bigint | string | boolean | null
  | PyFloat | PyList | PyTuple | PyDict | PySet | PyRange | PySlice | PyDictView
  | PyFunction | PyBuiltin | PyGenerator | PyIterator | PyType | PyModule | PyObject
  | PyDate | PyDateTime | PyTimeDelta | PyEllipsisType | InterpreterError;

/** What built-in functions may ask of the VM that is running them. */
export interface Runtime {
  call(fn: PyValue, args: PyValue[], kwargs?: Kwargs): MA<PyValue>;
  /** Visits each item; `visit` returns true to stop early. */
  forEach(iterable: PyValue, visit: (item: PyValue) => boolean | void): MA<void>;
  /** All items as an array. May return the container's own array: do not mutate. */
  collect(iterable: PyValue): MA<PyValue[]>;
  iter(iterable: PyValue): PyValue;
  next(iterator: PyValue): MA<PyValue | Done>;
  /** Resumes a generator, delivering `sent` as the value of its pending yield. */
  resume(gen: PyGenerator, sent: PyValue): MA<PyValue | Done>;
  /** Raise MemoryError when a result would exceed the host's limits. */
  checkString(length: number): void;
  checkCollection(size: number): void;
}

/** Runs `fn` on `value` now if it is ready, or after it resolves. */
export function andThen<T, U>(value: MA<T>, fn: (v: T) => MA<U>): MA<U> {
  return value instanceof Promise ? value.then(fn) : fn(value);
}

// ── Type objects ────────────────────────────────────────────────────────────

export const T_INT = new PyType('int');
export const T_BOOL = new PyType('bool', T_INT);
export const T_FLOAT = new PyType('float');
export const T_STR = new PyType('str');
export const T_NONE = new PyType('NoneType');
export const T_LIST = new PyType('list');
export const T_TUPLE = new PyType('tuple');
export const T_DICT = new PyType('dict');
export const T_SET = new PyType('set');
export const T_RANGE = new PyType('range');
export const T_SLICE = new PyType('slice');
export const T_FUNCTION = new PyType('function');
export const T_BUILTIN = new PyType('builtin_function_or_method');
export const T_GENERATOR = new PyType('generator');
export const T_TYPE = new PyType('type');
export const T_MODULE = new PyType('module');
export const T_ELLIPSIS = new PyType('ellipsis');
export const T_DATE = new PyType('date', null, 'datetime.date');
export const T_DATETIME = new PyType('datetime', T_DATE, 'datetime.datetime');
export const T_TIMEDELTA = new PyType('timedelta', null, 'datetime.timedelta');
const T_DICT_KEYS = new PyType('dict_keys');
const T_DICT_VALUES = new PyType('dict_values');
const T_DICT_ITEMS = new PyType('dict_items');

const namedTypes = new Map<string, PyType>();
/** Type object for iterators and module-defined objects, one per name. */
export function namedType(name: string): PyType {
  let t = namedTypes.get(name);
  if (!t) namedTypes.set(name, (t = new PyType(name.split('.').pop()!, null, name)));
  return t;
}

const exceptionTypes = new Map<Function, PyType>();
/** Type object for an exception class, mirroring the JS class hierarchy. */
export function exceptionType(cls: Function): PyType {
  let t = exceptionTypes.get(cls);
  if (!t) {
    const parent = Object.getPrototypeOf(cls);
    const base = cls === InterpreterError ? null : exceptionType(parent);
    t = new PyType((cls as typeof InterpreterError).pyName, base);
    t.jsClass = cls as new (message?: string) => InterpreterError;
    exceptionTypes.set(cls, t);
  }
  return t;
}

export function typeOf(v: PyValue): PyType {
  switch (typeof v) {
    case 'number': case 'bigint': return T_INT;
    case 'string': return T_STR;
    case 'boolean': return T_BOOL;
  }
  if (v === null) return T_NONE;
  if (v instanceof PyFloat) return T_FLOAT;
  if (v instanceof PyList) return T_LIST;
  if (v instanceof PyTuple) return v.pyType;
  if (v instanceof PyDict) return v.pyType;
  if (v instanceof PySet) return T_SET;
  if (v instanceof PyFunction) return T_FUNCTION;
  if (v instanceof PyBuiltin) return T_BUILTIN;
  if (v instanceof PyRange) return T_RANGE;
  if (v instanceof PyDictView) return v.kind === 'keys' ? T_DICT_KEYS : v.kind === 'values' ? T_DICT_VALUES : T_DICT_ITEMS;
  if (v instanceof PyGenerator) return T_GENERATOR;
  if (v instanceof PyIterator) return namedType(v.typeName);
  if (v instanceof PyType) return T_TYPE;
  if (v instanceof PyModule) return T_MODULE;
  if (v instanceof PyDateTime) return T_DATETIME;
  if (v instanceof PyDate) return T_DATE;
  if (v instanceof PyTimeDelta) return T_TIMEDELTA;
  if (v instanceof InterpreterError) return exceptionType(v.constructor);
  if (v instanceof PySlice) return T_SLICE;
  if (v instanceof PyObject) return namedType(v.typeName);
  return T_ELLIPSIS;
}

/** CPython's name for a value's type, as error messages spell it. */
export function typeName(v: PyValue): string {
  return typeOf(v).qualName;
}

// ── Truthiness ──────────────────────────────────────────────────────────────

export function truthy(v: PyValue): boolean {
  switch (typeof v) {
    case 'boolean': return v;
    case 'number': return v !== 0;
    case 'string': return v.length > 0;
    case 'bigint': return v !== 0n;
  }
  if (v === null) return false;
  if (v instanceof PyList || v instanceof PyTuple) return v.items.length > 0;
  if (v instanceof PyDict || v instanceof PySet) return v.map.size > 0;
  if (v instanceof PyFloat) return v.v !== 0;
  if (v instanceof PyObject) {
    const n = v.length();
    if (n !== undefined) return n > 0;
  }
  if (v instanceof PyRange) return v.length > 0;
  if (v instanceof PyDictView) return v.dict.map.size > 0;
  if (v instanceof PyTimeDelta) return v.days !== 0 || v.seconds !== 0 || v.microseconds !== 0;
  return true;
}

// ── Equality and ordering ───────────────────────────────────────────────────

/** Equality as containers apply it: the same object always matches, which
 *  is what makes `nan in [nan]` true for one nan object. */
export function sameOrEqual(a: PyValue, b: PyValue): boolean {
  return a === b || pyEquals(a, b);
}

function itemsEqual(a: PyValue[], b: PyValue[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameOrEqual(a[i], b[i])) return false;
  return true;
}

export function pyEquals(a: PyValue, b: PyValue): boolean {
  const ta = typeof a;
  if (ta === 'string' || a === null) return a === b;
  if (ta === 'number' && typeof b === 'number') return a === b;
  if (isNum(a)) return isNum(b) && numEquals(a, b);
  if (typeof b !== 'object' || b === null) return false;
  if (a === b) return true;
  if (a instanceof PyList) return b instanceof PyList && itemsEqual(a.items, b.items);
  if (a instanceof PyTuple) return b instanceof PyTuple && itemsEqual(a.items, b.items);
  if (a instanceof PyDict) {
    if (!(b instanceof PyDict) || a.map.size !== b.map.size) return false;
    for (const [hk, entry] of a.map) {
      const other = b.map.get(hk);
      if (other === undefined || !sameOrEqual(entry[1], other[1])) return false;
    }
    return true;
  }
  if (a instanceof PySet || (a instanceof PyDictView && a.kind !== 'values')) {
    const left = a instanceof PySet ? a : pySetFrom(a.toArray());
    let right: PySet;
    if (b instanceof PySet) right = b;
    else if (b instanceof PyDictView && b.kind !== 'values') right = pySetFrom(b.toArray());
    else return false;
    if (left.map.size !== right.map.size) return false;
    for (const hk of left.map.keys()) if (!right.map.has(hk)) return false;
    return true;
  }
  if (a instanceof PyRange) {
    if (!(b instanceof PyRange)) return false;
    const n = a.length;
    if (n !== b.length) return false;
    return n === 0 || (a.start === b.start && (n === 1 || a.step === b.step));
  }
  if (a instanceof PyDateTime) {
    return b instanceof PyDateTime && a.year === b.year && a.month === b.month && a.day === b.day &&
      a.hour === b.hour && a.minute === b.minute && a.second === b.second && a.microsecond === b.microsecond;
  }
  if (a instanceof PyDate) {
    return b instanceof PyDate && a.year === b.year && a.month === b.month && a.day === b.day;
  }
  if (a instanceof PyTimeDelta) {
    return b instanceof PyTimeDelta && a.days === b.days && a.seconds === b.seconds && a.microseconds === b.microseconds;
  }
  if (a instanceof PyType) return b instanceof PyType && a.canonical === b.canonical;
  return false;
}

/** `a is b`. Small ints, strings and the singletons behave as interned. */
export function pyIs(a: PyValue, b: PyValue): boolean {
  if (a instanceof PyType && b instanceof PyType) return a.canonical === b.canonical;
  return a === b;
}

export function isSubset(a: PySet, b: PySet): boolean {
  if (a.map.size > b.map.size) return false;
  for (const hk of a.map.keys()) if (!b.map.has(hk)) return false;
  return true;
}

export type OrderOp = '<' | '>' | '<=' | '>=';

export function orderResult(op: OrderOp, c: number): boolean {
  switch (op) {
    case '<': return c < 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    default: return c >= 0;
  }
}

/** Evaluates `a <op> b`, raising TypeError for types that have no ordering. */
export function pyCompare(op: OrderOp, a: PyValue, b: PyValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return orderResult(op, a - b);
  if (typeof a === 'string' && typeof b === 'string') return orderResult(op, a < b ? -1 : a > b ? 1 : 0);
  if (isNum(a) && isNum(b)) return orderResult(op, numCompare(a, b));
  if ((a instanceof PyList && b instanceof PyList) || (a instanceof PyTuple && b instanceof PyTuple)) {
    const x = a.items, y = (b as PyList | PyTuple).items;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      if (!pyEquals(x[i], y[i])) return pyCompare(op, x[i], y[i]);
    }
    return orderResult(op, x.length - y.length);
  }
  if (a instanceof PySet && b instanceof PySet) {
    switch (op) {
      case '<=': return isSubset(a, b);
      case '<': return a.map.size < b.map.size && isSubset(a, b);
      case '>=': return isSubset(b, a);
      default: return a.map.size > b.map.size && isSubset(b, a);
    }
  }
  const dt = datetimeOrdering(a, b);
  if (dt !== undefined) return orderResult(op, dt);
  throw new TypeError(`'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

/** Ascending three-way comparison for sorting, built on `<` like CPython. */
export function sortCompare(a: PyValue, b: PyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (pyCompare('<', a, b)) return -1;
  if (pyCompare('<', b, a)) return 1;
  return 0;
}

// ── Hashing ─────────────────────────────────────────────────────────────────

const identityIds = new WeakMap<object, number>();
let nextIdentityId = 1;

/** Stable per-object number, used for `id()` and identity-based hashing. */
export function identityOf(v: object): number {
  let id = identityIds.get(v);
  if (id === undefined) identityIds.set(v, (id = nextIdentityId++));
  return id;
}

/** Map key for a hashable value: equal values get equal keys. Non-string
 *  keys are encoded with a NUL prefix so they cannot collide with a string.
 *  `usage` names the container for the unhashable-type error. */
export function hashKey(v: PyValue, usage?: 'dict key' | 'set element'): HashKey {
  switch (typeof v) {
    case 'string': return v.charCodeAt(0) === 0 ? '\x00s' + v : v;
    case 'number': return v;
    case 'boolean': return v ? 1 : 0;
    case 'bigint': return '\x00n' + v.toString();
  }
  if (v === null) return '\x00N';
  if (v instanceof PyFloat) {
    const x = v.v;
    if (Number.isInteger(x) && !Number.isSafeInteger(x)) return '\x00n' + BigInt(x).toString();
    return x;
  }
  if (v instanceof PyTuple) {
    if (v.hash !== undefined) return v.hash;
    // Each item is written as "<length>:<key>", so no two tuples share a key.
    let key = '\x00t';
    for (const item of v.items) {
      const k = hashKey(item, usage);
      const part = typeof k === 'number' ? '#' + k : 's' + k;
      key += part.length + ':' + part;
    }
    return (v.hash = key);
  }
  if (v instanceof PyDateTime) {
    return `\x00dt${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}.${v.microsecond}`;
  }
  if (v instanceof PyDate) return `\x00d${v.year}-${v.month}-${v.day}`;
  if (v instanceof PyTimeDelta) return `\x00td${v.days}:${v.seconds}:${v.microseconds}`;
  if (v instanceof PyRange) return `\x00r${v.start}:${v.stop}:${v.step}`;
  if (v instanceof PyList || v instanceof PyDict || v instanceof PySet || v instanceof PySlice || v instanceof PyDictView) {
    const name = typeName(v);
    throw new TypeError(usage
      ? `cannot use '${name}' as a ${usage} (unhashable type: '${name}')`
      : `unhashable type: '${name}'`);
  }
  return '\x00o' + identityOf(v instanceof PyType ? v.canonical : (v as object));
}

// ── Dict / set access ───────────────────────────────────────────────────────

export function dictGet(d: PyDict, key: PyValue): PyValue | undefined {
  const entry = d.map.get(hashKey(key, 'dict key'));
  return entry === undefined ? undefined : entry[1];
}

export function dictSet(d: PyDict, key: PyValue, value: PyValue): void {
  const hk = hashKey(key, 'dict key');
  const entry = d.map.get(hk);
  // CPython keeps the first-inserted key object and updates the value.
  if (entry) entry[1] = value;
  else d.map.set(hk, [key, value]);
}

export function dictHas(d: PyDict, key: PyValue): boolean {
  return d.map.has(hashKey(key, 'dict key'));
}

export function dictDelete(d: PyDict, key: PyValue): boolean {
  return d.map.delete(hashKey(key, 'dict key'));
}

export function dictKeys(d: PyDict): PyValue[] {
  return Array.from(d.map.values(), (e) => e[0]);
}

export function copyDict(d: PyDict): PyDict {
  const copy = new PyDict();
  for (const [hk, entry] of d.map) copy.map.set(hk, [entry[0], entry[1]]);
  return copy;
}

export function copySet(s: PySet): PySet {
  const copy = new PySet();
  for (const [hk, member] of s.map) copy.map.set(hk, member);
  return copy;
}

export function setAdd(s: PySet, v: PyValue): void {
  const hk = hashKey(v, 'set element');
  if (!s.map.has(hk)) s.map.set(hk, v);
}

export function setHas(s: PySet, v: PyValue): boolean {
  return s.map.has(hashKey(v, 'set element'));
}

export function pySetFrom(values: Iterable<PyValue>): PySet {
  const s = new PySet();
  for (const v of values) setAdd(s, v);
  return s;
}

export function keyError(key: PyValue): KeyError {
  const e = new KeyError(pyRepr(key));
  e.args = [key];
  return e;
}

// ── Strings (code-point semantics over UTF-16) ──────────────────────────────

const SURROGATE = /[\ud800-\udfff]/;

// Answers for the last long string asked about, so a loop that indexes one
// string does not rescan it on every step.
let cachedString = '';
let cachedAstral = false;
let cachedChars: string[] | null = null;

/** True when indexing by UTF-16 unit and by code point would differ. */
export function isAstral(s: string): boolean {
  if (s.length < 64) return SURROGATE.test(s);
  if (s !== cachedString) {
    cachedAstral = SURROGATE.test(s);
    cachedChars = null;
  }
  // Keep this very object: comparing it with itself next time is instant,
  // while an equal string held elsewhere would be compared char by char.
  cachedString = s;
  return cachedAstral;
}

export function strLength(s: string): number {
  return isAstral(s) ? strChars(s).length : s.length;
}

/** The string as one entry per code point. Do not mutate the result. */
export function strChars(s: string): string[] {
  if (!isAstral(s)) return s.split('');
  if (s.length < 64) return Array.from(s);
  return (cachedChars ??= Array.from(s));
}

// ── Iterators ───────────────────────────────────────────────────────────────

/** Iterates an array by index, so appends during the loop are seen. */
export class SeqIterator extends PyIterator {
  index = 0;
  constructor(public readonly items: PyValue[], public readonly typeName: string = 'list_iterator') {
    super();
  }
  next(): PyValue | Done {
    return this.index < this.items.length ? this.items[this.index++] : DONE;
  }
}

export class RangeIterator extends PyIterator {
  readonly typeName = 'range_iterator';
  private current: number;
  private remaining: number;
  constructor(private readonly range: PyRange) {
    super();
    this.current = range.start;
    this.remaining = range.length;
  }
  next(): PyValue | Done {
    if (this.remaining <= 0) return DONE;
    this.remaining--;
    const v = this.current;
    this.current += this.range.step;
    return v;
  }
}

/** Iterates a dict or set snapshot and fails if the container is resized. */
export class HashIterator extends PyIterator {
  private index = 0;
  private readonly size: number;
  constructor(
    private readonly owner: PyDict | PySet,
    private readonly items: PyValue[],
    public readonly typeName: string,
  ) {
    super();
    this.size = owner.map.size;
  }
  next(): PyValue | Done {
    if (this.owner.map.size !== this.size) {
      const kind = this.owner instanceof PyDict ? 'dictionary' : 'Set';
      throw new RuntimeError(`${kind} changed size during iteration`);
    }
    return this.index < this.items.length ? this.items[this.index++] : DONE;
  }
}

// ── String representation ───────────────────────────────────────────────────

export function strRepr(s: string): string {
  if (/^[\x20-\x26\x28-\x5b\x5d-\x7e]*$/.test(s)) return `'${s}'`;
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (c >= 0xd800 && c <= 0xdfff) out += '\\u' + c.toString(16);
    else out += ch;
  }
  return out + quote;
}

function joinRepr(items: PyValue[], seen: Set<object>): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ', ';
    out += reprOf(items[i], seen);
  }
  return out;
}

function reprOf(v: PyValue, seen: Set<object>): string {
  switch (typeof v) {
    case 'number': return String(v);
    case 'string': return strRepr(v);
    case 'boolean': return v ? 'True' : 'False';
    case 'bigint': return intToString(v);
  }
  if (v === null) return 'None';
  if (v instanceof PyFloat) return floatRepr(v.v);
  if (v instanceof PyList || v instanceof PyTuple || v instanceof PyDict || v instanceof PySet) {
    // A container that contains itself prints as `[...]`, like CPython.
    if (seen.has(v)) return v instanceof PyList ? '[...]' : v instanceof PyDict ? '{...}' : '...';
    seen.add(v);
    let out: string;
    if (v instanceof PyList) {
      out = `[${joinRepr(v.items, seen)}]`;
    } else if (v instanceof PyTuple) {
      out = v.reprWith(v.items.length === 1 ? `(${reprOf(v.items[0], seen)},)` : `(${joinRepr(v.items, seen)})`);
    } else if (v instanceof PyDict) {
      const parts: string[] = [];
      for (const [k, val] of v.map.values()) parts.push(`${reprOf(k, seen)}: ${reprOf(val, seen)}`);
      out = v.reprWith(`{${parts.join(', ')}}`);
    } else {
      out = v.map.size === 0 ? 'set()' : `{${joinRepr(Array.from(v.map.values()), seen)}}`;
    }
    seen.delete(v);
    return out;
  }
  if (v instanceof PyFunction) return `<function ${v.name}>`;
  if (v instanceof PyBuiltin) return `<built-in function ${v.name}>`;
  if (v instanceof PyType) return `<class '${v.qualName}'>`;
  if (v instanceof PyRange) {
    return v.step === 1 ? `range(${v.start}, ${v.stop})` : `range(${v.start}, ${v.stop}, ${v.step})`;
  }
  if (v instanceof PyDictView) return `dict_${v.kind}([${joinRepr(v.toArray(), seen)}])`;
  if (v instanceof PyGenerator) return `<generator object ${v.name}>`;
  if (v instanceof PyIterator) return `<${v.typeName} object>`;
  if (v instanceof PyModule) return `<module '${v.name}'>`;
  if (v instanceof PyDate || v instanceof PyDateTime || v instanceof PyTimeDelta) return datetimeRepr(v);
  if (v instanceof InterpreterError) {
    const args = v.args as PyValue[];
    return `${(v.constructor as typeof InterpreterError).pyName}(${joinRepr(args, seen)})`;
  }
  if (v instanceof PySlice) return `slice(${reprOf(v.start, seen)}, ${reprOf(v.stop, seen)}, ${reprOf(v.step, seen)})`;
  if (v instanceof PyObject) return v.repr();
  return 'Ellipsis';
}

export function pyRepr(v: PyValue): string {
  if (typeof v === 'number') return String(v);
  return reprOf(v, new Set());
}

export function pyStr(v: PyValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof PyDate || v instanceof PyDateTime || v instanceof PyTimeDelta) return datetimeStr(v);
  if (v instanceof InterpreterError) {
    const args = v.args as PyValue[];
    if (args.length === 0) return '';
    if (v instanceof KeyError) return pyRepr(args[0]);
    return args.length === 1 ? pyStr(args[0]) : pyRepr(new PyTuple(args));
  }
  return pyRepr(v);
}

// ── Conversion to/from JavaScript ───────────────────────────────────────────

/** Converts a JS Date (an instant) to a naive datetime. Defaults to the UTC
 *  wall clock; the interpreter passes a converter for the session timezone. */
export type DateConverter = (date: Date) => PyDateTime;

const utcDateConverter: DateConverter = (date) => new PyDateTime(
  date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
  date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds() * 1000,
);

export function jsToValue(js: any, convertDate: DateConverter = utcDateConverter): PyValue {
  if (js === null || js === undefined) return null;
  switch (typeof js) {
    case 'number': return Number.isSafeInteger(js) ? js : new PyFloat(js);
    case 'string': case 'boolean': return js;
    case 'bigint': return normBig(js);
    case 'object': {
      if (Array.isArray(js)) return new PyList(js.map((el) => jsToValue(el, convertDate)));
      if (js instanceof Date) return convertDate(js);
      const dict = new PyDict();
      const entries = js instanceof Map ? js.entries() : Object.entries(js);
      for (const [key, value] of entries) {
        dictSet(dict, jsToValue(key, convertDate), jsToValue(value, convertDate));
      }
      return dict;
    }
  }
  throw new Error(`Cannot convert JavaScript value to Python: ${typeof js}`);
}

/** JS object keys are strings: str keys pass through, numbers and booleans
 *  use their JS spelling, anything else (tuples, dates, None) its Python repr. */
function dictKeyToJsKey(key: PyValue): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number' || typeof key === 'boolean' || typeof key === 'bigint') return String(key);
  if (key instanceof PyFloat) return String(key.v);
  return pyRepr(key);
}

/** Sets an own property even for `__proto__`, which plain assignment would
 *  turn into a prototype change on the object the host receives. */
export function setOwn(obj: Record<string, any>, key: string, value: any): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

export function valueToJs(v: PyValue, maxCollectionSize: number = Infinity): any {
  switch (typeof v) {
    case 'number': case 'string': case 'boolean': return v;
    case 'bigint': return Number(v);
  }
  if (v === null) return null;
  if (v instanceof PyFloat) return v.v;
  if (v instanceof PyList || v instanceof PyTuple) return v.items.map((el) => valueToJs(el, maxCollectionSize));
  if (v instanceof PyDict) {
    const obj: Record<string, any> = {};
    for (const [key, val] of v.map.values()) setOwn(obj, dictKeyToJsKey(key), valueToJs(val, maxCollectionSize));
    return obj;
  }
  if (v instanceof PySet) return Array.from(v.map.values(), (el) => valueToJs(el, maxCollectionSize));
  if (v instanceof PyDictView) return v.toArray().map((el) => valueToJs(el, maxCollectionSize));
  if (v instanceof PyRange) {
    const n = v.length;
    if (n > maxCollectionSize) {
      throw new MemoryError(`result exceeds the maximum collection size (${maxCollectionSize} elements)`);
    }
    const out: number[] = [];
    for (let i = 0, x = v.start; i < n; i++, x += v.step) out.push(x);
    return out;
  }
  if (v instanceof PyDateTime) return isoformatDatetime(v);
  if (v instanceof PyDate) return isoformatDate(v);
  if (v instanceof PyTimeDelta) return v.days * 86400 + v.seconds + v.microseconds / 1e6;
  if (v instanceof PyFunction) return `<function ${v.name}>`;
  if (v instanceof PyBuiltin) return `<builtin ${v.name}>`;
  if (v instanceof InterpreterError) return pyStr(v);
  return pyRepr(v);
}
