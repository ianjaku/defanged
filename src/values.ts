/**
 * Runtime value types for the Python interpreter
 */

import { Statement, Expression, Parameter } from './ast';
import { datetimeRepr, datetimeStr, isoformatDate, isoformatDatetime } from './datetime';
import { TypeError } from './errors';

export type PyValue =
  | PyNumber
  | PyString
  | PyBoolean
  | PyNone
  | PyList
  | PyDict
  | PySet
  | PyTuple
  | PyFunction
  | PyBuiltin
  | PyKwargs
  | PyIterator
  | PyGenerator
  | PyDate
  | PyDateTime
  | PyTimeDelta
  | PyModule;

export interface PyNumber {
  type: 'number';
  value: number;
}

export interface PyString {
  type: 'string';
  value: string;
}

export interface PyBoolean {
  type: 'boolean';
  value: boolean;
}

export interface PyNone {
  type: 'none';
}

export interface PyList {
  type: 'list';
  elements: PyValue[];
}

/**
 * Canonical hash key for a hashable PyValue. Not a numeric hash: it is an
 * injective encoding, so two values map to the same key iff they compare
 * equal in Python (which is why True/1/1.0 share a key, like CPython).
 */
export type PyHashKey = string | number;

export interface PyDict {
  type: 'dict';
  /** hash key → [original key value, mapped value] */
  entries: Map<PyHashKey, [PyValue, PyValue]>;
}

export interface PySet {
  type: 'set';
  /** hash key → member value */
  entries: Map<PyHashKey, PyValue>;
}

export interface PyTuple {
  type: 'tuple';
  elements: PyValue[];
}

export interface PyFunction {
  type: 'function';
  name: string;
  params: Parameter[];
  restParam?: string;
  kwargsParam?: string;
  body: Statement[];
  closure: Environment;
}

export interface PyBuiltin {
  type: 'builtin';
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (...args: any[]) => PyValue | Promise<PyValue>;
  /** If true, the last argument will be a kwargs object */
  acceptsKwargs?: boolean;
  /** Static attributes reachable via dot access (e.g. classmethods like datetime.now) */
  attrs?: Map<string, PyValue>;
}

/** Kwargs object passed to builtins that accept keyword arguments */
export interface PyKwargs {
  type: 'kwargs';
  values: Record<string, PyValue>;
}

export interface PyIterator {
  type: 'iterator';
  values: PyValue[];
  index: number;
}

export interface PyGenerator {
  type: 'generator';
  name: string;
  started: boolean;
  finished: boolean;
  next: (sendValue?: PyValue) => Promise<{ value: PyValue; done: boolean }>;
}

export interface PyDate {
  type: 'date';
  year: number;
  month: number;
  day: number;
}

export interface PyDateTime {
  type: 'datetime';
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

/** Normalized like CPython: 0 <= seconds < 86400, 0 <= microseconds < 1e6 */
export interface PyTimeDelta {
  type: 'timedelta';
  days: number;
  seconds: number;
  microseconds: number;
}

export interface PyModule {
  type: 'module';
  name: string;
  attrs: Map<string, PyValue>;
}

/**
 * Environment for variable scoping
 */
export class Environment {
  private variables: Map<string, PyValue> = new Map();
  private parent?: Environment;
  private globalNames: Set<string> = new Set();
  private nonlocalNames: Set<string> = new Set();

  constructor(parent?: Environment) {
    this.parent = parent;
  }

  getParent(): Environment | undefined {
    return this.parent;
  }

  get(name: string): PyValue | undefined {
    if (this.globalNames.has(name)) {
      return this.getGlobal()?.variables.get(name);
    }
    const value = this.variables.get(name);
    if (value !== undefined) return value;
    if (this.parent) return this.parent.get(name);
    return undefined;
  }

  set(name: string, value: PyValue): void {
    if (this.globalNames.has(name)) {
      const global = this.getGlobal();
      if (global) global.variables.set(name, value);
      return;
    }
    if (this.nonlocalNames.has(name)) {
      this.setInParent(name, value);
      return;
    }
    this.variables.set(name, value);
  }

  declareGlobal(name: string): void {
    this.globalNames.add(name);
  }

  declareNonlocal(name: string): void {
    this.nonlocalNames.add(name);
  }

  delete(name: string): boolean {
    if (this.globalNames.has(name)) {
      return this.getGlobal().variables.delete(name);
    }
    return this.variables.delete(name);
  }

  has(name: string): boolean {
    if (this.variables.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }

  private getGlobal(): Environment {
    let env: Environment = this;
    while (env.parent) env = env.parent;
    return env;
  }

  private setInParent(name: string, value: PyValue): void {
    if (this.parent) {
      if (this.parent.variables.has(name) || !this.parent.parent) {
        this.parent.variables.set(name, value);
      } else {
        this.parent.setInParent(name, value);
      }
    }
  }

  dump(): Record<string, PyValue> {
    const result: Record<string, PyValue> = {};
    for (const [key, value] of this.variables) {
      result[key] = value;
    }
    return result;
  }
}

// ============ Value Helpers ============

export function pyNumber(value: number): PyNumber {
  return { type: 'number', value };
}

export function pyString(value: string): PyString {
  return { type: 'string', value };
}

export function pyBoolean(value: boolean): PyBoolean {
  return { type: 'boolean', value };
}

export function pyNone(): PyNone {
  return { type: 'none' };
}

export function pyList(elements: PyValue[]): PyList {
  return { type: 'list', elements };
}

export function pyDict(entries?: Map<PyHashKey, [PyValue, PyValue]>): PyDict {
  return { type: 'dict', entries: entries ?? new Map() };
}

export function pyDictFromPairs(pairs: Iterable<[PyValue, PyValue]>): PyDict {
  const dict = pyDict();
  for (const [key, value] of pairs) dictSet(dict, key, value);
  return dict;
}

export function pyTuple(elements: PyValue[]): PyTuple {
  return { type: 'tuple', elements };
}

export function pyIterator(values: PyValue[]): PyIterator {
  return { type: 'iterator', values, index: 0 };
}

export function pySet(): PySet {
  return { type: 'set', entries: new Map() };
}

export function pySetFromValues(values: Iterable<PyValue>): PySet {
  const set = pySet();
  for (const value of values) setAdd(set, value);
  return set;
}

export function pyDate(year: number, month: number, day: number): PyDate {
  return { type: 'date', year, month, day };
}

export function pyDatetime(c: { year: number; month: number; day: number; hour: number; minute: number; second: number; microsecond: number }): PyDateTime {
  return { type: 'datetime', year: c.year, month: c.month, day: c.day, hour: c.hour, minute: c.minute, second: c.second, microsecond: c.microsecond };
}

export function pyTimedelta(days: number, seconds: number, microseconds: number): PyTimeDelta {
  return { type: 'timedelta', days, seconds, microseconds };
}

// ============ Hashing ============

/**
 * Encode a hashable value as a Map key. Numbers stay JS numbers (so they can
 * never collide with the string encodings); booleans collapse onto 1/0 to
 * match CPython, where True/1/1.0 are the same dict key. String encodings are
 * prefixed so distinct types can't collide ('\x00' cannot appear in source).
 * Throws TypeError for unhashable types (list, dict, set, ...).
 */
export function pyHashKey(value: PyValue, line = 0, column = 0): PyHashKey {
  switch (value.type) {
    case 'number':
      return value.value;
    case 'boolean':
      return value.value ? 1 : 0;
    case 'string':
      return 's' + value.value;
    case 'none':
      return '\x00None';
    case 'tuple':
      // JSON of the element encodings is injective as long as every element
      // is a string — numbers are tagged because JSON.stringify(Infinity)
      // is "null" and would conflate inf/nan/None.
      return '\x00t' + JSON.stringify(value.elements.map((el) => {
        const k = pyHashKey(el, line, column);
        return typeof k === 'number' ? '#' + k : k;
      }));
    case 'date':
      return `\x00d${value.year}-${value.month}-${value.day}`;
    case 'datetime':
      return `\x00dt${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}.${value.microsecond}`;
    case 'timedelta':
      return `\x00td${value.days}:${value.seconds}:${value.microseconds}`;
    default:
      throw new TypeError(`unhashable type: '${value.type}'`, line, column);
  }
}

export function isHashable(value: PyValue): boolean {
  switch (value.type) {
    case 'number':
    case 'boolean':
    case 'string':
    case 'none':
    case 'date':
    case 'datetime':
    case 'timedelta':
      return true;
    case 'tuple':
      return value.elements.every(isHashable);
    default:
      return false;
  }
}

// ============ Dict / Set access ============

export function dictGet(dict: PyDict, key: PyValue, line = 0, column = 0): PyValue | undefined {
  return dict.entries.get(pyHashKey(key, line, column))?.[1];
}

export function dictSet(dict: PyDict, key: PyValue, value: PyValue, line = 0, column = 0): void {
  const hk = pyHashKey(key, line, column);
  const existing = dict.entries.get(hk);
  if (existing) {
    // CPython keeps the first-inserted key object and updates the value.
    existing[1] = value;
  } else {
    dict.entries.set(hk, [key, value]);
  }
}

export function dictHas(dict: PyDict, key: PyValue, line = 0, column = 0): boolean {
  return dict.entries.has(pyHashKey(key, line, column));
}

export function dictDelete(dict: PyDict, key: PyValue, line = 0, column = 0): boolean {
  return dict.entries.delete(pyHashKey(key, line, column));
}

export function dictKeys(dict: PyDict): PyValue[] {
  return Array.from(dict.entries.values(), (e) => e[0]);
}

export function dictValues(dict: PyDict): PyValue[] {
  return Array.from(dict.entries.values(), (e) => e[1]);
}

export function dictPairs(dict: PyDict): [PyValue, PyValue][] {
  return Array.from(dict.entries.values());
}

export function setAdd(set: PySet, value: PyValue, line = 0, column = 0): void {
  const hk = pyHashKey(value, line, column);
  if (!set.entries.has(hk)) set.entries.set(hk, value);
}

export function setHas(set: PySet, value: PyValue, line = 0, column = 0): boolean {
  return set.entries.has(pyHashKey(value, line, column));
}

export function setDelete(set: PySet, value: PyValue, line = 0, column = 0): boolean {
  return set.entries.delete(pyHashKey(value, line, column));
}

export function setValues(set: PySet): PyValue[] {
  return Array.from(set.entries.values());
}

// ============ Truthiness ============

export function isTruthy(value: PyValue): boolean {
  switch (value.type) {
    case 'none':
      return false;
    case 'boolean':
      return value.value;
    case 'number':
      return value.value !== 0;
    case 'string':
      return value.value.length > 0;
    case 'list':
      return value.elements.length > 0;
    case 'tuple':
      return value.elements.length > 0;
    case 'dict':
      return value.entries.size > 0;
    case 'set':
      return value.entries.size > 0;
    case 'function':
    case 'builtin':
      return true;
    case 'kwargs':
      return Object.keys(value.values).length > 0;
    case 'iterator':
      return true;
    case 'generator':
      return true;
    case 'date':
    case 'datetime':
    case 'module':
      return true;
    case 'timedelta':
      return value.days !== 0 || value.seconds !== 0 || value.microseconds !== 0;
  }
}

// ============ Type Checking ============

export function isNumber(value: PyValue): value is PyNumber {
  return value.type === 'number';
}

export function isString(value: PyValue): value is PyString {
  return value.type === 'string';
}

export function isBoolean(value: PyValue): value is PyBoolean {
  return value.type === 'boolean';
}

export function isNone(value: PyValue): value is PyNone {
  return value.type === 'none';
}

export function isList(value: PyValue): value is PyList {
  return value.type === 'list';
}

export function isDict(value: PyValue): value is PyDict {
  return value.type === 'dict';
}

export function isSet(value: PyValue): value is PySet {
  return value.type === 'set';
}

export function isTuple(value: PyValue): value is PyTuple {
  return value.type === 'tuple';
}

export function isFunction(value: PyValue): value is PyFunction {
  return value.type === 'function';
}

export function isBuiltin(value: PyValue): value is PyBuiltin {
  return value.type === 'builtin';
}

export function isCallable(value: PyValue): value is PyFunction | PyBuiltin {
  return value.type === 'function' || value.type === 'builtin';
}

export function isDate(value: PyValue): value is PyDate {
  return value.type === 'date';
}

export function isDatetime(value: PyValue): value is PyDateTime {
  return value.type === 'datetime';
}

export function isTimedelta(value: PyValue): value is PyTimeDelta {
  return value.type === 'timedelta';
}

export function isIterable(value: PyValue): value is PyList | PyTuple | PyString | PyDict | PySet | PyIterator | PyGenerator {
  return value.type === 'list' ||
         value.type === 'tuple' ||
         value.type === 'string' ||
         value.type === 'dict' ||
         value.type === 'set' ||
         value.type === 'iterator' ||
         value.type === 'generator';
}

// ============ String Representation ============

export function pyRepr(value: PyValue): string {
  switch (value.type) {
    case 'none':
      return 'None';
    case 'boolean':
      return value.value ? 'True' : 'False';
    case 'number':
      // Python prints 'inf'/'nan' where JS String() gives 'Infinity'/'NaN'.
      if (value.value === Infinity) return 'inf';
      if (value.value === -Infinity) return '-inf';
      if (Number.isNaN(value.value)) return 'nan';
      return String(value.value);
    case 'string':
      return `'${value.value}'`;
    case 'list':
      return `[${value.elements.map(pyRepr).join(', ')}]`;
    case 'tuple':
      if (value.elements.length === 1) {
        return `(${pyRepr(value.elements[0])},)`;
      }
      return `(${value.elements.map(pyRepr).join(', ')})`;
    case 'dict': {
      const entries = Array.from(value.entries.values())
        .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
        .join(', ');
      return `{${entries}}`;
    }
    case 'set': {
      if (value.entries.size === 0) {
        return 'set()';
      }
      const items = Array.from(value.entries.values()).map(pyRepr).join(', ');
      return `{${items}}`;
    }
    case 'function':
      return `<function ${value.name}>`;
    case 'builtin':
      return `<built-in function ${value.name}>`;
    case 'kwargs': {
      const parts = Object.entries(value.values).map(([k, v]) => `${k}=${pyRepr(v)}`).join(', ');
      return `<kwargs${parts ? ` ${parts}` : ''}>`;
    }
    case 'iterator':
      return `<iterator>`;
    case 'generator':
      return `<generator object ${value.name}>`;
    case 'date':
    case 'datetime':
    case 'timedelta':
      return datetimeRepr(value);
    case 'module':
      return `<module '${value.name}'>`;
  }
}

export function pyStr(value: PyValue): string {
  switch (value.type) {
    case 'string':
      return value.value;
    case 'date':
    case 'datetime':
    case 'timedelta':
      return datetimeStr(value);
    default:
      return pyRepr(value);
  }
}

// ============ Equality ============

export function pyEquals(a: PyValue, b: PyValue): boolean {
  if (a.type !== b.type) {
    // Special case: number comparisons
    if (a.type === 'number' && b.type === 'boolean') {
      return a.value === (b.value ? 1 : 0);
    }
    if (a.type === 'boolean' && b.type === 'number') {
      return (a.value ? 1 : 0) === b.value;
    }
    return false;
  }

  switch (a.type) {
    case 'none':
      return true;
    case 'boolean':
      return a.value === (b as PyBoolean).value;
    case 'number':
      return a.value === (b as PyNumber).value;
    case 'string':
      return a.value === (b as PyString).value;
    case 'list': {
      const bList = b as PyList;
      if (a.elements.length !== bList.elements.length) return false;
      return a.elements.every((el, i) => pyEquals(el, bList.elements[i]));
    }
    case 'tuple': {
      const bTuple = b as PyTuple;
      if (a.elements.length !== bTuple.elements.length) return false;
      return a.elements.every((el, i) => pyEquals(el, bTuple.elements[i]));
    }
    case 'dict': {
      const bDict = b as PyDict;
      if (a.entries.size !== bDict.entries.size) return false;
      for (const [hk, [, value]] of a.entries) {
        const bEntry = bDict.entries.get(hk);
        if (bEntry === undefined || !pyEquals(value, bEntry[1])) return false;
      }
      return true;
    }
    case 'set': {
      const bSet = b as PySet;
      if (a.entries.size !== bSet.entries.size) return false;
      for (const hk of a.entries.keys()) {
        if (!bSet.entries.has(hk)) return false;
      }
      return true;
    }
    case 'function':
    case 'builtin':
      return a === b;
    case 'kwargs': {
      const bKwargs = b as PyKwargs;
      const aKeys = Object.keys(a.values);
      const bKeys = Object.keys(bKwargs.values);
      if (aKeys.length !== bKeys.length) return false;
      for (const key of aKeys) {
        const bVal = bKwargs.values[key];
        if (bVal === undefined || !pyEquals(a.values[key], bVal)) return false;
      }
      return true;
    }
    case 'iterator':
      return a === b;
    case 'generator':
      return a === b;
    case 'date': {
      const bDate = b as PyDate;
      return a.year === bDate.year && a.month === bDate.month && a.day === bDate.day;
    }
    case 'datetime': {
      const bDt = b as PyDateTime;
      return a.year === bDt.year && a.month === bDt.month && a.day === bDt.day &&
        a.hour === bDt.hour && a.minute === bDt.minute && a.second === bDt.second &&
        a.microsecond === bDt.microsecond;
    }
    case 'timedelta': {
      const bTd = b as PyTimeDelta;
      return a.days === bTd.days && a.seconds === bTd.seconds && a.microseconds === bTd.microseconds;
    }
    case 'module':
      return a === b;
  }
}

// ============ Conversion to/from JavaScript ============

/** Converts a JS Date (an instant) to a naive datetime. Defaults to the UTC
 *  wall clock; the interpreter passes a converter for the session timezone. */
export type DateConverter = (date: Date) => PyDateTime;

const utcDateConverter: DateConverter = (date) => pyDatetime({
  year: date.getUTCFullYear(),
  month: date.getUTCMonth() + 1,
  day: date.getUTCDate(),
  hour: date.getUTCHours(),
  minute: date.getUTCMinutes(),
  second: date.getUTCSeconds(),
  microsecond: date.getUTCMilliseconds() * 1000,
});

export function jsToValue(js: any, convertDate: DateConverter = utcDateConverter): PyValue {
  if (js === null || js === undefined) {
    return pyNone();
  }
  if (typeof js === 'number') {
    return pyNumber(js);
  }
  if (typeof js === 'string') {
    return pyString(js);
  }
  if (typeof js === 'boolean') {
    return pyBoolean(js);
  }
  if (Array.isArray(js)) {
    return pyList(js.map((el) => jsToValue(el, convertDate)));
  }
  if (js instanceof Date) {
    return convertDate(js);
  }
  if (typeof js === 'object') {
    const dict = pyDict();
    for (const [key, value] of Object.entries(js)) {
      dictSet(dict, pyString(key), jsToValue(value, convertDate));
    }
    return dict;
  }
  throw new Error(`Cannot convert JavaScript value to Python: ${typeof js}`);
}

/** JS object keys are strings; string/number/boolean keys keep their previous
 *  encoding, anything else (tuples, dates, None) uses its Python repr. */
function dictKeyToJsKey(key: PyValue): string {
  switch (key.type) {
    case 'string':
      return key.value;
    case 'number':
    case 'boolean':
      return String(key.value);
    default:
      return pyRepr(key);
  }
}

export function valueToJs(value: PyValue): any {
  switch (value.type) {
    case 'none':
      return null;
    case 'boolean':
      return value.value;
    case 'number':
      return value.value;
    case 'string':
      return value.value;
    case 'list':
      return value.elements.map(valueToJs);
    case 'tuple':
      return value.elements.map(valueToJs);
    case 'dict': {
      const obj: Record<string, any> = {};
      for (const [key, val] of value.entries.values()) {
        obj[dictKeyToJsKey(key)] = valueToJs(val);
      }
      return obj;
    }
    case 'set':
      // Convert set to array for JS interop
      return Array.from(value.entries.values(), valueToJs);
    case 'function':
      return `<function ${value.name}>`;
    case 'builtin':
      return `<builtin ${value.name}>`;
    case 'kwargs': {
      const obj: Record<string, any> = {};
      for (const key of Object.keys(value.values)) {
        obj[key] = valueToJs(value.values[key]);
      }
      return obj;
    }
    case 'iterator':
      return value.values.map(valueToJs);
    case 'generator':
      return `<generator object ${value.name}>`;
    case 'date':
      return isoformatDate(value);
    case 'datetime':
      return isoformatDatetime(value);
    case 'timedelta':
      return value.days * 86400 + value.seconds + value.microseconds / 1e6;
    case 'module':
      return `<module '${value.name}'>`;
  }
}
