# Python Interpreter for AI-Generated Scripts

A sandboxed Python interpreter written in TypeScript, designed for executing AI-generated code safely. The interpreter supports tool injection, allowing you to provide data-fetching functions that the AI can call.

## Quick Start

```typescript
import { runPython } from "./src";

const result = await runPython(`
transactions = fetch_transactions("2024-01")
total = sum([t['amount'] for t in transactions])
f"Total: {total}"
`, [
  {
    name: "fetch_transactions",
    description: "Fetch transactions for a given month",
    handler: async (month: string) => {
      return await db.transactions.findMany({ where: { month } });
    }
  }
]);

console.log(result); // "Total: 1234"
```

## Architecture

```
Source Code (string)
        │
        ▼
┌───────────────┐
│    Lexer      │  → Tokens (NUMBER, STRING, IDENTIFIER, INDENT, etc.)
└───────────────┘
        │
        ▼
┌───────────────┐
│    Parser     │  → AST (Abstract Syntax Tree)
└───────────────┘
        │
        ▼
┌───────────────┐
│  Interpreter  │  → Result (TypeScript native value)
└───────────────┘
```

## Supported Python Features

### Data Types
- **Numbers**: `42`, `3.14`, `1e10`
- **Strings**: `"hello"`, `'world'`, `"""multiline"""`
- **F-strings**: `f"Hello {name}"`, `f"Sum: {a + b}"`
- **Booleans**: `True`, `False`
- **None**: `None`
- **Lists**: `[1, 2, 3]`
- **Dicts**: `{"key": "value"}`
- **Tuples**: `(1, 2, 3)`

### Operators
- **Arithmetic**: `+`, `-`, `*`, `/`, `//` (floor div), `%`, `**` (power)
- **Comparison**: `==`, `!=`, `<`, `>`, `<=`, `>=`
- **Boolean**: `and`, `or`, `not`
- **Membership**: `in`, `not in`
- **Augmented assignment**: `+=`, `-=`, `*=`, `/=`

### Control Flow
- `if` / `elif` / `else`
- `for ... in ...`
- `while`
- `break`, `continue`, `pass`

### Functions
- Function definitions: `def foo(a, b=10):`
- Return statements: `return value`
- Closures supported
- Recursion supported

### Comprehensions
- List: `[x * 2 for x in items if x > 0]`
- Dict: `{k: v for k, v in items}`

### Other
- Ternary expressions: `a if condition else b`
- Chained comparisons: `0 < x < 10`
- String/list slicing: `s[1:5]`, `items[::-1]`
- Method calls: `s.upper()`, `items.append(x)`

## Built-in Functions

| Function | Description |
|----------|-------------|
| `len(x)` | Length of string, list, dict, tuple |
| `sum(iterable)` | Sum of numbers |
| `range(start, stop, step)` | Generate number sequence |
| `min(...)`, `max(...)` | Minimum/maximum value |
| `abs(x)` | Absolute value |
| `round(x, digits)` | Round number |
| `sorted(iterable)` | Return sorted list |
| `reversed(iterable)` | Return reversed iterator |
| `enumerate(iterable)` | Return (index, value) pairs |
| `zip(a, b, ...)` | Zip iterables together |
| `list(x)`, `dict(x)`, `str(x)` | Type conversions |
| `int(x)`, `float(x)`, `bool(x)` | Type conversions |
| `any(iterable)`, `all(iterable)` | Boolean aggregation |
| `print(...)` | Print output (captured via callback) |

## String Methods

`upper()`, `lower()`, `strip()`, `split()`, `join()`, `replace()`, `startswith()`, `endswith()`, `find()`, `count()`, `isdigit()`, `isalpha()`, `format()`

## List Methods

`append()`, `extend()`, `insert()`, `remove()`, `pop()`, `clear()`, `index()`, `count()`, `sort()`, `reverse()`, `copy()`

## Dict Methods

`keys()`, `values()`, `items()`, `get()`, `pop()`, `update()`, `clear()`, `copy()`, `setdefault()`

---

## NOT Supported (By Design - Security)

These features are intentionally omitted to ensure the interpreter is sandboxed:

| Feature | Why Not Supported |
|---------|-------------------|
| `import` / `from ... import` | No module system - prevents access to `os`, `sys`, etc. |
| `open()`, file I/O | No filesystem access |
| `exec()`, `eval()` | No dynamic code execution |
| `__import__`, `globals()`, `locals()` | No introspection |
| `class` definitions | Not needed for data processing |
| `try` / `except` | Keep it simple |
| `async` / `await` | Not needed |
| `yield` / generators | Not needed |
| `*args`, `**kwargs` | Not implemented |
| Tuple unpacking: `a, b = (1, 2)` | Not implemented |
| Walrus operator: `:=` | Not implemented |
| `lambda` with multiple statements | Only expression lambdas |

---

## Tool Injection

Tools are functions you provide that the Python code can call. This is how you expose your data to the AI-generated scripts.

### Defining Tools

```typescript
import { createInterpreter, ToolDefinition } from "./src";

const tools: ToolDefinition[] = [
  {
    name: "fetch_transactions",
    description: "Fetch bank transactions for a date range",
    handler: async (startMonth: string, endMonth: string) => {
      // Your actual implementation
      return await db.transactions.findMany({
        where: { date: { gte: startMonth, lte: endMonth } }
      });
    }
  },
  {
    name: "get_customer",
    description: "Get customer by ID", 
    handler: (customerId: number) => {
      return db.customers.findById(customerId);
    }
  }
];

const interpreter = createInterpreter({ tools });
const result = await interpreter.run(pythonCode);
```

### Tool Parameters

Parameters are passed positionally from Python to your handler:

```python
# Python code
result = fetch_transactions("2024-01", "2024-03")
```

```typescript
// Handler receives
handler: (startMonth, endMonth) => { ... }
// startMonth = "2024-01", endMonth = "2024-03"
```

### Async Handlers

Handlers can be async - the interpreter will await them:

```typescript
handler: async (id: number) => {
  const data = await fetch(`/api/data/${id}`);
  return await data.json();
}
```

---

## Security Considerations

### What's Safe ✅

- **No filesystem access** - `open()` doesn't exist
- **No network access** - No `requests`, `urllib`, `fetch`
- **No code injection** - No `exec()`, `eval()`, `__import__`
- **No system access** - No `os`, `sys`, `subprocess`
- **Iteration limits** - Prevents infinite loops (default: 100,000)

### Potential Risks ⚠️

1. **Memory exhaustion** - Large lists/strings not limited
   ```python
   x = [0] * 100000000  # Could use lots of memory
   ```

2. **Tool handler abuse** - Your handlers receive user-controlled input
   ```typescript
   // DANGEROUS - SQL injection possible!
   handler: (query) => db.rawQuery(query)
   
   // SAFE - parameterized query
   handler: (id) => db.query("SELECT * FROM users WHERE id = ?", [id])
   ```

3. **CPU exhaustion** - Complex operations within iteration limit
   ```python
   x = "a" * 10000000  # 10MB string - slow but allowed
   ```

### Recommendations

1. **Lower iteration limit for untrusted input:**
   ```typescript
   createInterpreter({ maxIterations: 10_000 })
   ```

2. **Validate tool parameters:**
   ```typescript
   handler: (month: string) => {
     if (!/^\d{4}-\d{2}$/.test(month)) {
       throw new Error("Invalid month format");
     }
     return db.query(...);
   }
   ```

3. **Never pass user input directly to:**
   - SQL queries (use parameterized queries)
   - Shell commands
   - File paths
   - eval/Function constructors

---

## API Reference

### `runPython(code, tools?, onPrint?)`

Quick execution function.

```typescript
const result = await runPython(
  'sum([1, 2, 3])',           // Python code
  [],                          // Tools (optional)
  (msg) => console.log(msg)    // Print callback (optional)
);
```

### `createInterpreter(options)`

Create a reusable interpreter instance.

```typescript
const interpreter = createInterpreter({
  tools: [...],              // Tool definitions
  onPrint: (msg) => { },     // Print callback
  maxIterations: 100_000,    // Loop iteration limit
});

const result = await interpreter.run(code);
```

### `generateToolsPrompt(tools)`

Generate a system prompt for Claude describing available tools.

```typescript
const prompt = generateToolsPrompt(tools);
// Returns:
// "You have access to the following tools through Python code:
//  - fetch_transactions() - Fetch bank transactions
//  - get_customer() - Get customer by ID
//  ..."
```

---

## File Structure

```
parser/
├── src/
│   ├── index.ts        # Main entry point, exports
│   ├── tokens.ts       # Token type definitions
│   ├── lexer.ts        # Tokenizer (source → tokens)
│   ├── ast.ts          # AST node type definitions
│   ├── parser.ts       # Parser (tokens → AST)
│   ├── values.ts       # Runtime value types
│   ├── builtins.ts     # Built-in functions
│   ├── interpreter.ts  # Evaluator (AST → result)
│   └── errors.ts       # Error types
└── tests/
    ├── lexer.test.ts
    ├── parser.test.ts
    ├── interpreter.test.ts
    └── tools.test.ts
```

## Running Tests

```bash
bun test parser/tests
```

---

## Example: Financial Data Analysis

```typescript
import { createInterpreter } from "./src";

const interpreter = createInterpreter({
  tools: [
    {
      name: "list_transactions",
      handler: () => mockTransactions,
    },
    {
      name: "list_invoices", 
      handler: () => mockInvoices,
    }
  ]
});

const result = await interpreter.run(`
transactions = list_transactions()
invoices = list_invoices()

# Group transactions by month
monthly = {}
for t in transactions:
    month = t['date'][:7]
    if month not in monthly:
        monthly[month] = 0
    monthly[month] += t['amount']

# Calculate totals
total_transactions = sum([t['amount'] for t in transactions])
total_invoiced = sum([i['amount'] for i in invoices])

{
    'monthly_breakdown': monthly,
    'total_transactions': total_transactions,
    'total_invoiced': total_invoiced,
    'difference': total_transactions - total_invoiced
}
`);

console.log(result);
// {
//   monthly_breakdown: { '2024-01': 500, '2024-02': 750 },
//   total_transactions: 1250,
//   total_invoiced: 1100,
//   difference: 150
// }
```

---

## Common Gotchas

1. **Leading whitespace in template literals** - The interpreter auto-trims, but be aware:
   ```typescript
   // This works (auto-trimmed)
   runPython(`
   x = 1
   `)
   ```

2. **Tool names with `()`** - Automatically stripped:
   ```typescript
   // Both work the same
   { name: "my_func" }
   { name: "my_func()" }  // () is stripped
   ```

3. **F-strings require expressions** - Empty `{}` is invalid:
   ```python
   f"Hello {}"  # Error
   f"Hello {name}"  # OK
   ```

4. **No tuple unpacking**:
   ```python
   # NOT supported
   a, b = (1, 2)
   
   # Use instead
   t = (1, 2)
   a = t[0]
   b = t[1]
   ```

