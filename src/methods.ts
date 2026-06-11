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
  isNumber,
  isString,
  isBoolean,
  isNone,
  isList,
  isDict,
  isSet,
  isTuple,
  pyEquals,
  valueToJs,
  pyRepr,
  dictGet,
  dictSet,
  dictHas,
  dictDelete,
  dictKeys,
  dictValues,
  dictPairs,
  pyDictFromPairs,
  setAdd,
  setHas,
  setDelete,
  setValues,
  pySetFromValues,
} from './values';
import { TypeError, IndexError, KeyError, ValueError } from './errors';
import { extractKwargs, compareValues, applyKeyFunction } from './builtins';

export function getStringMethod(obj: PyValue & { type: 'string' }, attr: string, line: number, column: number): PyValue {
  const str = obj.value;

  const methods: Record<string, PyBuiltin> = {
    upper: {
      type: 'builtin',
      name: 'str.upper',
      fn: () => pyString(str.toUpperCase()),
    },
    lower: {
      type: 'builtin',
      name: 'str.lower',
      fn: () => pyString(str.toLowerCase()),
    },
    capitalize: {
      type: 'builtin',
      name: 'str.capitalize',
      fn: () => pyString(str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()),
    },
    title: {
      type: 'builtin',
      name: 'str.title',
      fn: () => pyString(str.replace(/\b\w/g, c => c.toUpperCase())),
    },
    zfill: {
      type: 'builtin',
      name: 'str.zfill',
      fn: (width: PyValue) => {
        if (!isNumber(width)) {
          throw new TypeError("zfill() argument must be an integer", line, column);
        }
        const w = Math.floor(width.value);
        if (str.length >= w) return pyString(str);
        if (str.startsWith('-') || str.startsWith('+')) {
          return pyString(str[0] + str.slice(1).padStart(w - 1, '0'));
        }
        return pyString(str.padStart(w, '0'));
      },
    },
    strip: {
      type: 'builtin',
      name: 'str.strip',
      fn: (chars?: PyValue) => {
        if (chars && isString(chars)) {
          const escaped = chars.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'g');
          return pyString(str.replace(pattern, ''));
        }
        return pyString(str.trim());
      },
    },
    lstrip: {
      type: 'builtin',
      name: 'str.lstrip',
      fn: (chars?: PyValue) => {
        if (chars && isString(chars)) {
          const escaped = chars.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`^[${escaped}]+`);
          return pyString(str.replace(pattern, ''));
        }
        return pyString(str.replace(/^\s+/, ''));
      },
    },
    rstrip: {
      type: 'builtin',
      name: 'str.rstrip',
      fn: (chars?: PyValue) => {
        if (chars && isString(chars)) {
          const escaped = chars.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`[${escaped}]+$`);
          return pyString(str.replace(pattern, ''));
        }
        return pyString(str.replace(/\s+$/, ''));
      },
    },
    split: {
      type: 'builtin',
      name: 'str.split',
      fn: (sep?: PyValue, maxsplit?: PyValue) => {
        const limit = maxsplit && isNumber(maxsplit) ? Math.floor(maxsplit.value) : -1;
        if (sep && isString(sep)) {
          if (limit < 0) {
            return pyList(str.split(sep.value).map(s => pyString(s)));
          }
          const parts: string[] = [];
          let remaining = str;
          for (let i = 0; i < limit; i++) {
            const idx = remaining.indexOf(sep.value);
            if (idx === -1) break;
            parts.push(remaining.slice(0, idx));
            remaining = remaining.slice(idx + sep.value.length);
          }
          parts.push(remaining);
          return pyList(parts.map(s => pyString(s)));
        }
        return pyList(str.split(/\s+/).filter(s => s).map(s => pyString(s)));
      },
    },
    join: {
      type: 'builtin',
      name: 'str.join',
      fn: (iterable: PyValue) => {
        const elements =
          isList(iterable) || isTuple(iterable) ? iterable.elements :
          iterable.type === 'iterator' ? iterable.values :
          null;

        if (elements) {
          const strs = elements.map(el => {
            if (!isString(el)) throw new TypeError('sequence item: expected str', line, column);
            return el.value;
          });
          return pyString(strs.join(str));
        }
        throw new TypeError(`can only join an iterable`, line, column);
      },
    },
    replace: {
      type: 'builtin',
      name: 'str.replace',
      fn: (old: PyValue, newStr: PyValue, count?: PyValue) => {
        if (!isString(old) || !isString(newStr)) {
          throw new TypeError('replace() arguments must be strings', line, column);
        }
        if (count && isNumber(count)) {
          let result = str;
          let n = Math.floor(count.value);
          let start = 0;
          while (n > 0) {
            const idx = result.indexOf(old.value, start);
            if (idx === -1) break;
            result = result.slice(0, idx) + newStr.value + result.slice(idx + old.value.length);
            start = idx + newStr.value.length;
            n--;
          }
          return pyString(result);
        }
        return pyString(str.split(old.value).join(newStr.value));
      },
    },
    startswith: {
      type: 'builtin',
      name: 'str.startswith',
      fn: (prefix: PyValue) => {
        if (!isString(prefix)) throw new TypeError('startswith() arg must be str', line, column);
        return pyBoolean(str.startsWith(prefix.value));
      },
    },
    endswith: {
      type: 'builtin',
      name: 'str.endswith',
      fn: (suffix: PyValue) => {
        if (!isString(suffix)) throw new TypeError('endswith() arg must be str', line, column);
        return pyBoolean(str.endsWith(suffix.value));
      },
    },
    find: {
      type: 'builtin',
      name: 'str.find',
      fn: (sub: PyValue) => {
        if (!isString(sub)) throw new TypeError('find() arg must be str', line, column);
        return pyNumber(str.indexOf(sub.value));
      },
    },
    count: {
      type: 'builtin',
      name: 'str.count',
      fn: (sub: PyValue) => {
        if (!isString(sub)) throw new TypeError('count() arg must be str', line, column);
        if (sub.value === '') return pyNumber(str.length + 1);
        let count = 0;
        let pos = 0;
        while (true) {
          const idx = str.indexOf(sub.value, pos);
          if (idx === -1) break;
          count++;
          pos = idx + sub.value.length;
        }
        return pyNumber(count);
      },
    },
    isdigit: {
      type: 'builtin',
      name: 'str.isdigit',
      fn: () => pyBoolean(str.length > 0 && /^\d+$/.test(str)),
    },
    isalpha: {
      type: 'builtin',
      name: 'str.isalpha',
      fn: () => pyBoolean(str.length > 0 && /^[a-zA-Z]+$/.test(str)),
    },
    isalnum: {
      type: 'builtin',
      name: 'str.isalnum',
      fn: () => pyBoolean(str.length > 0 && /^[a-zA-Z0-9]+$/.test(str)),
    },
    isspace: {
      type: 'builtin',
      name: 'str.isspace',
      fn: () => pyBoolean(str.length > 0 && /^\s+$/.test(str)),
    },
    swapcase: {
      type: 'builtin',
      name: 'str.swapcase',
      fn: () => pyString(str.split('').map(c =>
        c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
      ).join('')),
    },
    index: {
      type: 'builtin',
      name: 'str.index',
      fn: (sub: PyValue) => {
        if (!isString(sub)) throw new TypeError('index() arg must be str', line, column);
        const idx = str.indexOf(sub.value);
        if (idx === -1) throw new ValueError('substring not found', line, column);
        return pyNumber(idx);
      },
    },
    rfind: {
      type: 'builtin',
      name: 'str.rfind',
      fn: (sub: PyValue) => {
        if (!isString(sub)) throw new TypeError('rfind() arg must be str', line, column);
        return pyNumber(str.lastIndexOf(sub.value));
      },
    },
    ljust: {
      type: 'builtin',
      name: 'str.ljust',
      fn: (width: PyValue, fill?: PyValue) => {
        if (!isNumber(width)) throw new TypeError('ljust() argument must be an integer', line, column);
        const fillChar = fill && isString(fill) ? fill.value : ' ';
        return pyString(str.padEnd(Math.floor(width.value), fillChar));
      },
    },
    rjust: {
      type: 'builtin',
      name: 'str.rjust',
      fn: (width: PyValue, fill?: PyValue) => {
        if (!isNumber(width)) throw new TypeError('rjust() argument must be an integer', line, column);
        const fillChar = fill && isString(fill) ? fill.value : ' ';
        return pyString(str.padStart(Math.floor(width.value), fillChar));
      },
    },
    center: {
      type: 'builtin',
      name: 'str.center',
      fn: (width: PyValue, fill?: PyValue) => {
        if (!isNumber(width)) throw new TypeError('center() argument must be an integer', line, column);
        const w = Math.floor(width.value);
        const fillChar = fill && isString(fill) ? fill.value : ' ';
        if (str.length >= w) return pyString(str);
        const total = w - str.length;
        const left = Math.floor(total / 2);
        const right = total - left;
        return pyString(fillChar.repeat(left) + str + fillChar.repeat(right));
      },
    },
    isupper: {
      type: 'builtin',
      name: 'str.isupper',
      fn: () => pyBoolean(str.length > 0 && str === str.toUpperCase() && str !== str.toLowerCase()),
    },
    islower: {
      type: 'builtin',
      name: 'str.islower',
      fn: () => pyBoolean(str.length > 0 && str === str.toLowerCase() && str !== str.toUpperCase()),
    },
    istitle: {
      type: 'builtin',
      name: 'str.istitle',
      fn: () => {
        if (str.length === 0) return pyBoolean(false);
        const titled = str.replace(/\b\w/g, c => c.toUpperCase());
        return pyBoolean(str === titled && /[A-Z]/.test(str));
      },
    },
    isnumeric: {
      type: 'builtin',
      name: 'str.isnumeric',
      fn: () => pyBoolean(str.length > 0 && /^\p{N}+$/u.test(str)),
    },
    isdecimal: {
      type: 'builtin',
      name: 'str.isdecimal',
      fn: () => pyBoolean(str.length > 0 && /^\p{Nd}+$/u.test(str)),
    },
    isidentifier: {
      type: 'builtin',
      name: 'str.isidentifier',
      fn: () => pyBoolean(str.length > 0 && /^[a-zA-Z_]\w*$/.test(str)),
    },
    isprintable: {
      type: 'builtin',
      name: 'str.isprintable',
      fn: () => pyBoolean(!/[\x00-\x1f\x7f-\x9f]/.test(str)),
    },
    translate: {
      type: 'builtin',
      name: 'str.translate',
      fn: (table: PyValue) => {
        if (!isDict(table)) throw new TypeError('translate() argument must be a dict', line, column);
        let result = '';
        for (const ch of str) {
          const code = ch.codePointAt(0)!;
          const mapped = dictGet(table, pyNumber(code));
          if (mapped === undefined) {
            result += ch;
          } else if (isNone(mapped)) {
            // delete character
          } else if (isString(mapped)) {
            result += mapped.value;
          } else if (isNumber(mapped)) {
            result += String.fromCodePoint(mapped.value);
          }
        }
        return pyString(result);
      },
    },
    partition: {
      type: 'builtin',
      name: 'str.partition',
      fn: (sep: PyValue) => {
        if (!isString(sep)) throw new TypeError('partition() arg must be str', line, column);
        const idx = str.indexOf(sep.value);
        if (idx === -1) {
          return pyList([pyString(str), pyString(''), pyString('')]);
        }
        return pyList([
          pyString(str.slice(0, idx)),
          pyString(sep.value),
          pyString(str.slice(idx + sep.value.length)),
        ]);
      },
    },
    rpartition: {
      type: 'builtin',
      name: 'str.rpartition',
      fn: (sep: PyValue) => {
        if (!isString(sep)) throw new TypeError('rpartition() arg must be str', line, column);
        const idx = str.lastIndexOf(sep.value);
        if (idx === -1) {
          return pyList([pyString(''), pyString(''), pyString(str)]);
        }
        return pyList([
          pyString(str.slice(0, idx)),
          pyString(sep.value),
          pyString(str.slice(idx + sep.value.length)),
        ]);
      },
    },
    splitlines: {
      type: 'builtin',
      name: 'str.splitlines',
      fn: () => pyList(str.split(/\r\n|\r|\n/).map(s => pyString(s))),
    },
    expandtabs: {
      type: 'builtin',
      name: 'str.expandtabs',
      fn: (tabsize?: PyValue) => {
        const size = tabsize && isNumber(tabsize) ? Math.floor(tabsize.value) : 8;
        let result = '';
        let col = 0;
        for (const ch of str) {
          if (ch === '\t') {
            const spaces = size - (col % size);
            result += ' '.repeat(spaces);
            col += spaces;
          } else if (ch === '\n' || ch === '\r') {
            result += ch;
            col = 0;
          } else {
            result += ch;
            col++;
          }
        }
        return pyString(result);
      },
    },
    removeprefix: {
      type: 'builtin',
      name: 'str.removeprefix',
      fn: (prefix: PyValue) => {
        if (!isString(prefix)) throw new TypeError('removeprefix() arg must be str', line, column);
        return pyString(str.startsWith(prefix.value) ? str.slice(prefix.value.length) : str);
      },
    },
    removesuffix: {
      type: 'builtin',
      name: 'str.removesuffix',
      fn: (suffix: PyValue) => {
        if (!isString(suffix)) throw new TypeError('removesuffix() arg must be str', line, column);
        return pyString(suffix.value && str.endsWith(suffix.value) ? str.slice(0, -suffix.value.length) : str);
      },
    },
    format: {
      type: 'builtin',
      name: 'str.format',
      acceptsKwargs: true,
      fn: (...rawArgs: (PyValue | PyKwargs)[]) => {
        const { args, kwargs } = extractKwargs(rawArgs);
        let result = str;
        let argIndex = 0;
        result = result.replace(/\{(\w*)\}/g, (match, key) => {
          if (key === '' || /^\d+$/.test(key)) {
            const index = key === '' ? argIndex++ : parseInt(key, 10);
            if (index >= args.length) {
              throw new IndexError('tuple index out of range', line, column);
            }
            return isString(args[index]) ? args[index].value : String(valueToJs(args[index]));
          }
          if (kwargs[key] !== undefined) {
            const val = kwargs[key];
            return isString(val) ? val.value : String(valueToJs(val));
          }
          return match;
        });
        return pyString(result);
      },
    },
  };

  if (methods[attr]) {
    return methods[attr];
  }

  throw new TypeError(`'str' object has no attribute '${attr}'`, line, column);
}

export function getListMethod(obj: PyValue & { type: 'list' }, attr: string, line: number, column: number): PyValue {
  const list = obj.elements;

  const methods: Record<string, PyBuiltin> = {
    append: {
      type: 'builtin',
      name: 'list.append',
      fn: (item: PyValue) => {
        list.push(item);
        return pyNone();
      },
    },
    extend: {
      type: 'builtin',
      name: 'list.extend',
      fn: (iterable: PyValue) => {
        if (isList(iterable) || isTuple(iterable)) {
          list.push(...iterable.elements);
        } else {
          throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        }
        return pyNone();
      },
    },
    insert: {
      type: 'builtin',
      name: 'list.insert',
      fn: (index: PyValue, item: PyValue) => {
        if (!isNumber(index)) throw new TypeError('integer argument expected', line, column);
        list.splice(index.value, 0, item);
        return pyNone();
      },
    },
    remove: {
      type: 'builtin',
      name: 'list.remove',
      fn: (item: PyValue) => {
        const idx = list.findIndex(el => pyEquals(el, item));
        if (idx === -1) throw new TypeError('list.remove(x): x not in list', line, column);
        list.splice(idx, 1);
        return pyNone();
      },
    },
    pop: {
      type: 'builtin',
      name: 'list.pop',
      fn: (index?: PyValue) => {
        if (list.length === 0) throw new IndexError('pop from empty list', line, column);
        const idx = index && isNumber(index) ? index.value : -1;
        const normalizedIdx = idx < 0 ? list.length + idx : idx;
        if (normalizedIdx < 0 || normalizedIdx >= list.length) {
          throw new IndexError('pop index out of range', line, column);
        }
        return list.splice(normalizedIdx, 1)[0];
      },
    },
    clear: {
      type: 'builtin',
      name: 'list.clear',
      fn: () => {
        list.length = 0;
        return pyNone();
      },
    },
    index: {
      type: 'builtin',
      name: 'list.index',
      fn: (item: PyValue) => {
        const idx = list.findIndex(el => pyEquals(el, item));
        if (idx === -1) throw new TypeError('x is not in list', line, column);
        return pyNumber(idx);
      },
    },
    count: {
      type: 'builtin',
      name: 'list.count',
      fn: (item: PyValue) => {
        return pyNumber(list.filter(el => pyEquals(el, item)).length);
      },
    },
    sort: {
      type: 'builtin',
      name: 'list.sort',
      acceptsKwargs: true,
      fn: (...rawArgs: (PyValue | PyKwargs)[]) => {
        const { kwargs } = extractKwargs(rawArgs);
        const keyFunc = kwargs.key;
        const reverse = kwargs.reverse?.type === 'boolean' && (kwargs.reverse as any).value;

        if (keyFunc && (keyFunc.type === 'function' || keyFunc.type === 'builtin')) {
          const itemsWithKeys = list.map(item => ({
            item,
            key: applyKeyFunction(keyFunc, item),
          }));

          itemsWithKeys.sort((a, b) => compareValues(a.key, b.key));

          list.length = 0;
          for (const { item } of itemsWithKeys) {
            list.push(item);
          }
        } else {
          list.sort((a, b) => compareValues(a, b));
        }

        if (reverse) {
          list.reverse();
        }

        return pyNone();
      },
    },
    reverse: {
      type: 'builtin',
      name: 'list.reverse',
      fn: () => {
        list.reverse();
        return pyNone();
      },
    },
    copy: {
      type: 'builtin',
      name: 'list.copy',
      fn: () => pyList([...list]),
    },
  };

  if (methods[attr]) {
    return methods[attr];
  }

  throw new TypeError(`'list' object has no attribute '${attr}'`, line, column);
}

export function getDictMethod(obj: PyValue & { type: 'dict' }, attr: string, line: number, column: number): PyValue {
  const dict = obj;

  const methods: Record<string, PyBuiltin> = {
    keys: {
      type: 'builtin',
      name: 'dict.keys',
      fn: () => pyList(dictKeys(dict)),
    },
    values: {
      type: 'builtin',
      name: 'dict.values',
      fn: () => pyList(dictValues(dict)),
    },
    items: {
      type: 'builtin',
      name: 'dict.items',
      fn: () => pyList(dictPairs(dict).map(([k, v]) => pyList([k, v]))),
    },
    get: {
      type: 'builtin',
      name: 'dict.get',
      fn: (key: PyValue, defaultVal?: PyValue) => {
        const value = dictGet(dict, key, line, column);
        if (value === undefined || (defaultVal !== undefined && isNone(value))) {
          return defaultVal ?? pyNone();
        }
        return value;
      },
    },
    pop: {
      type: 'builtin',
      name: 'dict.pop',
      fn: (key: PyValue, defaultVal?: PyValue) => {
        const value = dictGet(dict, key, line, column);
        if (value !== undefined) {
          dictDelete(dict, key);
          return value;
        }
        if (defaultVal !== undefined) return defaultVal;
        throw new KeyError(pyRepr(key), line, column);
      },
    },
    update: {
      type: 'builtin',
      name: 'dict.update',
      fn: (other: PyValue) => {
        if (isDict(other)) {
          for (const [k, v] of dictPairs(other)) {
            dictSet(dict, k, v);
          }
        } else {
          throw new TypeError(`'${other.type}' object is not a mapping`, line, column);
        }
        return pyNone();
      },
    },
    popitem: {
      type: 'builtin',
      name: 'dict.popitem',
      fn: () => {
        if (dict.entries.size === 0) throw new KeyError('popitem(): dictionary is empty', line, column);
        const pairs = dictPairs(dict);
        const [lastKey, val] = pairs[pairs.length - 1];
        dictDelete(dict, lastKey);
        return pyList([lastKey, val]);
      },
    },
    clear: {
      type: 'builtin',
      name: 'dict.clear',
      fn: () => {
        dict.entries.clear();
        return pyNone();
      },
    },
    copy: {
      type: 'builtin',
      name: 'dict.copy',
      fn: () => pyDictFromPairs(dictPairs(dict)),
    },
    setdefault: {
      type: 'builtin',
      name: 'dict.setdefault',
      fn: (key: PyValue, defaultVal?: PyValue) => {
        if (!dictHas(dict, key, line, column)) {
          dictSet(dict, key, defaultVal ?? pyNone());
        }
        return dictGet(dict, key)!;
      },
    },
  };

  if (methods[attr]) {
    return methods[attr];
  }

  throw new TypeError(`'dict' object has no attribute '${attr}'`, line, column);
}

export function getSetMethod(obj: PyValue & { type: 'set' }, attr: string, line: number, column: number): PyValue {
  const set = obj;

  const methods: Record<string, PyBuiltin> = {
    add: {
      type: 'builtin',
      name: 'set.add',
      fn: (item: PyValue) => {
        setAdd(set, item, line, column);
        return pyNone();
      },
    },
    remove: {
      type: 'builtin',
      name: 'set.remove',
      fn: (item: PyValue) => {
        if (!setDelete(set, item, line, column)) {
          throw new KeyError(pyRepr(item), line, column);
        }
        return pyNone();
      },
    },
    discard: {
      type: 'builtin',
      name: 'set.discard',
      fn: (item: PyValue) => {
        setDelete(set, item, line, column);
        return pyNone();
      },
    },
    pop: {
      type: 'builtin',
      name: 'set.pop',
      fn: () => {
        if (set.entries.size === 0) {
          throw new KeyError('pop from an empty set', line, column);
        }
        const [hk, first] = set.entries.entries().next().value as [string | number, PyValue];
        set.entries.delete(hk);
        return first;
      },
    },
    clear: {
      type: 'builtin',
      name: 'set.clear',
      fn: () => {
        set.entries.clear();
        return pyNone();
      },
    },
    copy: {
      type: 'builtin',
      name: 'set.copy',
      fn: () => pySetFromValues(setValues(set)),
    },
    update: {
      type: 'builtin',
      name: 'set.update',
      fn: (other: PyValue) => {
        for (const item of getHashableItems(other, line, column)) {
          setAdd(set, item, line, column);
        }
        return pyNone();
      },
    },
    union: {
      type: 'builtin',
      name: 'set.union',
      fn: (other: PyValue) => {
        const result = pySetFromValues(setValues(set));
        for (const item of getHashableItems(other, line, column)) {
          setAdd(result, item, line, column);
        }
        return result;
      },
    },
    intersection: {
      type: 'builtin',
      name: 'set.intersection',
      fn: (other: PyValue) => {
        const otherSet = pySetFromValues(getHashableItems(other, line, column));
        return pySetFromValues(setValues(set).filter(item => setHas(otherSet, item)));
      },
    },
    difference: {
      type: 'builtin',
      name: 'set.difference',
      fn: (other: PyValue) => {
        const otherSet = pySetFromValues(getHashableItems(other, line, column));
        return pySetFromValues(setValues(set).filter(item => !setHas(otherSet, item)));
      },
    },
    symmetric_difference: {
      type: 'builtin',
      name: 'set.symmetric_difference',
      fn: (other: PyValue) => {
        const otherSet = pySetFromValues(getHashableItems(other, line, column));
        const result = pySetFromValues(setValues(set).filter(item => !setHas(otherSet, item)));
        for (const item of setValues(otherSet)) {
          if (!setHas(set, item)) setAdd(result, item);
        }
        return result;
      },
    },
    issubset: {
      type: 'builtin',
      name: 'set.issubset',
      fn: (other: PyValue) => {
        const otherSet = pySetFromValues(getHashableItems(other, line, column));
        return pyBoolean(setValues(set).every(item => setHas(otherSet, item)));
      },
    },
    issuperset: {
      type: 'builtin',
      name: 'set.issuperset',
      fn: (other: PyValue) => {
        return pyBoolean(getHashableItems(other, line, column).every(item => setHas(set, item)));
      },
    },
    isdisjoint: {
      type: 'builtin',
      name: 'set.isdisjoint',
      fn: (other: PyValue) => {
        const otherSet = pySetFromValues(getHashableItems(other, line, column));
        return pyBoolean(!setValues(set).some(item => setHas(otherSet, item)));
      },
    },
  };

  if (methods[attr]) {
    return methods[attr];
  }

  throw new TypeError(`'set' object has no attribute '${attr}'`, line, column);
}

/** Elements of an iterable used in set operations. Hashability is enforced
 *  when the elements are inserted into a set (setAdd / pyHashKey). */
export function getHashableItems(value: PyValue, line: number, column: number): PyValue[] {
  if (isSet(value)) {
    return setValues(value);
  }

  if (isList(value) || isTuple(value)) {
    return value.elements;
  }

  if (isString(value)) {
    return value.value.split('').map(c => pyString(c));
  }

  if (value.type === 'iterator') {
    return value.values;
  }

  if (isDict(value)) {
    return dictKeys(value);
  }

  throw new TypeError(`'${value.type}' object is not iterable`, line, column);
}
