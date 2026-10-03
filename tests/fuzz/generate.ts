/**
 * Random Python programs for differential testing against CPython.
 *
 * Each program is a list of independent probes: an expression printed with
 * repr(), wrapped so an exception prints its type and message instead. The
 * generator is seeded, so a failing program can be regenerated from its
 * seed and probe index. Expressions are built from a small grammar over
 * ints, floats, strings, lists, tuples and dicts, the operators, slicing,
 * the common built-ins and methods, and format specs: the surface LLM
 * scripts use, where a one-digit difference from CPython matters.
 */

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  /** xorshift32 */
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

type Kind = 'int' | 'float' | 'str' | 'list' | 'tuple' | 'dict' | 'bool' | 'none' | 'any';

const STRINGS = ['""', '"abc"', '"Hello, World"', '"a,b,,c"', '"  pad  "', '"x" * 3', '"ß"', '"日本"', '"a\\tb\\n"', '"3.5"', '"-12"', '"1e3"', '"0x1f"', '"True"', '"ab" * 2', '"%d items"', '"{}"', '"{:>5}"'];
const INTS = ['0', '1', '-1', '2', '3', '7', '10', '-7', '255', '1000', '2 ** 31', '2 ** 53', '2 ** 64', '-(2 ** 63)', '10 ** 20', '999999999999'];
const FLOATS = ['0.0', '-0.0', '0.5', '1.5', '-2.5', '3.14159', '1e10', '1e-7', '2.675', '0.1 + 0.2', '1e22', '123456789.123456789', 'float("inf")', '-float("inf")', '2.0 ** 60', '1 / 3'];

export class Generator {
  constructor(private readonly rng: Rng) {}

  private atom(kind: Kind): string {
    const r = this.rng;
    switch (kind) {
      case 'int': return r.pick(INTS);
      case 'float': return r.pick(FLOATS);
      case 'str': return r.pick(STRINGS);
      case 'bool': return r.pick(['True', 'False']);
      case 'none': return 'None';
      case 'list': return `[${this.items(r.int(0, 4))}]`;
      case 'tuple': {
        const n = r.int(0, 3);
        return n === 1 ? `(${this.scalar()},)` : `(${this.items(n)})`;
      }
      case 'dict': {
        const n = r.int(0, 3);
        const entries: string[] = [];
        for (let i = 0; i < n; i++) entries.push(`${r.pick([...STRINGS.slice(0, 5), ...INTS.slice(0, 5), 'True', 'None', '(1, 2)', '1.5'])}: ${this.scalar()}`);
        return `{${entries.join(', ')}}`;
      }
      default: return this.atom(r.pick(['int', 'float', 'str', 'bool', 'none', 'list', 'tuple', 'dict'] as const));
    }
  }

  private scalar(): string {
    return this.atom(this.rng.pick(['int', 'int', 'float', 'str', 'str', 'bool', 'none'] as const));
  }

  private items(n: number): string {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.rng.chance(0.15) ? this.atom('list') : this.scalar());
    return out.join(', ');
  }

  /** An expression of bounded depth. */
  expr(depth: number = 2): string {
    const r = this.rng;
    if (depth <= 0 || r.chance(0.25)) return this.atom('any');
    const sub = (): string => this.expr(depth - 1);
    switch (r.int(0, 15)) {
      case 0: case 1: {
        const op = r.pick(['+', '-', '*', '/', '//', '%', '**', '<', '<=', '==', '!=', '>', '>=', 'and', 'or', 'in', 'not in', 'is', 'is not', '&', '|', '^', '<<', '>>']);
        // Exponents and shifts stay small so CPython does not spend minutes on one probe.
        // Parenthesized: `2 ** 31 ** 10` would be 2 to the 31**10, which CPython tries to build.
        if (op === '**' || op === '<<') return `((${sub()}) ${op} ${r.pick(['0', '1', '2', '3', '-1', '0.5', '10', '2.5', 'True', '-2'])})`;
        // A sequence times a huge int would make CPython allocate it for real.
        if (op === '*') {
          const right = r.pick(['0', '1', '2', '3', '-1', '0.5', '2.5', 'True', 'None', '"ab"', '[1]', '7']);
          const left = right === '"ab"' || right === '[1]' ? r.pick(['3', '-1', '0', '2.5', 'True', 'None', '"x"', '[0]', '(1,)']) : sub();
          return `(${left} * ${right})`;
        }
        return `(${sub()} ${op} ${sub()})`;
      }
      case 2: return `(${r.pick(['-', 'not ', '+', '~'])}${sub()})`;
      case 3: return `(${sub()})[${this.index()}]`;
      case 4: {
        const fn = r.pick(['len', 'str', 'repr', 'int', 'float', 'bool', 'abs', 'round', 'sorted', 'list', 'tuple', 'min', 'max', 'sum', 'any', 'all', 'type', 'divmod', 'chr', 'ord', 'bin', 'hex', 'oct', 'dict', 'isinstance', 'pow', 'range']);
        // range() gets small bounds so a later list() or sorted() stays cheap.
        if (fn === 'range') return `range(${[...Array(r.int(0, 3))].map(() => r.pick(['0', '1', '3', '10', '-4', '2', '1.5', '"a"', 'None'])).join(', ')})`;
        // pow() with two big ints would keep CPython busy for minutes.
        if (fn === 'pow') return `pow(${this.expr(1)}, ${r.pick(['0', '1', '2', '3', '-1', '0.5', '10', '2.5', 'True', '-2', '"a"'])}${r.chance(0.3) ? ', ' + r.pick(['7', '-7', '0', '2.5']) : ''})`;
        return `${fn}(${this.callArgs()})`;
      }
      case 5: return `(${sub()}).${this.method()}`;
      case 6: return `f"${this.fstring()}"`;
      case 7: return `${r.pick(['"%s|%r|%d"', '"%5.2f"', '"%-4d|%x"', '"%03d"', '"%.3s"', '"%c"', '"%%"', '"%(a)s"', '"%5s"', '"%+d"'])} % ${sub()}`;
      case 8: return `format(${sub()}, ${r.pick(['""', '"d"', '"5"', '">8"', '"<4"', '"^6"', '",.2f"', '".3e"', '".1%"', '"08.3f"', '"x"', '"#x"', '"b"', '"+.2f"', '"_"', '"10,"', '"e"', '"g"', '".0f"', '"n"', '"s"', '"c"', '"o"', '"%"'])})`;
      case 9: return `[${r.pick(['x', 'x * 2', 'str(x)', '(x, x)', 'x if x else None'])} for x in ${sub()} if ${r.pick(['True', 'x', 'x != 0', 'not x'])}]`;
      case 10: return `(${sub()} if ${sub()} else ${sub()})`;
      case 11: return `(${sub()})[${this.slice()}]`;
      case 12: return `round(${sub()}, ${r.int(-2, 3)})`;
      case 13: {
        const wrap = r.pick(['sum', 'min', 'max', 'sorted', 'len', 'list', 'tuple', 'any', 'all', 'len(set', 'list(reversed', 'list(enumerate', 'list(zip', 'dict(enumerate', 'sorted(set']);
        return `${wrap}(${sub()})${wrap.includes('(') ? ')' : ''}`;
      }
      case 14: return `str(${sub()}) + str(${sub()})`;
      default: return `(${sub()}, ${sub()})`;
    }
  }

  private index(): string {
    return this.rng.pick(['0', '1', '-1', '2', '-3', '"a"', '"abc"', '1.0', 'None', 'True', '10', '(1, 2)']);
  }

  private slice(): string {
    const r = this.rng;
    const part = () => (r.chance(0.4) ? '' : String(r.int(-4, 5)));
    return r.chance(0.5) ? `${part()}:${part()}` : `${part()}:${part()}:${r.pick(['', '1', '2', '-1', '-2', '0'])}`;
  }

  private callArgs(): string {
    const n = this.rng.int(0, 2);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(this.expr(1));
    return parts.join(', ');
  }

  private method(): string {
    const r = this.rng;
    // `§` stands for an argument, filled with an atom so the method list stays flat.
    const template = r.pick([
      'upper()', 'lower()', 'title()', 'capitalize()', 'swapcase()', 'strip()', 'strip(§)', 'split()', 'split(§)', 'split(",", 1)', 'join(§)',
      'replace(§, §)', 'startswith(§)', 'endswith(§)', 'find(§)', 'index(§)', 'count(§)', 'isdigit()', 'isalpha()', 'isspace()',
      `zfill(${r.int(0, 8)})`, `center(${r.int(0, 10)}, "*")`, `ljust(${r.int(0, 10)})`, `rjust(${r.int(0, 10)})`, 'format(§)', 'format(§, §)', 'splitlines()',
      'partition(§)', 'rsplit(§)', 'casefold()', 'isnumeric()', 'expandtabs()', 'removeprefix(§)',
      'append(§)', 'extend(§)', 'insert(0, §)', 'pop()', 'pop(§)', 'remove(§)', 'index(§)', 'copy()', 'reverse()', 'sort()', 'sort(reverse=True)', 'sort(key=len)', 'clear()',
      'keys()', 'values()', 'items()', 'get(§)', 'get(§, §)', 'pop(§)', 'setdefault(§, §)', 'update(§)', 'popitem()',
      'is_integer()', 'bit_length()', 'as_integer_ratio()',
    ]);
    return template.replace(/§/g, () => this.atom('any'));
  }

  private fstring(): string {
    const r = this.rng;
    let inner = this.expr(1).replace(/"/g, "'").replace(/\\/g, '');
    // Braces and backslashes inside a replacement field are their own minefield; not the target here.
    if (/[{}\\]/.test(inner)) inner = this.atom(this.rng.pick(['int', 'float', 'str'] as const)).replace(/"/g, "'").replace(/\\/g, '');
    if (/[{}\\]/.test(inner)) inner = '42';
    const spec = r.pick(['', ':>6', ':<6', ':^8', ':,', ':.2f', ':.1%', ':08.2f', ':x', ':e', ':+', ':5d', ':.3', ':_', '!r', '!s', '!a', '!r:>10', '=', ':{w}']);
    return `${r.pick(['', 'v=', 'result: '])}{${inner}${spec}}${r.pick(['', '!', ' end'])}`;
  }

  /** A program of `n` probes. */
  program(n: number): string {
    const lines = ['w = 7'];
    for (let i = 0; i < n; i++) {
      const e = this.expr(this.rng.int(1, 3));
      lines.push(`try:\n    print(${i}, repr(${e}))\nexcept Exception as e:\n    print(${i}, type(e).__name__, e)`);
    }
    return lines.join('\n');
  }
}
