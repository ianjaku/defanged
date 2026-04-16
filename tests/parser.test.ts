import { describe, test, expect } from 'bun:test';
import { parse } from '../src';

describe('Parser', () => {
  describe('Literals', () => {
    test('number', () => {
      const ast = parse('42');
      expect(ast[0].type).toBe('ExpressionStmt');
      expect((ast[0] as any).expression.type).toBe('Number');
      expect((ast[0] as any).expression.value).toBe(42);
    });

    test('string', () => {
      const ast = parse('"hello"');
      expect((ast[0] as any).expression.type).toBe('String');
      expect((ast[0] as any).expression.value).toBe('hello');
    });

    test('boolean True', () => {
      const ast = parse('True');
      expect((ast[0] as any).expression.type).toBe('Boolean');
      expect((ast[0] as any).expression.value).toBe(true);
    });

    test('boolean False', () => {
      const ast = parse('False');
      expect((ast[0] as any).expression.type).toBe('Boolean');
      expect((ast[0] as any).expression.value).toBe(false);
    });

    test('None', () => {
      const ast = parse('None');
      expect((ast[0] as any).expression.type).toBe('None');
    });

    test('identifier', () => {
      const ast = parse('foo');
      expect((ast[0] as any).expression.type).toBe('Identifier');
      expect((ast[0] as any).expression.name).toBe('foo');
    });
  });

  describe('Binary Operations', () => {
    test('addition', () => {
      const ast = parse('1 + 2');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('BinaryOp');
      expect(expr.op).toBe('+');
      expect(expr.left.value).toBe(1);
      expect(expr.right.value).toBe(2);
    });

    test('precedence: multiplication before addition', () => {
      const ast = parse('1 + 2 * 3');
      const expr = (ast[0] as any).expression;
      expect(expr.op).toBe('+');
      expect(expr.left.value).toBe(1);
      expect(expr.right.op).toBe('*');
      expect(expr.right.left.value).toBe(2);
      expect(expr.right.right.value).toBe(3);
    });

    test('power operator (right associative)', () => {
      const ast = parse('2 ** 3 ** 2');
      const expr = (ast[0] as any).expression;
      expect(expr.op).toBe('**');
      expect(expr.left.value).toBe(2);
      expect(expr.right.op).toBe('**');
    });

    test('floor division', () => {
      const ast = parse('10 // 3');
      const expr = (ast[0] as any).expression;
      expect(expr.op).toBe('//');
    });

    test('modulo', () => {
      const ast = parse('10 % 3');
      const expr = (ast[0] as any).expression;
      expect(expr.op).toBe('%');
    });
  });

  describe('Unary Operations', () => {
    test('negative', () => {
      const ast = parse('-5');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('UnaryOp');
      expect(expr.op).toBe('-');
      expect(expr.operand.value).toBe(5);
    });

    test('not', () => {
      const ast = parse('not True');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('UnaryOp');
      expect(expr.op).toBe('not');
    });
  });

  describe('Boolean Operations', () => {
    test('and', () => {
      const ast = parse('True and False');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('BooleanOp');
      expect(expr.op).toBe('and');
    });

    test('or', () => {
      const ast = parse('True or False');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('BooleanOp');
      expect(expr.op).toBe('or');
    });

    test('precedence: and before or', () => {
      const ast = parse('a or b and c');
      const expr = (ast[0] as any).expression;
      expect(expr.op).toBe('or');
      expect(expr.right.op).toBe('and');
    });
  });

  describe('Comparisons', () => {
    test('equality', () => {
      const ast = parse('x == y');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Compare');
      expect(expr.ops[0]).toBe('==');
    });

    test('chained comparison', () => {
      const ast = parse('0 < x < 10');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Compare');
      expect(expr.ops).toEqual(['<', '<']);
      expect(expr.comparators.length).toBe(2);
    });

    test('in operator', () => {
      const ast = parse('x in items');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Compare');
      expect(expr.ops[0]).toBe('in');
    });

    test('not in operator', () => {
      const ast = parse('x not in items');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Compare');
      expect(expr.ops[0]).toBe('not in');
    });
  });

  describe('Function Calls', () => {
    test('no arguments', () => {
      const ast = parse('foo()');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Call');
      expect(expr.func.name).toBe('foo');
      expect(expr.args.length).toBe(0);
    });

    test('with arguments', () => {
      const ast = parse('foo(1, 2, 3)');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Call');
      expect(expr.args.length).toBe(3);
    });

    test('keyword arguments', () => {
      const ast = parse('foo(a=1, b=2)');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Call');
      expect(expr.kwargs.length).toBe(2);
      expect(expr.kwargs[0].name).toBe('a');
    });

    test('method call', () => {
      const ast = parse('obj.method()');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Call');
      expect(expr.func.type).toBe('Attribute');
      expect(expr.func.attr).toBe('method');
    });

    test('generator expression in call arguments', () => {
      const ast = parse(`"".join(c for c in amount if c.isdigit())`);
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Call');
      expect(expr.args.length).toBe(1);
      expect(expr.args[0].type).toBe('GeneratorExp');
      expect(expr.args[0].element.type).toBe('Identifier');
      expect(expr.args[0].element.name).toBe('c');
      expect(expr.args[0].generators.length).toBe(1);
    });
  });

  describe('Subscript and Slice', () => {
    test('subscript', () => {
      const ast = parse('items[0]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Subscript');
      expect(expr.index.value).toBe(0);
    });

    test('slice with bounds', () => {
      const ast = parse('items[1:5]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Slice');
      expect(expr.lower.value).toBe(1);
      expect(expr.upper.value).toBe(5);
    });

    test('slice with step', () => {
      const ast = parse('items[::2]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Slice');
      expect(expr.lower).toBeNull();
      expect(expr.upper).toBeNull();
      expect(expr.step.value).toBe(2);
    });

    test('slice from start', () => {
      const ast = parse('items[:5]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Slice');
      expect(expr.lower).toBeNull();
      expect(expr.upper.value).toBe(5);
    });
  });

  describe('Collections', () => {
    test('empty list', () => {
      const ast = parse('[]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('List');
      expect(expr.elements.length).toBe(0);
    });

    test('list with elements', () => {
      const ast = parse('[1, 2, 3]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('List');
      expect(expr.elements.length).toBe(3);
    });

    test('empty dict', () => {
      const ast = parse('{}');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Dict');
      expect(expr.keys.length).toBe(0);
    });

    test('dict with entries', () => {
      const ast = parse("{'a': 1, 'b': 2}");
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Dict');
      expect(expr.keys.length).toBe(2);
    });

    test('tuple', () => {
      const ast = parse('(1, 2, 3)');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Tuple');
      expect(expr.elements.length).toBe(3);
    });
  });

  describe('Comprehensions', () => {
    test('list comprehension', () => {
      const ast = parse('[x * 2 for x in items]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('ListComp');
      expect(expr.generators.length).toBe(1);
    });

    test('list comprehension with condition', () => {
      const ast = parse('[x for x in items if x > 0]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('ListComp');
      expect(expr.generators[0].conditions.length).toBe(1);
    });

    test('dict comprehension', () => {
      // Simple dict comprehension without tuple unpacking
      const ast = parse('{x: x * 2 for x in items}');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('DictComp');
    });

    test('list comprehension with tuple target', () => {
      const ast = parse('[v for k, v in items]');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('ListComp');
      expect(expr.generators.length).toBe(1);
      expect(expr.generators[0].target.type).toBe('Tuple');
      expect(expr.generators[0].target.elements.map((e: any) => e.name)).toEqual(['k', 'v']);
    });

    test('dict comprehension with tuple target', () => {
      const ast = parse('{k: v for k, v in items}');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('DictComp');
      expect(expr.generators.length).toBe(1);
      expect(expr.generators[0].target.type).toBe('Tuple');
      expect(expr.generators[0].target.elements.map((e: any) => e.name)).toEqual(['k', 'v']);
    });
  });

  describe('Ternary Expression', () => {
    test('simple ternary', () => {
      const ast = parse('a if condition else b');
      const expr = (ast[0] as any).expression;
      expect(expr.type).toBe('Ternary');
      expect(expr.consequent.name).toBe('a');
      expect(expr.alternate.name).toBe('b');
    });
  });

  describe('Statements', () => {
    test('assignment', () => {
      const ast = parse('x = 42');
      expect(ast[0].type).toBe('Assignment');
      expect((ast[0] as any).target.name).toBe('x');
      expect((ast[0] as any).value.value).toBe(42);
    });

    test('augmented assignment', () => {
      const ast = parse('x += 1');
      expect(ast[0].type).toBe('AugmentedAssignment');
      expect((ast[0] as any).op).toBe('+=');
    });

    test('if statement', () => {
      const ast = parse(`if x:
    y = 1`);
      expect(ast[0].type).toBe('If');
      expect((ast[0] as any).body.length).toBe(1);
    });

    test('if-else statement', () => {
      const ast = parse(`if x:
    y = 1
else:
    y = 2`);
      expect(ast[0].type).toBe('If');
      expect((ast[0] as any).orelse.length).toBe(1);
    });

    test('if-elif-else statement', () => {
      const ast = parse(`if x:
    a = 1
elif y:
    a = 2
else:
    a = 3`);
      expect(ast[0].type).toBe('If');
      expect((ast[0] as any).orelse[0].type).toBe('If');
    });

    test('for loop', () => {
      const ast = parse(`for i in items:
    print(i)`);
      expect(ast[0].type).toBe('For');
      expect((ast[0] as any).target.name).toBe('i');
      expect((ast[0] as any).iter.name).toBe('items');
    });

    test('while loop', () => {
      const ast = parse(`while x > 0:
    x -= 1`);
      expect(ast[0].type).toBe('While');
    });

    test('function definition', () => {
      const ast = parse(`def foo(a, b):
    return a + b`);
      expect(ast[0].type).toBe('FunctionDef');
      expect((ast[0] as any).name).toBe('foo');
      expect((ast[0] as any).params.length).toBe(2);
    });

    test('function with default parameter', () => {
      const ast = parse(`def foo(a, b=10):
    return a + b`);
      expect((ast[0] as any).params[1].default.value).toBe(10);
    });

    test('return statement', () => {
      const ast = parse(`def foo():
    return 42`);
      expect((ast[0] as any).body[0].type).toBe('Return');
    });

    test('break statement', () => {
      const ast = parse(`while True:
    break`);
      expect((ast[0] as any).body[0].type).toBe('Break');
    });

    test('continue statement', () => {
      const ast = parse(`while True:
    continue`);
      expect((ast[0] as any).body[0].type).toBe('Continue');
    });

    test('pass statement', () => {
      const ast = parse(`def foo():
    pass`);
      expect((ast[0] as any).body[0].type).toBe('Pass');
    });

    test('try/except with tuple exception types', () => {
      const ast = parse(`try:
    x = 1 / 0
except (ZeroDivisionError, TypeError):
    x = 0`);
      expect(ast[0].type).toBe('Try');
      const handler = (ast[0] as any).handlers[0];
      expect(handler.type).toBe('ExceptHandler');
      expect(handler.exceptionTypes).toEqual(['ZeroDivisionError', 'TypeError']);
    });

    test('try/except with tuple exception types (trailing comma)', () => {
      const ast = parse(`try:
    x = 1 / 0
except (ZeroDivisionError, TypeError,):
    x = 0`);
      const handler = (ast[0] as any).handlers[0];
      expect(handler.exceptionTypes).toEqual(['ZeroDivisionError', 'TypeError']);
    });
  });

  describe('Complex Programs', () => {
    test('nested loops', () => {
      const ast = parse(`for i in range(3):
    for j in range(3):
        print(i, j)`);
      expect(ast[0].type).toBe('For');
      expect((ast[0] as any).body[0].type).toBe('For');
    });

    test('function with loop', () => {
      const ast = parse(`def sum_list(items):
    total = 0
    for item in items:
        total += item
    return total`);
      expect(ast[0].type).toBe('FunctionDef');
      expect((ast[0] as any).body.length).toBe(3);
    });

    test('multiple statements', () => {
      const ast = parse(`x = 1
y = 2
z = x + y`);
      expect(ast.length).toBe(3);
    });
  });

  describe('Multi-line Expressions', () => {
    test('multi-line if condition in parentheses', () => {
      const ast = parse(`for x in items:
    if (a and
        b and
        c):
        y = 1`);
      expect(ast[0].type).toBe('For');
      const forBody = (ast[0] as any).body;
      expect(forBody[0].type).toBe('If');
      // The if body should have one statement
      expect(forBody[0].body.length).toBe(1);
    });

    test('multi-line if with slice and comparison', () => {
      const ast = parse(`for deal in deals:
    if (deal["closeDate"] and
        deal["closeDate"][:4] == "2025"):
        x = 1`);
      expect(ast[0].type).toBe('For');
      const forBody = (ast[0] as any).body;
      expect(forBody[0].type).toBe('If');
      expect(forBody[0].body.length).toBe(1);
    });

    test('complex multi-line condition with nested subscripts', () => {
      const ast = parse(`for deal in deals:
    if (deal["dealOwner"] == "Test" and
        deal["isClosedWon"] and
        deal["closeDate"] and
        deal["closeDate"][:4] == "2025"):

        customer = deal["company"]`);
      expect(ast[0].type).toBe('For');
      const forBody = (ast[0] as any).body;
      expect(forBody[0].type).toBe('If');
      // Verify the if condition is a BooleanOp with 'and'
      expect(forBody[0].test.type).toBe('BooleanOp');
      expect(forBody[0].test.op).toBe('and');
    });

    test('multi-line function call arguments', () => {
      const ast = parse(`result = func(
    arg1,
    arg2,
    arg3
)`);
      expect(ast[0].type).toBe('Assignment');
      const call = (ast[0] as any).value;
      expect(call.type).toBe('Call');
      expect(call.args.length).toBe(3);
    });

    test('multi-line list literal', () => {
      const ast = parse(`items = [
    1,
    2,
    3
]`);
      expect(ast[0].type).toBe('Assignment');
      const list = (ast[0] as any).value;
      expect(list.type).toBe('List');
      expect(list.elements.length).toBe(3);
    });
  });
});
