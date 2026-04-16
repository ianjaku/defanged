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
  isTruthy,
  valueToJs,
} from './values';
import { TypeError } from './errors';

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

/** Compare two PyValues, returns negative if a < b, 0 if equal, positive if a > b */
export function compareValues(a: PyValue, b: PyValue): number {
  if (isNumber(a) && isNumber(b)) {
    return a.value - b.value;
  }
  if (isString(a) && isString(b)) {
    return a.value.localeCompare(b.value);
  }
  throw new TypeError(`'<' not supported between '${a.type}' and '${b.type}'`, 0, 0);
}

/**
 * Apply a key function to a value (synchronous only for sorting).
 * This is a simplified version that only supports simple lambda-like functions.
 */
export function applyKeyFunction(func: PyValue, item: PyValue): PyValue {
  if (func.type !== 'function') {
    throw new TypeError('key must be a function', 0, 0);
  }
  
  // Simple single-expression function body evaluation
  // For lambda x: x['field'], the body is just [Return(Subscript(...))]
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
function evaluateKeyExpression(expr: any, paramName: string, paramValue: PyValue): PyValue {
  switch (expr.type) {
    case 'Identifier':
      if (expr.name === paramName) {
        return paramValue;
      }
      throw new TypeError(`Unknown variable in key function: ${expr.name}`, 0, 0);
    
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
        if (!isString(index) && !isNumber(index)) {
          throw new TypeError('dict key must be string or number', 0, 0);
        }
        const val = obj.entries.get(index.value);
        if (val === undefined) {
          throw new TypeError(`KeyError: ${index.value}`, 0, 0);
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
      throw new TypeError(`'${obj.type}' object is not subscriptable`, 0, 0);
    }
    
    case 'Attribute': {
      const obj = evaluateKeyExpression(expr.object, paramName, paramValue);
      if (isDict(obj)) {
        const val = obj.entries.get(expr.attr);
        if (val === undefined) {
          throw new TypeError(`KeyError: ${expr.attr}`, 0, 0);
        }
        return val;
      }
      throw new TypeError(`'${obj.type}' object has no attribute '${expr.attr}'`, 0, 0);
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
}

export function createBuiltins(callbacks?: BuiltinCallbacks): Map<string, PyBuiltin> {
  const { onPrint, onChart, onTable } = callbacks ?? {};
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
      if (isSet(obj)) return pyNumber(obj.values.size);
      throw new TypeError(`object of type '${obj.type}' has no len()`, 0, 0);
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
        throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
      }

      for (const item of items) {
        if (!isNumber(item)) {
          throw new TypeError(`unsupported operand type for sum: '${item.type}'`, 0, 0);
        }
        total += item.value;
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
        throw new TypeError(`'${startOrStop.type}' object cannot be interpreted as an integer`, 0, 0);
      }

      if (stop === undefined) {
        end = startOrStop.value;
      } else {
        if (!isNumber(stop)) {
          throw new TypeError(`'${stop.type}' object cannot be interpreted as an integer`, 0, 0);
        }
        start = startOrStop.value;
        end = stop.value;
      }

      if (step !== undefined) {
        if (!isNumber(step)) {
          throw new TypeError(`'${step.type}' object cannot be interpreted as an integer`, 0, 0);
        }
        stepVal = step.value;
        if (stepVal === 0) {
          throw new TypeError('range() arg 3 must not be zero', 0, 0);
        }
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
  builtins.set('list', {
    type: 'builtin',
    name: 'list',
    fn: (iterable?: PyValue): PyValue => {
      if (iterable === undefined) return pyList([]);
      
      if (isList(iterable)) return pyList([...iterable.elements]);
      if (isTuple(iterable)) return pyList([...iterable.elements]);
      if (isString(iterable)) {
        return pyList(iterable.value.split('').map(c => pyString(c)));
      }
      if (isDict(iterable)) {
        return pyList(Array.from(iterable.entries.keys()).map(k => 
          typeof k === 'string' ? pyString(k) : 
          typeof k === 'number' ? pyNumber(k) : 
          pyBoolean(k as boolean)
        ));
      }
      if (isSet(iterable)) {
        return pyList(Array.from(iterable.values).map(v => 
          typeof v === 'string' ? pyString(v) : 
          typeof v === 'number' ? pyNumber(v) : 
          pyBoolean(v as boolean)
        ));
      }
      if (iterable.type === 'iterator') {
        return pyList([...iterable.values]);
      }
      
      throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
    },
  });

  // dict(iterable) - Convert to dict
  builtins.set('dict', {
    type: 'builtin',
    name: 'dict',
    fn: (iterable?: PyValue): PyValue => {
      if (iterable === undefined) return pyDict();
      if (isDict(iterable)) return pyDict(new Map(iterable.entries));
      
      // From list of pairs
      if (isList(iterable) || isTuple(iterable)) {
        const entries = new Map<string | number | boolean, PyValue>();
        for (const item of iterable.elements) {
          if (!isList(item) && !isTuple(item)) {
            throw new TypeError('dictionary update sequence element is not iterable', 0, 0);
          }
          if (item.elements.length !== 2) {
            throw new TypeError(`dictionary update sequence element has length ${item.elements.length}; 2 is required`, 0, 0);
          }
          const [key, value] = item.elements;
          if (!isString(key) && !isNumber(key)) {
            throw new TypeError('unhashable type for dict key', 0, 0);
          }
          entries.set(key.value, value);
        }
        return pyDict(entries);
      }
      
      throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
    },
  });

  // set(iterable) - Convert to set
  builtins.set('set', {
    type: 'builtin',
    name: 'set',
    fn: (iterable?: PyValue): PyValue => {
      if (iterable === undefined) return pySet();
      if (isSet(iterable)) return pySet(new Set(iterable.values));
      
      const values = new Set<string | number | boolean>();
      
      if (isList(iterable) || isTuple(iterable)) {
        for (const item of iterable.elements) {
          if (!isString(item) && !isNumber(item) && item.type !== 'boolean') {
            throw new TypeError(`unhashable type: '${item.type}'`, 0, 0);
          }
          values.add(item.value);
        }
        return pySet(values);
      }
      
      if (isString(iterable)) {
        for (const char of iterable.value) {
          values.add(char);
        }
        return pySet(values);
      }
      
      if (iterable.type === 'iterator') {
        for (const item of iterable.values) {
          if (!isString(item) && !isNumber(item) && item.type !== 'boolean') {
            throw new TypeError(`unhashable type: '${item.type}'`, 0, 0);
          }
          values.add(item.value);
        }
        return pySet(values);
      }
      
      if (isDict(iterable)) {
        // Iterating over dict yields keys
        for (const key of iterable.entries.keys()) {
          values.add(key);
        }
        return pySet(values);
      }
      
      throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
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

  // int(obj) - Convert to integer
  builtins.set('int', {
    type: 'builtin',
    name: 'int',
    fn: (obj?: PyValue): PyValue => {
      if (obj === undefined) return pyNumber(0);
      if (isNumber(obj)) return pyNumber(Math.floor(obj.value));
      if (isString(obj)) {
        const n = parseInt(obj.value, 10);
        if (isNaN(n)) {
          throw new TypeError(`invalid literal for int() with base 10: '${obj.value}'`, 0, 0);
        }
        return pyNumber(n);
      }
      if (obj.type === 'boolean') return pyNumber(obj.value ? 1 : 0);
      throw new TypeError(`int() argument must be a string or a number, not '${obj.type}'`, 0, 0);
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
      throw new TypeError(`float() argument must be a string or a number, not '${obj.type}'`, 0, 0);
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
        throw new TypeError(`bad operand type for abs(): '${x.type}'`, 0, 0);
      }
      return pyNumber(Math.abs(x.value));
    },
  });

  // round(x, ndigits=0) - Round a number
  builtins.set('round', {
    type: 'builtin',
    name: 'round',
    fn: (x: PyValue, ndigits?: PyValue): PyValue => {
      if (!isNumber(x)) {
        throw new TypeError(`type ${x.type} doesn't define __round__`, 0, 0);
      }
      const digits = ndigits && isNumber(ndigits) ? ndigits.value : 0;
      const factor = Math.pow(10, digits);
      return pyNumber(Math.round(x.value * factor) / factor);
    },
  });

  // min(...args, key=None) - Return minimum value
  builtins.set('min', {
    type: 'builtin',
    name: 'min',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const keyFunc = kwargs.key;
      
      if (args.length === 0) {
        throw new TypeError('min expected 1 argument, got 0', 0, 0);
      }
      
      let items: PyValue[];
      if (args.length === 1 && isIterable(args[0])) {
        if (isList(args[0]) || isTuple(args[0])) {
          items = args[0].elements;
        } else if (args[0].type === 'iterator') {
          items = args[0].values;
        } else if (isDict(args[0])) {
          items = Array.from(args[0].entries.keys()).map(k => 
            typeof k === 'string' ? pyString(k) : 
            typeof k === 'number' ? pyNumber(k) : 
            pyBoolean(k as boolean)
          );
        } else {
          throw new TypeError(`'${args[0].type}' object is not iterable`, 0, 0);
        }
      } else {
        items = args;
      }
      
      if (items.length === 0) {
        throw new TypeError('min() arg is an empty sequence', 0, 0);
      }
      
      // If key function provided, use it to compare
      if (keyFunc && keyFunc.type === 'function') {
        let minItem = items[0];
        let minKey = applyKeyFunction(keyFunc, minItem);
        
        for (let i = 1; i < items.length; i++) {
          const itemKey = applyKeyFunction(keyFunc, items[i]);
          if (compareValues(itemKey, minKey) < 0) {
            minItem = items[i];
            minKey = itemKey;
          }
        }
        return minItem;
      }
      
      // Default comparison
      let minVal = items[0];
      for (let i = 1; i < items.length; i++) {
        if (compareValues(items[i], minVal) < 0) {
          minVal = items[i];
        }
      }
      
      return minVal;
    },
  });

  // max(...args, key=None) - Return maximum value
  builtins.set('max', {
    type: 'builtin',
    name: 'max',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const keyFunc = kwargs.key;
      
      if (args.length === 0) {
        throw new TypeError('max expected 1 argument, got 0', 0, 0);
      }
      
      let items: PyValue[];
      if (args.length === 1 && isIterable(args[0])) {
        if (isList(args[0]) || isTuple(args[0])) {
          items = args[0].elements;
        } else if (args[0].type === 'iterator') {
          items = args[0].values;
        } else if (isDict(args[0])) {
          items = Array.from(args[0].entries.keys()).map(k => 
            typeof k === 'string' ? pyString(k) : 
            typeof k === 'number' ? pyNumber(k) : 
            pyBoolean(k as boolean)
          );
        } else {
          throw new TypeError(`'${args[0].type}' object is not iterable`, 0, 0);
        }
      } else {
        items = args;
      }
      
      if (items.length === 0) {
        throw new TypeError('max() arg is an empty sequence', 0, 0);
      }
      
      // If key function provided, use it to compare
      if (keyFunc && keyFunc.type === 'function') {
        let maxItem = items[0];
        let maxKey = applyKeyFunction(keyFunc, maxItem);
        
        for (let i = 1; i < items.length; i++) {
          const itemKey = applyKeyFunction(keyFunc, items[i]);
          if (compareValues(itemKey, maxKey) > 0) {
            maxItem = items[i];
            maxKey = itemKey;
          }
        }
        return maxItem;
      }
      
      // Default comparison
      let maxVal = items[0];
      for (let i = 1; i < items.length; i++) {
        if (compareValues(items[i], maxVal) > 0) {
          maxVal = items[i];
        }
      }
      
      return maxVal;
    },
  });

  // sorted(iterable, key=None, reverse=False) - Return sorted list
  builtins.set('sorted', {
    type: 'builtin',
    name: 'sorted',
    acceptsKwargs: true,
    fn: (...rawArgs: (PyValue | PyKwargs)[]): PyValue => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const keyFunc = kwargs.key;
      const reverseArg = kwargs.reverse;
      
      if (args.length === 0) {
        throw new TypeError('sorted expected 1 argument, got 0', 0, 0);
      }
      
      const iterable = args[0];
      let items: PyValue[];
      
      if (isList(iterable) || isTuple(iterable)) {
        items = [...iterable.elements];
      } else if (iterable.type === 'iterator') {
        items = [...iterable.values];
      } else if (isDict(iterable)) {
        items = Array.from(iterable.entries.keys()).map(k => 
          typeof k === 'string' ? pyString(k) : 
          typeof k === 'number' ? pyNumber(k) : 
          pyBoolean(k as boolean)
        );
      } else {
        throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
      }
      
      const reverse = reverseArg?.type === 'boolean' && reverseArg.value;
      
      // If key function provided, use it for comparison
      if (keyFunc && keyFunc.type === 'function') {
        // Pre-compute keys for stable sort
        const itemsWithKeys = items.map(item => ({
          item,
          key: applyKeyFunction(keyFunc, item),
        }));
        
        itemsWithKeys.sort((a, b) => compareValues(a.key, b.key));
        items = itemsWithKeys.map(x => x.item);
      } else {
        items.sort((a, b) => compareValues(a, b));
      }
      
      if (reverse) {
        items.reverse();
      }
      
      return pyList(items);
    },
  });

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
      throw new TypeError(`'${seq.type}' object is not reversible`, 0, 0);
    },
  });

  // enumerate(iterable, start=0) - Return enumerate object
  builtins.set('enumerate', {
    type: 'builtin',
    name: 'enumerate',
    fn: (iterable: PyValue, start?: PyValue): PyValue => {
      let items: PyValue[];
      
      if (isList(iterable) || isTuple(iterable)) {
        items = iterable.elements;
      } else if (iterable.type === 'iterator') {
        items = iterable.values;
      } else if (isString(iterable)) {
        items = iterable.value.split('').map(c => pyString(c));
      } else {
        throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
      }
      
      const startIdx = start && isNumber(start) ? start.value : 0;
      const result = items.map((item, i) => 
        pyList([pyNumber(i + startIdx), item])
      );
      
      return pyIterator(result);
    },
  });

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
        throw new TypeError(`'${it.type}' object is not iterable`, 0, 0);
      });
      
      const minLen = Math.min(...arrays.map(a => a.length));
      const result: PyValue[] = [];
      
      for (let i = 0; i < minLen; i++) {
        result.push(pyList(arrays.map(a => a[i])));
      }
      
      return pyIterator(result);
    },
  });

  // print(*args) - Print values to output
  builtins.set('print', {
    type: 'builtin',
    name: 'print',
    fn: (...args: PyValue[]): PyValue => {
      if (!onPrint) {
        throw new Error('print() is not available. Use print_table(data, title, columns) for tables or show_chart(type, data, title) for charts.');
      }
      const output = args.map(pyStr).join(' ');
      onPrint(output);
      return pyNone();
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
      };
      return pyString(`<class '${typeNames[obj.type] || obj.type}'>`);
    },
  });

  // isinstance - simplified version
  builtins.set('isinstance', {
    type: 'builtin',
    name: 'isinstance',
    fn: (obj: PyValue, typeArg: PyValue): PyValue => {
      if (!isString(typeArg)) {
        throw new TypeError('isinstance() arg 2 must be a type string', 0, 0);
      }
      const typeName = typeArg.value;
      const typeMap: Record<string, string[]> = {
        'int': ['number'],
        'float': ['number'],
        'str': ['string'],
        'bool': ['boolean'],
        'list': ['list'],
        'dict': ['dict'],
        'set': ['set'],
        'tuple': ['tuple'],
      };
      const matches = typeMap[typeName] || [typeName];
      return pyBoolean(matches.includes(obj.type));
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
        throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
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
        throw new TypeError(`'${iterable.type}' object is not iterable`, 0, 0);
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
        for (const [key, val] of el.entries) {
          obj[String(key)] = valueToJs(val);
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
        for (const [key, val] of el.entries) {
          obj[String(key)] = valueToJs(val);
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
            const keyVal = el.entries.get('key');
            const labelVal = el.entries.get('label');
            const formatVal = el.entries.get('format');
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

  return builtins;
}
