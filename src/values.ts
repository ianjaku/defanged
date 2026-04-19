/**
 * Runtime value types for the Python interpreter
 */

import { Statement, Expression, Parameter } from './ast';

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
  | PyIterator;

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

export interface PyDict {
  type: 'dict';
  entries: Map<string | number | boolean, PyValue>;
}

export interface PySet {
  type: 'set';
  values: Set<string | number | boolean>;
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

export function pyDict(entries?: Map<string | number | boolean, PyValue>): PyDict {
  return { type: 'dict', entries: entries ?? new Map() };
}

export function pyTuple(elements: PyValue[]): PyTuple {
  return { type: 'tuple', elements };
}

export function pyIterator(values: PyValue[]): PyIterator {
  return { type: 'iterator', values, index: 0 };
}

export function pySet(values?: Set<string | number | boolean>): PySet {
  return { type: 'set', values: values ?? new Set() };
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
      return value.values.size > 0;
    case 'function':
    case 'builtin':
      return true;
    case 'kwargs':
      return Object.keys(value.values).length > 0;
    case 'iterator':
      return true;
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

export function isIterable(value: PyValue): value is PyList | PyTuple | PyString | PyDict | PySet | PyIterator {
  return value.type === 'list' || 
         value.type === 'tuple' || 
         value.type === 'string' || 
         value.type === 'dict' ||
         value.type === 'set' ||
         value.type === 'iterator';
}

// ============ String Representation ============

export function pyRepr(value: PyValue): string {
  switch (value.type) {
    case 'none':
      return 'None';
    case 'boolean':
      return value.value ? 'True' : 'False';
    case 'number':
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
      const entries = Array.from(value.entries.entries())
        .map(([k, v]) => `${typeof k === 'string' ? `'${k}'` : k}: ${pyRepr(v)}`)
        .join(', ');
      return `{${entries}}`;
    }
    case 'set': {
      if (value.values.size === 0) {
        return 'set()';
      }
      const items = Array.from(value.values)
        .map(v => typeof v === 'string' ? `'${v}'` : String(v))
        .join(', ');
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
  }
}

export function pyStr(value: PyValue): string {
  switch (value.type) {
    case 'string':
      return value.value;
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
      for (const [key, value] of a.entries) {
        const bValue = bDict.entries.get(key);
        if (bValue === undefined || !pyEquals(value, bValue)) return false;
      }
      return true;
    }
    case 'set': {
      const bSet = b as PySet;
      if (a.values.size !== bSet.values.size) return false;
      for (const val of a.values) {
        if (!bSet.values.has(val)) return false;
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
  }
}

// ============ Conversion to/from JavaScript ============

export function jsToValue(js: any): PyValue {
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
    return pyList(js.map(jsToValue));
  }
  if (typeof js === 'object') {
    const entries = new Map<string | number | boolean, PyValue>();
    for (const [key, value] of Object.entries(js)) {
      entries.set(key, jsToValue(value));
    }
    return pyDict(entries);
  }
  throw new Error(`Cannot convert JavaScript value to Python: ${typeof js}`);
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
      for (const [key, val] of value.entries) {
        obj[String(key)] = valueToJs(val);
      }
      return obj;
    }
    case 'set':
      // Convert set to array for JS interop
      return Array.from(value.values);
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
  }
}
