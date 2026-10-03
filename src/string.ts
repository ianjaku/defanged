/**
 * The `string` module: the character-class constants and `capwords`, as an
 * opt-in plugin.
 *
 *   import { string } from 'defanged/string';
 *   createInterpreter({ modules: [string] });
 *
 * `Template` and `Formatter` are classes and so are left out, like every
 * other class-based API.
 */

import { AttributeError, TypeError } from './errors';
import { Kwargs, PyBuiltin, PyModule, PyValue, typeName } from './values';

const ascii_lowercase = 'abcdefghijklmnopqrstuvwxyz';
const ascii_uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const digits = '0123456789';
const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const whitespace = ' \t\n\r\x0b\x0c';

function capwords(_rt: unknown, args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length < 1 || args.length > 2) {
    throw new TypeError(`capwords() takes from 1 to 2 positional arguments but ${args.length} were given`);
  }
  const s = args[0];
  if (typeof s !== 'string') throw new AttributeError(`'${typeName(s)}' object has no attribute 'split'`);
  const sep = args.length > 1 ? args[1] : kwargs?.get('sep') ?? null;
  const capitalize = (w: string): string => {
    const chars = Array.from(w);
    return chars.length === 0 ? '' : chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
  };
  // With no separator, runs of whitespace collapse to one space, like `' '.join(s.split())`.
  if (sep === null) return s.split(/[ \t\n\r\x0b\x0c]+/).filter((w) => w !== '').map(capitalize).join(' ');
  if (typeof sep !== 'string') throw new TypeError(`must be str or None, not ${typeName(sep)}`);
  return s.split(sep).map(capitalize).join(sep);
}

export const string: PyModule = new PyModule('string', new Map<string, PyValue>([
  ['ascii_letters', ascii_lowercase + ascii_uppercase],
  ['ascii_lowercase', ascii_lowercase],
  ['ascii_uppercase', ascii_uppercase],
  ['digits', digits],
  ['hexdigits', digits + 'abcdefABCDEF'],
  ['octdigits', '01234567'],
  ['punctuation', punctuation],
  ['printable', digits + ascii_lowercase + ascii_uppercase + punctuation + whitespace],
  ['whitespace', whitespace],
  ['capwords', new PyBuiltin('capwords', capwords, true)],
]));
