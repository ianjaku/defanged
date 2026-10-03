import { describe, test, expect } from 'bun:test';
import { createInterpreter, ToolDefinition, generateToolsPrompt, runPython, tool, CancelledError } from '../src';
import { parameterNames } from '../src/tools';
import { z } from 'zod';

describe('Tool Injection', () => {
  describe('Basic Tool Calls', () => {
    test('simple tool returns data', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'get_data',
          handler: () => [1, 2, 3, 4, 5],
        }],
      });

      const result = await interpreter.run('get_data()');
      expect(result).toEqual([1, 2, 3, 4, 5]);
    });

    test('tool with parameters', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'multiply',
          handler: (a: number, b: number) => a * b,
        }],
      });

      const result = await interpreter.run('multiply(6, 7)');
      expect(result).toBe(42);
    });

    test('tool returning dict', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'get_config',
          handler: () => ({ theme: 'dark', language: 'en' }),
        }],
      });

      const result = await interpreter.run(`
config = get_config()
config['theme']
`);
      expect(result).toBe('dark');
    });

    test('tool returning nested data', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'get_users',
          handler: () => [
            { id: 1, name: 'Alice', tags: ['admin', 'active'] },
            { id: 2, name: 'Bob', tags: ['user'] },
          ],
        }],
      });

      const result = await interpreter.run(`
users = get_users()
users[0]['name']
`);
      expect(result).toBe('Alice');
    });
  });

  describe('Async Tool Handlers', () => {
    test('async tool handler', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'fetch_users',
          handler: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
          },
        }],
      });

      const result = await interpreter.run(`
users = fetch_users()
[u['name'] for u in users]
`);
      expect(result).toEqual(['Alice', 'Bob']);
    });

    test('multiple async calls', async () => {
      const interpreter = createInterpreter({
        tools: [
          {
            name: 'get_a',
            handler: async () => {
              await new Promise((r) => setTimeout(r, 5));
              return 10;
            },
          },
          {
            name: 'get_b',
            handler: async () => {
              await new Promise((r) => setTimeout(r, 5));
              return 20;
            },
          },
        ],
      });

      const result = await interpreter.run(`
a = get_a()
b = get_b()
a + b
`);
      expect(result).toBe(30);
    });
  });

  describe('Tool Chaining', () => {
    test('chaining multiple tools', async () => {
      const interpreter = createInterpreter({
        tools: [
          {
            name: 'list_transactions',
            handler: () => [
              { amount: 100, category: 'food' },
              { amount: 200, category: 'transport' },
              { amount: 150, category: 'food' },
            ],
          },
          {
            name: 'get_exchange_rate',
            handler: (currency: string) => (currency === 'EUR' ? 0.85 : 1.0),
          },
        ],
      });

      const result = await interpreter.run(`
transactions = list_transactions()
rate = get_exchange_rate('EUR')
total_eur = sum([t['amount'] * rate for t in transactions])
total_eur
`);
      expect(result).toBe(382.5);
    });
  });

  describe('Financial Use Cases', () => {
    test('count transactions by month', async () => {
      const transactions = [
        { id: 1, date: '2024-01-15', amount: 100 },
        { id: 2, date: '2024-01-20', amount: 200 },
        { id: 3, date: '2024-02-10', amount: 150 },
        { id: 4, date: '2024-02-25', amount: 300 },
        { id: 5, date: '2024-03-05', amount: 250 },
      ];

      const interpreter = createInterpreter({
        tools: [{
          name: 'list_bank_transactions',
          handler: () => transactions,
        }],
      });

      const result = await interpreter.run(`
transactions = list_bank_transactions()
monthly_counts = {}
for t in transactions:
    month = t['date'][:7]
    if month not in monthly_counts:
        monthly_counts[month] = 0
    monthly_counts[month] += 1
monthly_counts
`);
      expect(result).toEqual({ '2024-01': 2, '2024-02': 2, '2024-03': 1 });
    });

    test('calculate total by category', async () => {
      const invoices = [
        { id: 1, category: 'services', amount: 1000 },
        { id: 2, category: 'products', amount: 500 },
        { id: 3, category: 'services', amount: 750 },
        { id: 4, category: 'products', amount: 250 },
      ];

      const interpreter = createInterpreter({
        tools: [{
          name: 'list_invoices',
          handler: () => invoices,
        }],
      });

      const result = await interpreter.run(`
invoices = list_invoices()
totals = {}
for inv in invoices:
    cat = inv['category']
    if cat not in totals:
        totals[cat] = 0
    totals[cat] += inv['amount']
totals
`);
      expect(result).toEqual({ services: 1750, products: 750 });
    });

    test('filter overdue payments', async () => {
      const payments = [
        { id: 1, due_date: '2024-01-01', paid: true },
        { id: 2, due_date: '2024-01-15', paid: false },
        { id: 3, due_date: '2024-02-01', paid: false },
      ];

      const interpreter = createInterpreter({
        tools: [{
          name: 'list_payments',
          handler: () => payments,
        }],
      });

      const result = await interpreter.run(`
payments = list_payments()
overdue = [p for p in payments if not p['paid']]
len(overdue)
`);
      expect(result).toBe(2);
    });

    test('complex aggregation with multiple data sources', async () => {
      const transactions = [
        { amount: 1000, type: 'income' },
        { amount: 500, type: 'income' },
        { amount: -200, type: 'expense' },
      ];
      const invoices = [
        { amount: 800 },
        { amount: 600 },
      ];

      const interpreter = createInterpreter({
        tools: [
          { name: 'list_bank_transactions', handler: () => transactions },
          { name: 'list_invoices', handler: () => invoices },
        ],
      });

      const result = await interpreter.run(`
transactions = list_bank_transactions()
invoices = list_invoices()

total_income = sum([t['amount'] for t in transactions if t['amount'] > 0])
total_invoiced = sum([i['amount'] for i in invoices])

{
    'total_income': total_income,
    'total_invoiced': total_invoiced,
    'difference': total_income - total_invoiced
}
`);
      expect(result).toEqual({
        total_income: 1500,
        total_invoiced: 1400,
        difference: 100,
      });
    });

    test('group and aggregate transactions', async () => {
      const transactions = [
        { date: '2024-01-05', category: 'food', amount: 50 },
        { date: '2024-01-10', category: 'transport', amount: 30 },
        { date: '2024-01-15', category: 'food', amount: 75 },
        { date: '2024-02-01', category: 'food', amount: 60 },
        { date: '2024-02-10', category: 'transport', amount: 40 },
      ];

      const interpreter = createInterpreter({
        tools: [{
          name: 'list_transactions',
          handler: () => transactions,
        }],
      });

      const result = await interpreter.run(`
transactions = list_transactions()
summary = {}
for t in transactions:
    month = t['date'][:7]
    cat = t['category']
    key = month + '_' + cat
    if key not in summary:
        summary[key] = 0
    summary[key] += t['amount']
summary
`);
      expect(result).toEqual({
        '2024-01_food': 125,
        '2024-01_transport': 30,
        '2024-02_food': 60,
        '2024-02_transport': 40,
      });
    });
  });

  describe('Error Cases', () => {
    test('undefined tool throws NameError', async () => {
      const interpreter = createInterpreter({ tools: [] });
      await expect(interpreter.run('unknown_function()')).rejects.toThrow(
        "name 'unknown_function' is not defined"
      );
    });

    test('tool handler error propagates', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'failing_tool',
          handler: () => {
            throw new Error('Database connection failed');
          },
        }],
      });

      await expect(interpreter.run('failing_tool()')).rejects.toThrow('Database connection failed');
    });
  });

  describe('Generate Tools Prompt', () => {
    test('generates prompt from tool definitions', () => {
      const tools: ToolDefinition[] = [
        { name: 'list_bank_transactions', description: 'Get all bank transactions', handler: () => [] },
        { name: 'list_invoices', description: 'Get all invoices', handler: () => [] },
      ];

      const prompt = generateToolsPrompt(tools);
      expect(prompt).toContain('list_bank_transactions');
      expect(prompt).toContain('list_invoices');
      expect(prompt).toContain('Get all bank transactions');
    });
  });

  describe('Keyword Arguments', () => {
    test('tool with keyword arguments only', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'fetch_data',
          handler: (options?: { year?: number; limit?: number }) => {
            return { year: options?.year ?? null, limit: options?.limit ?? null };
          },
        }],
      });

      const result = await interpreter.run('fetch_data(year=2025)');
      expect(result).toEqual({ year: 2025, limit: null });
    });

    test('tool with multiple keyword arguments', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'fetch_data',
          handler: (options?: { year?: number; limit?: number; category?: string }) => {
            return options;
          },
        }],
      });

      const result = await interpreter.run('fetch_data(year=2024, limit=100, category="sales")');
      expect(result).toEqual({ year: 2024, limit: 100, category: 'sales' });
    });

    test('tool with positional and keyword arguments', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'search',
          handler: (query: string, options?: { limit?: number; offset?: number }) => {
            return { query, limit: options?.limit, offset: options?.offset };
          },
        }],
      });

      const result = await interpreter.run('search("test query", limit=10, offset=20)');
      expect(result).toEqual({ query: 'test query', limit: 10, offset: 20 });
    });

    test('tool with no arguments still works', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'get_all',
          handler: () => [1, 2, 3],
        }],
      });

      const result = await interpreter.run('get_all()');
      expect(result).toEqual([1, 2, 3]);
    });

    test('tool with only positional arguments still works', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'add',
          handler: (a: number, b: number) => a + b,
        }],
      });

      const result = await interpreter.run('add(5, 3)');
      expect(result).toBe(8);
    });

    test('realistic HubSpot-like filtering scenario', async () => {
      const allDeals = [
        { id: '1', amount: 1000, year: 2024 },
        { id: '2', amount: 2000, year: 2025 },
        { id: '3', amount: 500, year: 2025 },
        { id: '4', amount: 3000, year: 2024 },
      ];

      const interpreter = createInterpreter({
        tools: [{
          name: 'fetch_deals',
          handler: (options?: { year?: number; min_amount?: number }) => {
            let deals = allDeals;
            if (options?.year) {
              deals = deals.filter(d => d.year === options.year);
            }
            const minAmount = options?.min_amount;
            if (minAmount !== undefined) {
              deals = deals.filter(d => d.amount >= minAmount);
            }
            return deals;
          },
        }],
      });

      // Test year filter
      const result2025 = await interpreter.run('fetch_deals(year=2025)');
      expect(result2025).toEqual([
        { id: '2', amount: 2000, year: 2025 },
        { id: '3', amount: 500, year: 2025 },
      ]);

      // Test min_amount filter
      const resultMin = await interpreter.run('fetch_deals(min_amount=1500)');
      expect(resultMin).toEqual([
        { id: '2', amount: 2000, year: 2025 },
        { id: '4', amount: 3000, year: 2024 },
      ]);

      // Test combined filters
      const resultCombined = await interpreter.run('fetch_deals(year=2025, min_amount=1000)');
      expect(resultCombined).toEqual([
        { id: '2', amount: 2000, year: 2025 },
      ]);
    });

    test('async tool with keyword arguments', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'fetch_async',
          handler: async (options?: { delay?: number; value?: string }) => {
            await new Promise(r => setTimeout(r, options?.delay ?? 1));
            return { received: options?.value ?? 'default' };
          },
        }],
      });

      const result = await interpreter.run('fetch_async(value="hello", delay=5)');
      expect(result).toEqual({ received: 'hello' });
    });

    test('kwargs with snake_case converted correctly', async () => {
      const interpreter = createInterpreter({
        tools: [{
          name: 'fetch_items',
          handler: (options?: { max_records?: number; include_deleted?: boolean }) => {
            return {
              maxRecords: options?.max_records,
              includeDeleted: options?.include_deleted,
            };
          },
        }],
      });

      const result = await interpreter.run('fetch_items(max_records=50, include_deleted=True)');
      expect(result).toEqual({ maxRecords: 50, includeDeleted: true });
    });
  });
});

describe('Date Marshalling', () => {
  test('JS Date marshals to a datetime, not an empty dict', async () => {
    const interpreter = createInterpreter({
      tools: [{
        name: 'get_date',
        handler: () => new Date('2024-01-15T10:30:00Z'),
      }],
    });
    const result = await interpreter.run(`
d = get_date()
[d.year, d.month, d.day, d.hour, d.minute]
`);
    expect(result).toEqual([2024, 1, 15, 10, 30]);
  });

  test('Date nested in records (the postgres timestamp case)', async () => {
    const interpreter = createInterpreter({
      tools: [{
        name: 'fetch_rows',
        handler: () => [
          { id: 1, created_at: new Date('2024-01-15T10:30:00Z') },
          { id: 2, created_at: new Date('2024-03-02T08:00:00Z') },
        ],
      }],
    });
    const result = await interpreter.run(`
rows = fetch_rows()
[r["created_at"].month for r in rows]
`);
    expect(result).toEqual([1, 3]);
  });

  test('marshalled Date respects the session timezone', async () => {
    const interpreter = createInterpreter({
      timezone: 'Europe/Berlin',
      tools: [{
        name: 'get_date',
        // Berlin is UTC+1 on this date
        handler: () => new Date('2024-01-15T10:30:00Z'),
      }],
    });
    const result = await interpreter.run('get_date().hour');
    expect(result).toBe(11);
  });

  test('marshalled Date defaults to UTC wall clock', async () => {
    const interpreter = createInterpreter({
      tools: [{
        name: 'get_date',
        handler: () => new Date('2024-06-15T23:45:00Z'),
      }],
    });
    const result = await interpreter.run('get_date().hour');
    expect(result).toBe(23);
  });

  test('Date milliseconds become microseconds', async () => {
    const interpreter = createInterpreter({
      tools: [{
        name: 'get_date',
        handler: () => new Date('2024-01-15T10:30:00.123Z'),
      }],
    });
    const result = await interpreter.run('get_date().microsecond');
    expect(result).toBe(123000);
  });

  test('marshalled Date supports datetime arithmetic and comparison', async () => {
    const interpreter = createInterpreter({
      tools: [{
        name: 'get_date',
        handler: () => new Date('2024-01-15T10:30:00Z'),
      }],
    });
    const result = await interpreter.run(`
from datetime import datetime
d = get_date()
[d > datetime(2024, 1, 1), (d - datetime(2024, 1, 15)).seconds]
`);
    expect(result).toEqual([true, 37800]);
  });

  test('marshalled Date round-trips out as an ISO string', async () => {
    const interpreter = createInterpreter({
      tools: [{
        name: 'get_date',
        handler: () => new Date('2024-01-15T10:30:00Z'),
      }],
    });
    const result = await interpreter.run('get_date()');
    expect(result).toBe('2024-01-15T10:30:00');
  });
});

describe('generateToolsPrompt language notes', () => {
  test('tell the model how to join two lists', () => {
    const notes = generateToolsPrompt([], { includeLanguageNotes: true });
    expect(notes).toContain('To join two lists, build a dict keyed on the join field');
    expect(generateToolsPrompt([])).not.toContain('To join two lists');
  });
});

describe('Tool handler errors (ToolError)', () => {
  const throwing = (): ToolDefinition[] => [{
    name: 'boom',
    handler: () => { throw new Error('db exploded'); },
  }];

  test('a JS handler throw surfaces as a catchable ToolError', async () => {
    const interpreter = createInterpreter({ tools: throwing() });
    const result = await interpreter.run(`
try:
    boom()
    result = "no error"
except ToolError as e:
    result = "caught: " + str(e)
result
`);
    expect(result).toBe("caught: Tool 'boom' failed: db exploded");
  });

  test('ToolError is catchable as RuntimeError', async () => {
    const interpreter = createInterpreter({ tools: throwing() });
    expect(await interpreter.run(`
try:
    boom()
except RuntimeError:
    result = "caught"
result
`)).toBe('caught');
  });

  test('ToolError is catchable as Exception', async () => {
    const interpreter = createInterpreter({ tools: throwing() });
    expect(await interpreter.run(`
try:
    boom()
except Exception:
    result = "caught"
result
`)).toBe('caught');
  });

  test('an uncaught ToolError rejects the run with the call-site position', async () => {
    const interpreter = createInterpreter({ tools: throwing() });
    await expect(interpreter.run('x = 1\nboom()')).rejects.toThrow("Line 2, Column 1: Tool 'boom' failed: db exploded");
  });

  test('async handler rejections are also ToolErrors', async () => {
    const interpreter = createInterpreter({
      tools: [{ name: 'boom', handler: async () => { throw new Error('late failure'); } }],
    });
    expect(await interpreter.run(`
try:
    boom()
except ToolError as e:
    result = e
result
`)).toBe("Tool 'boom' failed: late failure");
  });

  test('non-Error throws are stringified', async () => {
    const interpreter = createInterpreter({
      tools: [{ name: 'boom', handler: () => { throw 'plain string'; } }],
    });
    expect(await interpreter.run(`
try:
    boom()
except ToolError as e:
    result = e
result
`)).toBe("Tool 'boom' failed: plain string");
  });
});

describe('AbortSignal', () => {
  test('a loop stops at the next checkpoint after abort', async () => {
    const it = createInterpreter({ maxIterations: 1e9 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    await expect(it.run('i = 0\nwhile True:\n    i += 1', { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a pending tool call is abandoned on abort, and the reason is in the message', async () => {
    const it = createInterpreter({ tools: { forever: () => new Promise(() => {}) } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user left')), 10);
    await expect(it.run('forever()', { signal: ac.signal })).rejects.toThrow('Execution was cancelled: user left');
  });

  test('the script cannot catch it, and finally does not run', async () => {
    const it = createInterpreter({ maxIterations: 1e9 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(it.run('try:\n    while True:\n        pass\nexcept BaseException:\n    pass\nfinally:\n    x = 1\n"caught"', { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  test('an already-aborted signal rejects before running anything', async () => {
    const ran: string[] = [];
    const it = createInterpreter({ tools: { mark: () => { ran.push('x'); return null; } } });
    const ac = new AbortController();
    ac.abort();
    await expect(it.run('mark()', { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toEqual([]);
    expect(await it.run('1 + 1')).toBe(2);
  });

  test('a watched script that is never aborted runs to the right answer', async () => {
    const it = createInterpreter({ maxIterations: 1e8 });
    const src = 'total = 0\nfor i in range(300000):\n    for j in (1, 2):\n        total += i * j\nouter = 0\nwhile outer < 200000:\n    outer += 1\n(total, outer, [x for x in range(3)])';
    expect(await it.run(src, { signal: new AbortController().signal })).toEqual(await it.run(src));
  });

  test('runPython accepts a signal in its options', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runPython('1', undefined, { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(await runPython('2', undefined, { signal: new AbortController().signal })).toBe(2);
  });
});

describe('timeoutMs option', () => {
  test('a tight loop is stopped by the wall-clock deadline', async () => {
    const interpreter = createInterpreter({ timeoutMs: 100, maxIterations: 1e12 });
    const start = Date.now();
    await expect(interpreter.run('while True:\n    x = 1')).rejects.toThrow('Execution exceeded the 100ms time limit');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('time spent inside a tool handler counts against the deadline', async () => {
    const interpreter = createInterpreter({
      timeoutMs: 50,
      tools: [{ name: 'slow', handler: () => new Promise(r => setTimeout(r, 120)) }],
    });
    await expect(interpreter.run('slow()\nx = 1')).rejects.toThrow('time limit');
  });

  test('TimeoutError is not catchable from Python', async () => {
    const interpreter = createInterpreter({ timeoutMs: 100, maxIterations: 1e12 });
    await expect(interpreter.run(`
while True:
    try:
        x = 1
    except:
        pass
`)).rejects.toThrow('time limit');
  });

  test('fast scripts are unaffected', async () => {
    const interpreter = createInterpreter({ timeoutMs: 5000 });
    expect(await interpreter.run('sum([1, 2, 3])')).toBe(6);
  });
});

describe('Handler calling convention', () => {
  test('zero-arg call passes a single empty kwargs dict', async () => {
    let received: any[] = [];
    const interpreter = createInterpreter({
      tools: [{ name: 'f', handler: (...args: any[]) => { received = args; return null; } }],
    });
    await interpreter.run('f()');
    expect(received).toEqual([{}]);
  });

  test('positional args come first, kwargs dict last', async () => {
    let received: any[] = [];
    const interpreter = createInterpreter({
      tools: [{ name: 'f', handler: (...args: any[]) => { received = args; return null; } }],
    });
    await interpreter.run('f("a", 2, x=1, y="z")');
    expect(received).toEqual(['a', 2, { x: 1, y: 'z' }]);
  });
});

describe('Tools as an object of functions', () => {
  const calls: any[][] = [];
  const it = createInterpreter({
    tools: {
      fetch: (quarter: string, limit = 10) => ({ quarter, limit }),
      minified: (e: any, t: any) => [e, t],
      destructured: ({ quarter }: any) => quarter,
      rest: (...args: any[]) => { calls.push(args); return args.length; },
      noargs: () => 'ok',
      asyncFn: async (n: number) => n + 1,
    },
  });

  test('positional and keyword calls both reach the named parameters', async () => {
    expect(await it.run('fetch("Q1")')).toEqual({ quarter: 'Q1', limit: 10 });
    expect(await it.run('fetch(quarter="Q1")')).toEqual({ quarter: 'Q1', limit: 10 });
    expect(await it.run('fetch("Q1", limit=5)')).toEqual({ quarter: 'Q1', limit: 5 });
    expect(await it.run('fetch(limit=5, quarter="Q1")')).toEqual({ quarter: 'Q1', limit: 5 });
    expect(await it.run('asyncFn(n=1)')).toBe(2);
  });

  test('keywords that match no parameter fill the free slots in order (minified names)', async () => {
    expect(await it.run('minified(quarter="Q1", limit=5)')).toEqual(['Q1', 5]);
    expect(await it.run('minified("Q1", limit=5)')).toEqual(['Q1', 5]);
  });

  test('unreadable parameter lists fall back to a trailing keywords object', async () => {
    expect(await it.run('destructured(quarter="Q1")')).toBe('Q1');
    calls.length = 0;
    await it.run('rest(1, 2, k=3)');
    await it.run('rest()');
    expect(calls).toEqual([[1, 2, { k: 3 }], [{}]]);
  });

  test('keywords with nowhere to go arrive as one trailing object', async () => {
    const received: any[][] = [];
    const one = createInterpreter({ tools: { f: (a: any, ...more: any[]) => { received.push([a, ...more]); return null; } } });
    // `...more` makes the list unreadable, so this is the fallback form.
    await one.run('f(1, x=2)');
    const two = createInterpreter({ tools: { g: (a: any) => { received.push([a]); return null; } } });
    await two.run('g(1, x=2)');
    expect(received).toEqual([[1, { x: 2 }], [1]]);
  });

  test('a tool with no parameters ignores keywords', async () => {
    expect(await it.run('noargs()')).toBe('ok');
    expect(await it.run('noargs(k=1)')).toBe('ok');
  });

  test('runPython takes the same object', async () => {
    expect(await runPython('double(4)', { double: (n: number) => n * 2 })).toBe(8);
  });

  test('parameterNames reads the common function shapes', () => {
    function named(x: any, y = 2) { return x + y; }
    expect(parameterNames((a: any, b = Math.max(1, 2)) => a + b)).toEqual(['a', 'b']);
    expect(parameterNames(named)).toEqual(['x', 'y']);
    expect(parameterNames(async (a: any) => a)).toEqual(['a']);
    expect(parameterNames(() => 1)).toEqual([]);
    expect(parameterNames(({ a }: any) => a)).toBeNull();
    expect(parameterNames((...r: any[]) => r)).toBeNull();
    expect(parameterNames(([a]: any) => a)).toBeNull();
  });
});

describe('Tools with params', () => {
  const it = createInterpreter({
    tools: {
      spec: tool({
        description: 'A spec tool',
        params: { quarter: 'str', limit: 'int?', opts: { type: 'dict', description: 'options', default: { a: 1 } } },
        handler: ({ quarter, limit, opts }) => ({ quarter, limit: limit === undefined ? 'unset' : limit, opts }),
      }),
      inline: { params: { x: 'int' }, handler: ({ x }: { x: number }) => x * 2 },
      bare: { handler: () => 'no params' },
    },
  });

  test('the handler always receives one object, however the script called it', async () => {
    expect(await it.run('spec("Q1")')).toEqual({ quarter: 'Q1', limit: 'unset', opts: { a: 1 } });
    expect(await it.run('spec(quarter="Q1", limit=3)')).toEqual({ quarter: 'Q1', limit: 3, opts: { a: 1 } });
    expect(await it.run('spec("Q1", opts={"b": [1, {"c": 2}]})')).toEqual({ quarter: 'Q1', limit: 'unset', opts: { b: [1, { c: 2 }] } });
    expect(await it.run('inline(21)')).toBe(42);
    expect(await it.run('inline(x=21)')).toBe(42);
    expect(await it.run('bare()')).toBe('no params');
  });

  test('calls the spec cannot accept raise a catchable Python TypeError', async () => {
    await expect(it.run('spec()')).rejects.toThrow("spec() missing 1 required argument: 'quarter'");
    await expect(it.run('spec("Q1", 1, {}, 4)')).rejects.toThrow('spec() takes 3 positional arguments but 4 were given');
    await expect(it.run('spec("Q1", bogus=1)')).rejects.toThrow("spec() got an unexpected keyword argument 'bogus'");
    await expect(it.run('spec("Q1", quarter="Q2")')).rejects.toThrow("spec() got multiple values for argument 'quarter'");
    expect(await it.run('try:\n    inline()\nexcept TypeError as e:\n    str(e)')).toBe("inline() missing 1 required argument: 'x'");
  });

  test('a default is a JS value and is applied when the argument is missing', async () => {
    const d = createInterpreter({ tools: { f: { params: { when: { default: new Date(0) } }, handler: ({ when }: any) => when instanceof Date } } });
    expect(await d.run('f()')).toBe(true);
  });

  test('the prompt shows types, defaults and descriptions', () => {
    const prompt = generateToolsPrompt({
      fetch: (quarter: string, limit = 10) => 1,
      spec: tool({ description: 'A spec tool', group: 'Data', params: { quarter: 'str', limit: 'int?', opts: { type: 'dict', description: 'options', default: { a: 1 } }, when: { default: 'now' } }, handler: () => 1 }),
    });
    expect(prompt).toContain('- fetch(quarter, limit) - No description');
    expect(prompt).toContain("## Data\n- spec(quarter: str, limit: int = None, opts: dict = {'a': 1}, when = 'now') - A spec tool\n    opts: options");
  });

  test('a tool entry must be a function or have a handler', () => {
    expect(() => createInterpreter({ tools: { bad: { params: {} } as any } })).toThrow("Tool 'bad' must be a function or an object with a handler function");
  });
});

describe('Tools with schemas', () => {
  const report = z.object({ title: z.string(), rows: z.array(z.number()).default([]) });
  const it = createInterpreter({
    tools: {
      save: tool({
        params: { report, format: { type: 'str', schema: z.enum(['pdf', 'html']), default: 'pdf' }, when: 'str?' },
        handler: ({ report, format, when }) => ({ title: report.title.toUpperCase(), rows: report.rows, format, when }),
      }),
      slow: { params: { n: { schema: { '~standard': { version: 1, vendor: 'test', validate: async (v: unknown) => (typeof v === 'number' ? { value: v * 2 } : { issues: [{ message: 'not a number' }] }) } } } }, handler: ({ n }: any) => n },
    },
  });

  test('valid values pass through, transformed by the schema', async () => {
    expect(await it.run('save({"title": "q1"})')).toEqual({ title: 'Q1', rows: [], format: 'pdf', when: null });
    expect(await it.run('save({"title": "q1", "rows": [1, 2]}, format="html")')).toEqual({ title: 'Q1', rows: [1, 2], format: 'html', when: null });
    expect(await it.run('slow(21)')).toBe(42);
  });

  test('invalid values raise a catchable TypeError naming the argument and the path', async () => {
    await expect(it.run('save({"rows": "x"})')).rejects.toThrow("save() argument 'report' is invalid: title: ");
    await expect(it.run('save({"title": "a"}, format="docx")')).rejects.toThrow("save() argument 'format' is invalid: ");
    expect(await it.run('try:\n    slow("x")\nexcept TypeError as e:\n    str(e)')).toBe("slow() argument 'n' is invalid: not a number");
  });

  test('a schema is not run for an argument that was not given', async () => {
    const d = createInterpreter({ tools: { f: { params: { x: { schema: z.string() } }, handler: () => 'never' }, g: { params: { x: { schema: z.string(), default: 5 } }, handler: ({ x }: any) => x } } });
    await expect(d.run('f()')).rejects.toThrow("f() missing 1 required argument: 'x'");
    expect(await d.run('g()')).toBe(5);
  });
});

describe('generateToolsPrompt', () => {
  test('renders parameter signatures', () => {
    const prompt = generateToolsPrompt([{
      name: 'get_sales',
      description: 'Fetch sales rows',
      handler: () => [],
      parameters: [
        { name: 'region', type: 'str', description: 'Sales region code' },
        { name: 'month', type: 'int' },
        { name: 'currency', type: 'str', default: '"USD"' },
      ],
    }]);
    expect(prompt).toContain('get_sales(region: str, month: int, currency: str = "USD") - Fetch sales rows');
    expect(prompt).toContain('region: Sales region code');
  });

  test('tools without parameters render as name()', () => {
    const prompt = generateToolsPrompt([{ name: 'ping', description: 'Ping', handler: () => 1 }]);
    expect(prompt).toContain('- ping() - Ping');
  });

  test('groups render as sections in first-seen order', () => {
    const prompt = generateToolsPrompt([
      { name: 'a', description: 'A', handler: () => 1, group: 'Data' },
      { name: 'b', description: 'B', handler: () => 1, group: 'Output' },
      { name: 'c', description: 'C', handler: () => 1, group: 'Data' },
    ]);
    expect(prompt).toContain('## Data');
    expect(prompt).toContain('## Output');
    expect(prompt.indexOf('## Data')).toBeLessThan(prompt.indexOf('## Output'));
    expect(prompt.indexOf('- c() - C')).toBeLessThan(prompt.indexOf('## Output'));
  });

  test('language notes are opt-in', () => {
    const without = generateToolsPrompt([{ name: 'f', handler: () => 1 }]);
    const withNotes = generateToolsPrompt([{ name: 'f', handler: () => 1 }], { includeLanguageNotes: true });
    expect(without).not.toContain('Language notes:');
    expect(withNotes).toContain('Language notes:');
    expect(withNotes).toContain('datetime, math, statistics, re');
  });
});
