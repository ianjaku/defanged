/**
 * Built-in functions for the Python interpreter
 */

import {
  PyValue,
  PyBuiltin,
  PyKwargs,
  pyNumber,
  pyString,
  pyBoolean,
  pyNone,
  pyList,
  pyDict,
  pySet,
  pyTuple,
  pyIterator,
  isNumber,
  isString,
  isList,
  isDict,
  isSet,
  isTuple,
  isIterable,
  pyStr,
  pyRepr,
  pyTypeName,
  isTruthy,
  valueToJs,
  pyHashKey,
  dictGet,
  dictSet,
  dictKeys,
  dictValues,
  dictPairs,
  pyDictFromPairs,
  pySetFromValues,
  setAdd,
  setValues,
} from './values';
import { TypeError, ValueError, MemoryError } from './errors';
import { isDatetimeLike, datetimeOrdering } from './datetime';

/** Type guard for kwargs object */
function isKwargs(val: PyValue | PyKwargs): val is PyKwargs {
  return val && (val as any).type === 'kwargs';
}

/** Extract kwargs from args array (kwargs is always last if present) */
export function extractKwargs(args: (PyValue | PyKwargs)[]): { args: PyValue[], kwargs: Record<string, PyValue> } {
  if (args.length > 0 && isKwargs(args[args.length - 1])) {
    return {
      args: args.slice(0, -1) as PyValue[],
      kwargs: (args[args.length - 1] as PyKwargs).values,
    };
  }
  return { args: args as PyValue[], kwargs: {} };
}

/**
 * Rich comparison: negative if a < b, 0 if equal, positive if a > b.
 * Matches CPython ordering rules — bools compare as ints, strings by code
 * point (not locale), tuples/lists lexicographically (but never tuple vs
 * list). `op` only shapes the error message; sort paths report '<' like
 * CPython's sort does.
 */
export function compareValues(a: PyValue, b: PyValue, op = '<', line = 0, column = 0): number {
  const aNum = isNumber(a) ? a.value : a.type === 'boolean' ? (a.value ? 1 : 0) : null;
  const bNum = isNumber(b) ? b.value : b.type === 'boolean' ? (b.value ? 1 : 0) : null;
  if (aNum !== null && bNum !== null) {
    return aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
  }
  if (isString(a) && isString(b)) {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  }
  if ((isTuple(a) && isTuple(b)) || (isList(a) && isList(b))) {
    const minLen = Math.min(a.elements.length, b.elements.length);
    for (let i = 0; i < minLen; i++) {
      const cmp = compareValues(a.elements[i], b.elements[i], '<', line, column);
      if (cmp !== 0) return cmp;
    }
    return a.elements.length - b.elements.length;
  }
  if (isDatetimeLike(a) || isDatetimeLike(b)) {
    const cmp = datetimeOrdering(a, b, line, column);
    if (cmp !== null) return cmp;
  }
  throw new TypeError(`'${op}' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`, line, column);
}

/**
 * Apply a key function to a value (synchronous only for sorting).
 * Supports simple lambda-like functions and builtin functions.
 */
export function applyKeyFunction(func: PyValue, item: PyValue): PyValue {
  if (func.type === 'builtin') {
    return func.fn(item) as PyValue;
  }

  if (func.type !== 'function') {
    throw new TypeError('key must be a function', 0, 0);
  }

  if (func.body.length === 1 && func.body[0].type === 'Return') {
    const returnStmt = func.body[0];
    if (returnStmt.value) {
      return evaluateKeyExpression(returnStmt.value, func.params[0]?.name || 'x', item);
    }
  }

  throw new TypeError('key function must be a simple lambda expression', 0, 0);
}

/**
 * Evaluate a simple expression for key function (synchronous).
 * Supports: subscript access, attribute access, simple identifiers
 */
let _builtinsRef: Map<string, PyBuiltin> | null = null;
export function setBuiltinsRef(builtins: Map<string, PyBuiltin>): void {
  _builtinsRef = builtins;
}

function evaluateKeyExpression(expr: any, paramName: string, paramValue: PyValue): PyValue {
  switch (expr.type) {
    case 'Identifier':
      if (expr.name === paramName) {
        return paramValue;
      }
      if (_builtinsRef?.has(expr.name)) {
        return _builtinsRef.get(expr.name)!;
      }
      throw new TypeError(`Unknown variable in key function: ${expr.name}`, 0, 0);

    case 'Call': {
      const func = evaluateKeyExpression(expr.func, paramName, paramValue);
      if (func.type === 'builtin') {
        const args = expr.args.map((a: any) => evaluateKeyExpression(a, paramName, paramValue));
        return func.fn(...args) as PyValue;
      }
      throw new TypeError('key function calls must use builtin functions', 0, 0);
    }
    
    case 'Subscript': {
      const obj = evaluateKeyExpression(expr.object, paramName, paramValue);
      const index = evaluateKeyExpression(expr.index, paramName, paramValue);
      
      if (isList(obj) || isTuple(obj)) {
        if (!isNumber(index)) {
          throw new TypeError('list indices must be integers', 0, 0);
        }
        let idx = index.value;
        if (idx < 0) idx = obj.elements.length + idx;
        if (idx < 0 || idx >= obj.elements.length) {
          throw new TypeError('list index out of range', 0, 0);
        }
        return obj.elements[idx];
      }
      if (isDict(obj)) {
        const val = dictGet(obj, index);
        if (val === undefined) {
          throw new TypeError(`KeyError: ${pyRepr(index)}`, 0, 0);
        }
        return val;
      }
      if (isString(obj)) {
        if (!isNumber(index)) {
          throw new TypeError('string indices must be integers', 0, 0);
        }
        let idx = index.value;
        if (idx < 0) idx = obj.value.length + idx;
        if (idx < 0 || idx >= obj.value.length) {
          throw new TypeError('string index out of range', 0, 0);
        }
        return pyString(obj.value[idx]);
      }
      throw new TypeError(`'${pyTypeName(obj)}' object is not subscriptable`, 0, 0);
    }
    
    case 'Attribute': {
      const obj = evaluateKeyExpression(expr.object, paramName, paramValue);
      if (isDict(obj)) {
        const val = dictGet(obj, pyString(expr.attr));
        if (val === undefined) {
          throw new TypeError(`KeyError: ${expr.attr}`, 0, 0);
        }
        return val;
      }
      throw new TypeError(`'${pyTypeName(obj)}' object has no attribute '${expr.attr}'`, 0, 0);
    }
    
    case 'String':
      return pyString(expr.value);
    
    case 'Number':
      return pyNumber(expr.value);
    
    default:
      throw new TypeError(`Unsupported expression type in key function: ${expr.type}`, 0, 0);
  }
}

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
  /** Cap on elements a builtin may materialize at once (range()). */
  maxCollectionSize?: number;
}

export function createBuiltins(callbacks?: BuiltinCallbacks): Map<string, PyBuiltin> {
  const { onPrint, onChart, onTable } = callbacks ?? {};
  const maxCollectionSize = callbacks?.maxCollectionSize ?? Infinity;
  const builtins = new Map<string, PyBuiltin>();

  // len(obj) - Return the length of an object
  builtins.set('len', {
    type: 'builtin',
    name: 'len',
    fn: (obj: PyValue): PyValue => {
      if (isString(obj)) return pyNumber(obj.value.length);
      if (isList(obj)) return pyNumber(obj.elements.length);
      if (isTuple(obj)) return pyNumber(obj.elements.length);
      if (isDict(obj)) return pyNumber(obj.entries.size);
      if (isSet(obj)) return pyNumber(obj.entries.size);
      throw new TypeError(`object of type '${pyTypeName(obj)}' has no len()`, 0, 0);
    },
  });

  // sum(iterable, start=0) - Sum of items in iterable
  builtins.set('sum', {
    type: 'builtin',
    name: 'sum',
    fn: (iterable: PyValue, start?: PyValue): PyValue => {
      let total = start && isNumber(start) ? start.value : 0;

      const items: PyValue[] | null =
        isList(iterable) || isTuple(iterable)
          ? iterable.elements
          : iterable.type === 'iterator'
            ? iterable.values
            : null;

      if (!items) {
        throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
      }

      for (const item of items) {
        if (isNumber(item)) {
          total += item.value;
        } else if (item.type === 'boolean') {
          total += item.value ? 1 : 0;
        } else {
          // CPython raises from the underlying +, naming the accumulator type.
          const totalName = Number.isInteger(total) ? 'int' : 'float';
          throw new TypeError(`unsupported operand type(s) for +: '${totalName}' and '${pyTypeName(item)}'`, 0, 0);
        }
      }
      
      return pyNumber(total);
    },
  });

  // range(stop) or range(start, stop, step) - Generate a range of numbers
  builtins.set('range', {
    type: 'builtin',
    name: 'range',
    fn: (startOrStop: PyValue, stop?: PyValue, step?: PyValue): PyValue => {
      let start = 0;
      let end: number;
      let stepVal = 1;

      if (!isNumber(startOrStop)) {
        throw new TypeError(`'${pyTypeName(startOrStop)}' object cannot be interpreted as an integer`, 0, 0);
      }

      if (stop === undefined) {
        end = startOrStop.value;
      } else {
        if (!isNumber(stop)) {
          throw new TypeError(`'${pyTypeName(stop)}' object cannot be interpreted as an integer`, 0, 0);
        }
        start = startOrStop.value;
        end = stop.value;
      }

      if (step !== undefined) {
        if (!isNumber(step)) {
          throw new TypeError(`'${pyTypeName(step)}' object cannot be interpreted as an integer`, 0, 0);
        }
        stepVal = step.value;
        if (stepVal === 0) {
          throw new TypeError('range() arg 3 must not be zero', 0, 0);
        }
      }

      // range materializes eagerly, so a huge span would allocate up front —
      // check the count before building the array.
      const count = Math.max(0, Math.ceil((end - start) / stepVal));
      if (count > maxCollectionSize) {
        throw new MemoryError(`result exceeds the maximum collection size (${maxCollectionSize} elements)`, 0, 0);
      }

      const values: PyValue[] = [];
      if (stepVal > 0) {
        for (let i = start; i < end; i += stepVal) {
          values.push(pyNumber(i));
        }
      } else {
        for (let i = start; i > end; i += stepVal) {
          values.push(pyNumber(i));
        }
      }

      return pyIterator(values);
    },
  });

  // list(iterable) - Convert to list
  // Marked requiresInterpreter for generator support (async iteration)
  builtins.set('list', {
    type: 'builtin',
    name: 'list',
    requiresInterpreter: true,
    fn: (iterable?: PyValue): PyValue => {
      if (iterable === undefined) return pyList([]);

      if (isList(iterable)) return pyList([...iterable.elements]);
      if (isTuple(iterable)) return pyList([...iterable.elements]);
      if (isString(iterable)) {
        return pyList(iterable.value.split('').map(c => pyString(c)));
      }
      if (isDict(iterable)) {
        return pyList(dictKeys(iterable));
      }
      if (isSet(iterable)) {
        return pyList(setValues(iterable));
      }
      if (iterable.type === 'iterator') {
        return pyList([...iterable.values]);
      }

      throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
    },
  } as any);

  // tuple(iterable) - Convert to tuple
  builtins.set('tuple', {
    type: 'builtin',
    name: 'tuple',
    fn: (iterable?: PyValue): PyValue => {
      if (iterable === undefined) return pyTuple([]);
      if (isTuple(iterable)) return pyTuple([...iterable.elements]);
      if (isList(iterable)) return pyTuple([...iterable.elements]);
      if (isString(iterable)) {
        return pyTuple(iterable.value.split('').map(c => pyString(c)));
      }
      if (iterable.type === 'iterator') {
        return pyTuple([...iterable.values]);
      }
      if (isDict(iterable)) {
        return pyTuple(dictKeys(iterable));
      }
      if (isSet(iterable)) {
        return pyTuple(setValues(iterable));
      }
      throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
    },
  });

  // dict(iterable) or dict(key=val, ...) - Convert to dict
  builtins.set('dict', {
    type: 'builtin',
    name: 'dict',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const dict = pyDict();
      const iterable = args[0];

      if (iterable !== undefined) {
        if (isDict(iterable)) {
          for (const [k, v] of dictPairs(iterable)) dictSet(dict, k, v);
        } else if (isList(iterable) || isTuple(iterable)) {
          for (const item of iterable.elements) {
            if (!isList(item) && !isTuple(item)) {
              throw new TypeError('dictionary update sequence element is not iterable', 0, 0);
            }
            if (item.elements.length !== 2) {
              throw new TypeError(`dictionary update sequence element has length ${item.elements.length}; 2 is required`, 0, 0);
            }
            const [key, value] = item.elements;
            dictSet(dict, key, value);
          }
        } else {
          throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
        }
      }

      for (const [k, v] of Object.entries(kwargs)) {
        dictSet(dict, pyString(k), v);
      }

      return dict;
    },
  });

  // set(iterable) - Convert to set
  builtins.set('set', {
    type: 'builtin',
    name: 'set',
    fn: (iterable?: PyValue): PyValue => {
      if (iterable === undefined) return pySet();
      if (isSet(iterable)) return pySetFromValues(setValues(iterable));

      if (isList(iterable) || isTuple(iterable)) {
        return pySetFromValues(iterable.elements);
      }

      if (isString(iterable)) {
        return pySetFromValues(iterable.value.split('').map(c => pyString(c)));
      }

      if (iterable.type === 'iterator') {
        return pySetFromValues(iterable.values);
      }

      if (isDict(iterable)) {
        // Iterating over dict yields keys
        return pySetFromValues(dictKeys(iterable));
      }

      throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
    },
  });

  // str(obj) - Convert to string
  builtins.set('str', {
    type: 'builtin',
    name: 'str',
    fn: (obj?: PyValue): PyValue => {
      if (obj === undefined) return pyString('');
      return pyString(pyStr(obj));
    },
  });

  // int(obj, base=10) - Convert to integer
  builtins.set('int', {
    type: 'builtin',
    name: 'int',
    fn: (obj?: PyValue, base?: PyValue): PyValue => {
      if (obj === undefined) return pyNumber(0);
      if (base !== undefined) {
        if (!isNumber(base)) throw new TypeError("int() base must be an integer", 0, 0);
        if (!isString(obj)) throw new TypeError("int() can't convert non-string with explicit base", 0, 0);
        const b = Math.trunc(base.value);
        let trimmed = obj.value.trim().toLowerCase();
        if (b === 16 && trimmed.startsWith('0x')) trimmed = trimmed.slice(2);
        if (b === 8 && trimmed.startsWith('0o')) trimmed = trimmed.slice(2);
        if (b === 2 && trimmed.startsWith('0b')) trimmed = trimmed.slice(2);
        const result = parseInt(trimmed, b);
        if (isNaN(result)) throw new ValueError(`invalid literal for int() with base ${b}: '${obj.value}'`, 0, 0);
        return pyNumber(result);
      }
      if (isNumber(obj)) return pyNumber(Math.trunc(obj.value));
      if (isString(obj)) {
        const trimmed = obj.value.trim();
        if (!/^[+-]?\d+$/.test(trimmed)) {
          throw new ValueError(`invalid literal for int() with base 10: '${obj.value}'`, 0, 0);
        }
        return pyNumber(parseInt(trimmed, 10));
      }
      if (obj.type === 'boolean') return pyNumber(obj.value ? 1 : 0);
      throw new TypeError(`int() argument must be a string or a number, not '${pyTypeName(obj)}'`, 0, 0);
    },
  });

  // float(obj) - Convert to float
  builtins.set('float', {
    type: 'builtin',
    name: 'float',
    fn: (obj?: PyValue): PyValue => {
      if (obj === undefined) return pyNumber(0.0);
      if (isNumber(obj)) return pyNumber(obj.value);
      if (isString(obj)) {
        const n = parseFloat(obj.value);
        if (isNaN(n)) {
          throw new TypeError(`could not convert string to float: '${obj.value}'`, 0, 0);
        }
        return pyNumber(n);
      }
      if (obj.type === 'boolean') return pyNumber(obj.value ? 1.0 : 0.0);
      throw new TypeError(`float() argument must be a string or a number, not '${pyTypeName(obj)}'`, 0, 0);
    },
  });

  // bool(obj) - Convert to boolean
  builtins.set('bool', {
    type: 'builtin',
    name: 'bool',
    fn: (obj?: PyValue): PyValue => {
      if (obj === undefined) return pyBoolean(false);
      return pyBoolean(isTruthy(obj));
    },
  });

  // abs(x) - Absolute value
  builtins.set('abs', {
    type: 'builtin',
    name: 'abs',
    fn: (x: PyValue): PyValue => {
      if (!isNumber(x)) {
        throw new TypeError(`bad operand type for abs(): '${pyTypeName(x)}'`, 0, 0);
      }
      return pyNumber(Math.abs(x.value));
    },
  });

  // round(x, ndigits=0) - Banker's rounding (round half to even)
  builtins.set('round', {
    type: 'builtin',
    name: 'round',
    fn: (x: PyValue, ndigits?: PyValue): PyValue => {
      if (!isNumber(x)) {
        throw new TypeError(`type ${pyTypeName(x)} doesn't define __round__ method`, 0, 0);
      }
      const digits = ndigits && isNumber(ndigits) ? ndigits.value : 0;
      const factor = Math.pow(10, digits);
      const scaled = x.value * factor;
      const floored = Math.floor(scaled);
      const diff = scaled - floored;
      let rounded: number;
      if (Math.abs(diff - 0.5) < 1e-9) {
        rounded = floored % 2 === 0 ? floored : floored + 1;
      } else {
        rounded = Math.round(scaled);
      }
      return pyNumber(rounded / factor);
    },
  });

  builtins.set('min', {
    type: 'builtin',
    name: 'min',
    requiresInterpreter: true,
    fn: (): PyValue => { throw new TypeError('min() should be handled by interpreter', 0, 0); },
  } as any);

  builtins.set('max', {
    type: 'builtin',
    name: 'max',
    requiresInterpreter: true,
    fn: (): PyValue => { throw new TypeError('max() should be handled by interpreter', 0, 0); },
  } as any);

  builtins.set('sorted', {
    type: 'builtin',
    name: 'sorted',
    requiresInterpreter: true,
    fn: (): PyValue => { throw new TypeError('sorted() should be handled by interpreter', 0, 0); },
  } as any);

  // reversed(seq) - Return reversed iterator
  builtins.set('reversed', {
    type: 'builtin',
    name: 'reversed',
    fn: (seq: PyValue): PyValue => {
      if (isList(seq) || isTuple(seq)) {
        return pyIterator([...seq.elements].reverse());
      }
      if (isString(seq)) {
        return pyIterator(seq.value.split('').reverse().map(c => pyString(c)));
      }
      throw new TypeError(`'${pyTypeName(seq)}' object is not reversible`, 0, 0);
    },
  });

  // enumerate(iterable, start=0) - Return enumerate object
  // Marked requiresInterpreter for generator support
  builtins.set('enumerate', {
    type: 'builtin',
    name: 'enumerate',
    acceptsKwargs: true,
    requiresInterpreter: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const iterable = args[0];
      if (!iterable) throw new TypeError('enumerate expected at least 1 argument, got 0', 0, 0);
      let items: PyValue[];

      if (isList(iterable) || isTuple(iterable)) {
        items = iterable.elements;
      } else if (iterable.type === 'iterator') {
        items = iterable.values;
      } else if (isString(iterable)) {
        items = iterable.value.split('').map(c => pyString(c));
      } else {
        throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
      }

      const startVal = kwargs.start && isNumber(kwargs.start) ? kwargs.start.value : (args[1] && isNumber(args[1]) ? args[1].value : 0);
      const result = items.map((item, i) =>
        pyList([pyNumber(i + startVal), item])
      );

      return pyIterator(result);
    },
  } as any);

  // zip(*iterables) - Zip iterables together
  builtins.set('zip', {
    type: 'builtin',
    name: 'zip',
    fn: (...iterables: PyValue[]): PyValue => {
      if (iterables.length === 0) return pyIterator([]);
      
      const arrays: PyValue[][] = iterables.map(it => {
        if (isList(it) || isTuple(it)) return it.elements;
        if (it.type === 'iterator') return it.values;
        if (isString(it)) return it.value.split('').map(c => pyString(c));
        throw new TypeError(`'${pyTypeName(it)}' object is not iterable`, 0, 0);
      });
      
      const minLen = Math.min(...arrays.map(a => a.length));
      const result: PyValue[] = [];
      
      for (let i = 0; i < minLen; i++) {
        result.push(pyList(arrays.map(a => a[i])));
      }
      
      return pyIterator(result);
    },
  });

  // print(*args, sep=' ', end='\n') - Print values to output
  builtins.set('print', {
    type: 'builtin',
    name: 'print',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      if (!onPrint) {
        throw new Error('print() is not available. Use print_table(data, title, columns) for tables or show_chart(type, data, title) for charts.');
      }
      const { args, kwargs } = extractKwargs(rawArgs);
      const sep = kwargs.sep && isString(kwargs.sep) ? kwargs.sep.value : ' ';
      const end = kwargs.end && isString(kwargs.end) ? kwargs.end.value : '\n';
      const output = args.map(pyStr).join(sep);
      onPrint(output + (end !== '\n' ? end : ''));
      return pyNone();
    },
  });

  // hex(x) - Convert integer to hex string
  builtins.set('hex', {
    type: 'builtin',
    name: 'hex',
    fn: (x: PyValue): PyValue => {
      if (!isNumber(x)) throw new TypeError(`'${pyTypeName(x)}' object cannot be interpreted as an integer`, 0, 0);
      const n = Math.trunc(x.value);
      return pyString(n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16));
    },
  });

  // oct(x) - Convert integer to octal string
  builtins.set('oct', {
    type: 'builtin',
    name: 'oct',
    fn: (x: PyValue): PyValue => {
      if (!isNumber(x)) throw new TypeError(`'${pyTypeName(x)}' object cannot be interpreted as an integer`, 0, 0);
      const n = Math.trunc(x.value);
      return pyString(n < 0 ? '-0o' + (-n).toString(8) : '0o' + n.toString(8));
    },
  });

  // bin(x) - Convert integer to binary string
  builtins.set('bin', {
    type: 'builtin',
    name: 'bin',
    fn: (x: PyValue): PyValue => {
      if (!isNumber(x)) throw new TypeError(`'${pyTypeName(x)}' object cannot be interpreted as an integer`, 0, 0);
      const n = Math.trunc(x.value);
      return pyString(n < 0 ? '-0b' + (-n).toString(2) : '0b' + n.toString(2));
    },
  });

  // ord(c) - Return Unicode code point of character
  builtins.set('ord', {
    type: 'builtin',
    name: 'ord',
    fn: (c: PyValue): PyValue => {
      if (!isString(c) || c.value.length !== 1) {
        throw new TypeError('ord() expected a character, but string of length ' + (isString(c) ? c.value.length : 0) + ' found', 0, 0);
      }
      return pyNumber(c.value.charCodeAt(0));
    },
  });

  // chr(i) - Return character from Unicode code point
  builtins.set('chr', {
    type: 'builtin',
    name: 'chr',
    fn: (i: PyValue): PyValue => {
      if (!isNumber(i)) throw new TypeError(`an integer is required`, 0, 0);
      return pyString(String.fromCharCode(Math.trunc(i.value)));
    },
  });

  // pow(base, exp[, mod]) - Power with optional modulo
  builtins.set('pow', {
    type: 'builtin',
    name: 'pow',
    fn: (base: PyValue, exp: PyValue, mod?: PyValue): PyValue => {
      if (!isNumber(base) || !isNumber(exp)) throw new TypeError('pow() arguments must be numbers', 0, 0);
      if (mod !== undefined) {
        if (!isNumber(mod)) throw new TypeError('pow() 3rd argument must be a number', 0, 0);
        if (mod.value === 0) throw new ValueError('pow() 3rd argument cannot be 0', 0, 0);
        let result = BigInt(Math.trunc(base.value)) ** BigInt(Math.trunc(exp.value));
        result = ((result % BigInt(Math.trunc(mod.value))) + BigInt(Math.trunc(mod.value))) % BigInt(Math.trunc(mod.value));
        return pyNumber(Number(result));
      }
      return pyNumber(Math.pow(base.value, exp.value));
    },
  });

  // divmod(a, b) - Return (quotient, remainder)
  builtins.set('divmod', {
    type: 'builtin',
    name: 'divmod',
    fn: (a: PyValue, b: PyValue): PyValue => {
      if (!isNumber(a) || !isNumber(b)) throw new TypeError('divmod() arguments must be numbers', 0, 0);
      if (b.value === 0) throw new ValueError('integer division or modulo by zero', 0, 0);
      const q = Math.floor(a.value / b.value);
      const r = ((a.value % b.value) + b.value) % b.value;
      return pyList([pyNumber(q), pyNumber(r)]);
    },
  });

  // callable(obj) - Return True if the object appears callable
  builtins.set('callable', {
    type: 'builtin',
    name: 'callable',
    fn: (obj: PyValue): PyValue => {
      return pyBoolean(obj.type === 'function' || obj.type === 'builtin');
    },
  });

  // iter(iterable) - Return an iterator
  builtins.set('iter', {
    type: 'builtin',
    name: 'iter',
    fn: (obj: PyValue): PyValue => {
      if (obj.type === 'iterator') return obj;
      if (isList(obj) || isTuple(obj)) return pyIterator([...obj.elements]);
      if (isString(obj)) return pyIterator(obj.value.split('').map(c => pyString(c)));
      if (isDict(obj)) {
        return pyIterator(dictKeys(obj));
      }
      if (isSet(obj)) {
        return pyIterator(setValues(obj));
      }
      throw new TypeError(`'${pyTypeName(obj)}' object is not iterable`, 0, 0);
    },
  });

  // next(iterator[, default]) - Get next item
  // Generator support is handled by the interpreter via requiresInterpreter
  builtins.set('next', {
    type: 'builtin',
    name: 'next',
    requiresInterpreter: true,
    fn: (iter: PyValue, defaultVal?: PyValue): PyValue => {
      if (iter.type === 'iterator') {
        if (iter.index >= iter.values.length) {
          if (defaultVal !== undefined) return defaultVal;
          throw new ValueError('StopIteration', 0, 0);
        }
        return iter.values[iter.index++];
      }
      throw new TypeError(`'${pyTypeName(iter)}' object is not an iterator`, 0, 0);
    },
  } as any);

  // hash(obj) - Return hash value
  builtins.set('hash', {
    type: 'builtin',
    name: 'hash',
    fn: (obj: PyValue): PyValue => {
      // pyHashKey throws for unhashable types; numbers hash to themselves
      // like CPython ints, everything else gets a string hash.
      const hk = pyHashKey(obj);
      if (typeof hk === 'number') return pyNumber(hk);
      let h = 0;
      for (let i = 0; i < hk.length; i++) {
        h = ((h << 5) - h + hk.charCodeAt(i)) | 0;
      }
      return pyNumber(h);
    },
  });

  // id(obj) - Return identity (address-like integer)
  builtins.set('id', {
    type: 'builtin',
    name: 'id',
    fn: (obj: PyValue): PyValue => {
      // Deterministic but unique-ish placeholder
      if (isNumber(obj)) return pyNumber(obj.value * 997 + 1);
      if (isString(obj)) {
        let h = 0;
        for (let i = 0; i < obj.value.length; i++) h = ((h << 5) - h + obj.value.charCodeAt(i)) | 0;
        return pyNumber(h);
      }
      return pyNumber(Math.floor(Math.random() * 1e9));
    },
  });

  // repr(obj) - Return string representation
  builtins.set('repr', {
    type: 'builtin',
    name: 'repr',
    fn: (obj: PyValue): PyValue => {
      return pyString(pyRepr(obj));
    },
  });

  // type(obj) - Return type name
  builtins.set('type', {
    type: 'builtin',
    name: 'type',
    fn: (obj: PyValue): PyValue => {
      const typeNames: Record<string, string> = {
        'number': 'int',  // Simplified - Python distinguishes int/float
        'string': 'str',
        'boolean': 'bool',
        'none': 'NoneType',
        'list': 'list',
        'dict': 'dict',
        'set': 'set',
        'tuple': 'tuple',
        'function': 'function',
        'builtin': 'builtin_function_or_method',
        'iterator': 'iterator',
        'generator': 'generator',
        'date': 'datetime.date',
        'datetime': 'datetime.datetime',
        'timedelta': 'datetime.timedelta',
        'module': 'module',
      };
      return pyString(`<class '${typeNames[obj.type] || obj.type}'>`);
    },
  });

  // isinstance - checks type or tuple of types
  builtins.set('isinstance', {
    type: 'builtin',
    name: 'isinstance',
    fn: (obj: PyValue, typeArg: PyValue): PyValue => {
      const typeMap: Record<string, string[]> = {
        'int': ['number'],
        'float': ['number'],
        'str': ['string'],
        'bool': ['boolean'],
        'list': ['list'],
        'dict': ['dict'],
        'set': ['set'],
        'tuple': ['tuple'],
        // datetime is a date subclass in CPython
        'datetime.date': ['date', 'datetime'],
        'datetime.datetime': ['datetime'],
        'datetime.timedelta': ['timedelta'],
      };

      const checkType = (typeName: string): boolean => {
        const matches = typeMap[typeName] || [typeName];
        return matches.includes(obj.type);
      };

      if (isString(typeArg)) {
        return pyBoolean(checkType(typeArg.value));
      }
      if (typeArg.type === 'builtin') {
        return pyBoolean(checkType(typeArg.name));
      }
      if (isTuple(typeArg)) {
        for (const el of typeArg.elements) {
          const name = isString(el) ? el.value : el.type === 'builtin' ? el.name : '';
          if (checkType(name)) return pyBoolean(true);
        }
        return pyBoolean(false);
      }
      throw new TypeError('isinstance() arg 2 must be a type or tuple of types', 0, 0);
    },
  });

  // any(iterable) - Return True if any element is truthy
  builtins.set('any', {
    type: 'builtin',
    name: 'any',
    fn: (iterable: PyValue): PyValue => {
      let items: PyValue[];
      if (isList(iterable) || isTuple(iterable)) {
        items = iterable.elements;
      } else if (iterable.type === 'iterator') {
        items = iterable.values;
      } else {
        throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
      }
      return pyBoolean(items.some(isTruthy));
    },
  });

  // all(iterable) - Return True if all elements are truthy
  builtins.set('all', {
    type: 'builtin',
    name: 'all',
    fn: (iterable: PyValue): PyValue => {
      let items: PyValue[];
      if (isList(iterable) || isTuple(iterable)) {
        items = iterable.elements;
      } else if (iterable.type === 'iterator') {
        items = iterable.values;
      } else {
        throw new TypeError(`'${pyTypeName(iterable)}' object is not iterable`, 0, 0);
      }
      return pyBoolean(items.every(isTruthy));
    },
  });

  // filter(func, iterable) - Filter elements
  // Note: This is a placeholder - actual implementation is in interpreter
  // to support calling user-defined functions
  builtins.set('filter', {
    type: 'builtin',
    name: 'filter',
    requiresInterpreter: true,
    fn: (_func: PyValue, _iterable: PyValue): PyValue => {
      throw new TypeError('filter() should be handled by interpreter', 0, 0);
    },
  } as any);

  // map(func, iterable) - Map function over iterable
  // Note: This is a placeholder - actual implementation is in interpreter
  // to support calling user-defined functions
  builtins.set('map', {
    type: 'builtin',
    name: 'map',
    requiresInterpreter: true,
    fn: (_func: PyValue, _iterable: PyValue): PyValue => {
      throw new TypeError('map() should be handled by interpreter', 0, 0);
    },
  } as any);

  // print_chart(type, data, x, y, title=None) - Render a chart visualization
  builtins.set('print_chart', {
    type: 'builtin',
    name: 'print_chart',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      if (!onChart) {
        throw new Error('print_chart() is not available in this context');
      }

      const { args, kwargs } = extractKwargs(rawArgs);

      // Extract parameters from kwargs (preferred) or positional args
      const chartType = kwargs['type'] ? pyStr(kwargs['type']) : (args[0] ? pyStr(args[0]) : null);
      const dataArg = kwargs['data'] ?? args[1];
      const xKey = kwargs['x'] ? pyStr(kwargs['x']) : (args[2] ? pyStr(args[2]) : null);
      const yArg = kwargs['y'] ?? args[3];
      const title = kwargs['title'] ? pyStr(kwargs['title']) : undefined;

      if (!chartType || !['bar', 'line', 'pie', 'area'].includes(chartType)) {
        throw new TypeError('print_chart() requires type to be one of: bar, line, pie, area', 0, 0);
      }
      if (!dataArg || !isList(dataArg)) {
        throw new TypeError('print_chart() requires data to be a list of dictionaries', 0, 0);
      }
      if (!xKey) {
        throw new TypeError('print_chart() requires x parameter (key for x-axis)', 0, 0);
      }
      if (!yArg) {
        throw new TypeError('print_chart() requires y parameter (key(s) for y-axis)', 0, 0);
      }

      // Convert y to string or string[]
      let yKey: string | string[];
      if (isList(yArg)) {
        yKey = yArg.elements.map(el => pyStr(el));
      } else {
        yKey = pyStr(yArg);
      }

      // Convert data to JS array
      const data = dataArg.elements.map(el => {
        if (!isDict(el)) {
          throw new TypeError('print_chart() data must be a list of dictionaries', 0, 0);
        }
        const obj: Record<string, unknown> = {};
        for (const [key, val] of dictPairs(el)) {
          obj[pyStr(key)] = valueToJs(val);
        }
        return obj;
      });

      // Enforce limits
      const MAX_DATA_POINTS = 200;
      if (data.length > MAX_DATA_POINTS) {
        throw new TypeError(`print_chart() data exceeds maximum of ${MAX_DATA_POINTS} points (got ${data.length})`, 0, 0);
      }

      onChart({
        type: chartType,
        data,
        x: xKey,
        y: yKey,
        title,
      });

      return pyNone();
    },
  });

  // print_table(data, columns=None, title=None) - Render a data table
  builtins.set('print_table', {
    type: 'builtin',
    name: 'print_table',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      if (!onTable) {
        throw new Error('print_table() is not available in this context');
      }

      const { args, kwargs } = extractKwargs(rawArgs);

      // Extract parameters from kwargs (preferred) or positional args
      const dataArg = kwargs['data'] ?? args[0];
      const columnsArg = kwargs['columns'] ?? args[1];
      const title = kwargs['title'] ? pyStr(kwargs['title']) : undefined;

      if (!dataArg || !isList(dataArg)) {
        throw new TypeError('print_table() requires data to be a list of dictionaries', 0, 0);
      }

      // Convert data to JS array
      const data = dataArg.elements.map(el => {
        if (!isDict(el)) {
          throw new TypeError('print_table() data must be a list of dictionaries', 0, 0);
        }
        const obj: Record<string, unknown> = {};
        for (const [key, val] of dictPairs(el)) {
          obj[pyStr(key)] = valueToJs(val);
        }
        return obj;
      });

      // Enforce limits
      const MAX_ROWS = 500;
      if (data.length > MAX_ROWS) {
        throw new TypeError(`print_table() data exceeds maximum of ${MAX_ROWS} rows (got ${data.length})`, 0, 0);
      }

      // Parse columns or infer from data
      let columns: Array<{ key: string; label: string; format?: string }>;

      if (columnsArg && isList(columnsArg)) {
        columns = columnsArg.elements.map(el => {
          if (isString(el)) {
            // Simple string column name
            return { key: el.value, label: el.value };
          }
          if (isDict(el)) {
            // Full column definition
            const keyVal = dictGet(el, pyString('key'));
            const labelVal = dictGet(el, pyString('label'));
            const formatVal = dictGet(el, pyString('format'));
            if (!keyVal || !isString(keyVal)) {
              throw new TypeError('Column definition requires "key" string', 0, 0);
            }
            return {
              key: keyVal.value,
              label: labelVal && isString(labelVal) ? labelVal.value : keyVal.value,
              format: formatVal && isString(formatVal) ? formatVal.value : undefined,
            };
          }
          throw new TypeError('Column must be a string or dictionary with key/label/format', 0, 0);
        });
      } else if (data.length > 0) {
        // Infer columns from first row
        columns = Object.keys(data[0]).slice(0, 20).map(key => ({
          key,
          label: key,
        }));
      } else {
        columns = [];
      }

      onTable({
        data,
        columns,
        title,
      });

      return pyNone();
    },
  });

  // Exception constructors — return a tagged value that `raise` can inspect
  for (const name of ['Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'ZeroDivisionError', 'NameError', 'RuntimeError', 'StopIteration', 'ImportError', 'ModuleNotFoundError', 'OverflowError', 'MemoryError', 'ToolError']) {
    builtins.set(name, {
      type: 'builtin',
      name,
      fn: (msg?: PyValue): PyValue => {
        const message = msg ? (isString(msg) ? msg.value : String((msg as any).value ?? '')) : '';
        const val = pyString(message);
        (val as any).exceptionName = name;
        (val as any).exceptionMessage = message;
        return val;
      },
    });
  }

  setBuiltinsRef(builtins);
  return builtins;
}
