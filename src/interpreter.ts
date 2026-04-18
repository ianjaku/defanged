/**
 * Tree-walking interpreter for Python AST
 */

import {
  Program,
  Statement,
  Expression,
  Comprehension,
} from './ast';
import {
  PyValue,
  PyBuiltin,
  PyKwargs,
  Environment,
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
  isBoolean,
  isNone,
  isList,
  isDict,
  isSet,
  isTuple,
  isCallable,
  isIterable,
  isTruthy,
  pyEquals,
  pyStr,
  jsToValue,
  valueToJs,
} from './values';
import { createBuiltins, PrintCallback } from './builtins';
import { getStringMethod, getListMethod, getDictMethod, getSetMethod, getHashableItems } from './methods';
import {
  InterpreterError,
  NameError,
  TypeError,
  IndexError,
  KeyError,
  ValueError,
  ZeroDivisionError,
  MaxIterationsError,
} from './errors';
import { parse } from './parser';

// Control flow exceptions
class ReturnException {
  constructor(public value: PyValue) {}
}

class BreakException {}
class ContinueException {}

export interface ToolDefinition {
  name: string;
  description?: string;
  handler: (...args: any[]) => any | Promise<any>;
}

export interface InterpreterOptions {
  tools?: ToolDefinition[];
  onPrint?: PrintCallback;
  onChart?: (options: { type: string; data: unknown[]; x: string; y: string | string[]; title?: string }) => void;
  onTable?: (options: { data: unknown[]; columns: Array<{ key: string; label: string; format?: string }>; title?: string }) => void;
  maxIterations?: number;
}

export class Interpreter {
  private globals: Environment;
  private tools: Map<string, ToolDefinition>;
  private builtins: Map<string, PyBuiltin>;
  private maxIterations: number;
  private iterationCount: number = 0;
  private onPrint?: PrintCallback;

  constructor(options: InterpreterOptions = {}) {
    this.globals = new Environment();
    this.tools = new Map();
    this.maxIterations = options.maxIterations ?? 5_000_000;
    this.onPrint = options.onPrint;
    this.builtins = createBuiltins({
      onPrint: options.onPrint,
      onChart: options.onChart,
      onTable: options.onTable,
    });

    // Register tools
    if (options.tools) {
      for (const tool of options.tools) {
        // Strip trailing () from tool name if present (common mistake)
        const name = tool.name.replace(/\(\)$/, '');
        this.tools.set(name, { ...tool, name });
      }
    }
  }

  async run(source: string): Promise<any> {
    this.iterationCount = 0;
    const program = parse(source.trim());
    const result = await this.executeProgram(program, this.globals);
    return valueToJs(result);
  }

  private async executeProgram(program: Program, env: Environment): Promise<PyValue> {
    let result: PyValue = pyNone();

    for (const stmt of program) {
      result = await this.executeStatement(stmt, env);
    }

    // Return the last expression's value
    return result;
  }

  private async executeStatement(stmt: Statement, env: Environment): Promise<PyValue> {
    switch (stmt.type) {
      case 'ExpressionStmt':
        return await this.evaluate(stmt.expression, env);

      case 'Assignment': {
        const value = await this.evaluate(stmt.value, env);
        for (const target of stmt.targets) {
          await this.assignTarget(target, value, env);
        }
        return pyNone();
      }

      case 'AugmentedAssignment': {
        const current = await this.evaluate(stmt.target, env);
        const operand = await this.evaluate(stmt.value, env);
        let result: PyValue;

        switch (stmt.op) {
          case '+=':
            result = this.binaryOp('+', current, operand, stmt.line, stmt.column);
            break;
          case '-=':
            result = this.binaryOp('-', current, operand, stmt.line, stmt.column);
            break;
          case '*=':
            result = this.binaryOp('*', current, operand, stmt.line, stmt.column);
            break;
          case '/=':
            result = this.binaryOp('/', current, operand, stmt.line, stmt.column);
            break;
          case '//=':
            result = this.binaryOp('//', current, operand, stmt.line, stmt.column);
            break;
          case '%=':
            result = this.binaryOp('%', current, operand, stmt.line, stmt.column);
            break;
          case '**=':
            result = this.binaryOp('**', current, operand, stmt.line, stmt.column);
            break;
          default:
            throw new InterpreterError(`Unknown augmented assignment operator: ${stmt.op}`, stmt.line, stmt.column);
        }

        await this.assignTarget(stmt.target, result, env);
        return pyNone();
      }

      case 'If': {
        const test = await this.evaluate(stmt.test, env);
        if (isTruthy(test)) {
          return await this.executeBlock(stmt.body, env);
        } else if (stmt.orelse.length > 0) {
          return await this.executeBlock(stmt.orelse, env);
        }
        return pyNone();
      }

      case 'For': {
        const iter = await this.evaluate(stmt.iter, env);
        const items = this.getIterableItems(iter, stmt.line, stmt.column);

        let result: PyValue = pyNone();
        for (const item of items) {
          this.checkIterations(stmt.line, stmt.column);
          await this.assignTarget(stmt.target, item, env);
          try {
            result = await this.executeBlock(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakException) break;
            if (e instanceof ContinueException) continue;
            throw e;
          }
        }
        return result;
      }

      case 'While': {
        let result: PyValue = pyNone();
        while (isTruthy(await this.evaluate(stmt.test, env))) {
          this.checkIterations(stmt.line, stmt.column);
          try {
            result = await this.executeBlock(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakException) break;
            if (e instanceof ContinueException) continue;
            throw e;
          }
        }
        return result;
      }

      case 'FunctionDef': {
        const func: PyValue = {
          type: 'function',
          name: stmt.name,
          params: stmt.params,
          body: stmt.body,
          closure: env,
        };
        env.set(stmt.name, func);
        return pyNone();
      }

      case 'Return': {
        const value = stmt.value ? await this.evaluate(stmt.value, env) : pyNone();
        throw new ReturnException(value);
      }

      case 'Break':
        throw new BreakException();

      case 'Continue':
        throw new ContinueException();

      case 'Pass':
        return pyNone();

      case 'Try': {
        let result: PyValue = pyNone();
        let caughtError: Error | null = null;
        
        // Execute try block
        try {
          result = await this.executeBlock(stmt.body, env);
        } catch (e) {
          // Don't catch control flow exceptions
          if (e instanceof ReturnException || e instanceof BreakException || e instanceof ContinueException) {
            throw e;
          }
          
          caughtError = e as Error;
          
          // Find matching except handler
          let handled = false;
          for (const handler of stmt.handlers) {
            // Check if this handler matches the exception
            const matches = this.exceptionMatches(caughtError, handler.exceptionTypes);
            if (matches) {
              handled = true;
              
              // Bind exception to variable if specified
              if (handler.name) {
                // Use baseMessage if available (for our custom errors), otherwise use message
                const errorMsg = (caughtError as any).baseMessage || caughtError.message;
                env.set(handler.name, pyString(errorMsg));
              }
              
              result = await this.executeBlock(handler.body, env);
              break;
            }
          }
          
          // If no handler matched, re-throw after finally
          if (!handled) {
            // Execute finally block first
            if (stmt.finalbody.length > 0) {
              await this.executeBlock(stmt.finalbody, env);
            }
            throw caughtError;
          }
        }
        
        // Execute finally block
        if (stmt.finalbody.length > 0) {
          await this.executeBlock(stmt.finalbody, env);
        }
        
        return result;
      }

      default: {
        const unknownStmt = stmt as unknown as { type: string; line: number; column: number };
        throw new InterpreterError(`Unknown statement type: ${unknownStmt.type}`, unknownStmt.line, unknownStmt.column);
      }
    }
  }

  private async executeBlock(statements: Statement[], parentEnv: Environment): Promise<PyValue> {
    let result: PyValue = pyNone();
    for (const stmt of statements) {
      result = await this.executeStatement(stmt, parentEnv);
    }
    return result;
  }

  private async assignTarget(target: Expression, value: PyValue, env: Environment): Promise<void> {
    switch (target.type) {
      case 'Identifier':
        env.set(target.name, value);
        break;

      case 'Tuple': {
        // Tuple unpacking: a, b = (1, 2) or for a, b in items
        const elements = target.elements;
        
        // Get iterable items from value
        let items: PyValue[];
        if (isList(value) || isTuple(value)) {
          items = value.elements;
        } else if (isString(value)) {
          items = value.value.split('').map(c => pyString(c));
        } else {
          throw new TypeError(
            `cannot unpack non-sequence ${value.type}`,
            target.line,
            target.column
          );
        }
        
        if (items.length !== elements.length) {
          throw new TypeError(
            `not enough values to unpack (expected ${elements.length}, got ${items.length})`,
            target.line,
            target.column
          );
        }
        
        // Recursively assign each element
        for (let i = 0; i < elements.length; i++) {
          await this.assignTarget(elements[i], items[i], env);
        }
        break;
      }

      case 'Subscript': {
        const obj = await this.evaluate(target.object, env);
        const index = await this.evaluate(target.index, env);

        if (isList(obj)) {
          if (!isNumber(index)) {
            throw new TypeError('list indices must be integers', target.line, target.column);
          }
          let idx = index.value;
          if (idx < 0) idx = obj.elements.length + idx;
          if (idx < 0 || idx >= obj.elements.length) {
            throw new IndexError('list assignment index out of range', target.line, target.column);
          }
          obj.elements[idx] = value;
        } else if (isDict(obj)) {
          if (!isString(index) && !isNumber(index) && !isBoolean(index)) {
            throw new TypeError('unhashable type for dict key', target.line, target.column);
          }
          obj.entries.set(index.value, value);
        } else {
          throw new TypeError(`'${obj.type}' object does not support item assignment`, target.line, target.column);
        }
        break;
      }

      case 'Attribute': {
        const obj = await this.evaluate(target.object, env);
        if (isDict(obj)) {
          obj.entries.set(target.attr, value);
        } else {
          throw new TypeError(`'${obj.type}' object does not support attribute assignment`, target.line, target.column);
        }
        break;
      }

      default:
        throw new InterpreterError(`Cannot assign to ${target.type}`, target.line, target.column);
    }
  }

  private async evaluate(expr: Expression, env: Environment): Promise<PyValue> {
    switch (expr.type) {
      case 'Number':
        return pyNumber(expr.value);

      case 'String':
        return pyString(expr.value);

      case 'Boolean':
        return pyBoolean(expr.value);

      case 'None':
        return pyNone();

      case 'Identifier': {
        // Check environment first
        const value = env.get(expr.name);
        if (value !== undefined) return value;

        // Check builtins
        const builtin = this.builtins.get(expr.name);
        if (builtin) return builtin;

        // Check tools
        if (this.tools.has(expr.name)) {
          // Return a callable that will invoke the tool
          return {
            type: 'builtin',
            name: expr.name,
            acceptsKwargs: true,
            fn: async (...args: PyValue[]) => {
              const tool = this.tools.get(expr.name)!;
              
              // Check if last arg is kwargs object
              const lastArg = args[args.length - 1];
              if (lastArg && isKwargsValue(lastArg)) {
                const kwargsArg = lastArg;
                const positionalArgs = args.slice(0, -1).map(valueToJs);
                
                // Convert kwargs to a plain JS object
                const options: Record<string, any> = {};
                for (const key of Object.keys(kwargsArg.values)) {
                  options[key] = valueToJs(kwargsArg.values[key]);
                }
                
                // Tools expect kwargs as an options object (first arg if no positional args)
                if (positionalArgs.length === 0) {
                  const result = await tool.handler(options);
                  return jsToValue(result);
                } else {
                  const result = await tool.handler(...positionalArgs, options);
                  return jsToValue(result);
                }
              }
              
              const jsArgs = args.map(valueToJs);
              const result = await tool.handler(...jsArgs);
              return jsToValue(result);
            },
          };
        }

        throw new NameError(expr.name, expr.line, expr.column);
      }

      case 'BinaryOp': {
        const left = await this.evaluate(expr.left, env);
        const right = await this.evaluate(expr.right, env);
        return this.binaryOp(expr.op, left, right, expr.line, expr.column);
      }

      case 'UnaryOp': {
        const operand = await this.evaluate(expr.operand, env);
        return this.unaryOp(expr.op, operand, expr.line, expr.column);
      }

      case 'BooleanOp': {
        const left = await this.evaluate(expr.left, env);
        if (expr.op === 'and') {
          if (!isTruthy(left)) return left;
          return await this.evaluate(expr.right, env);
        } else {
          if (isTruthy(left)) return left;
          return await this.evaluate(expr.right, env);
        }
      }

      case 'Compare': {
        let left = await this.evaluate(expr.left, env);
        for (let i = 0; i < expr.ops.length; i++) {
          const right = await this.evaluate(expr.comparators[i], env);
          if (!this.compare(expr.ops[i], left, right, expr.line, expr.column)) {
            return pyBoolean(false);
          }
          left = right;
        }
        return pyBoolean(true);
      }

      case 'Call': {
        const func = await this.evaluate(expr.func, env);
        const args: PyValue[] = [];
        for (const arg of expr.args) {
          args.push(await this.evaluate(arg, env));
        }

        // Handle keyword arguments (simplified)
        const kwargs: Record<string, PyValue> = {};
        for (const kw of expr.kwargs) {
          kwargs[kw.name] = await this.evaluate(kw.value, env);
        }

        return await this.call(func, args, kwargs, expr.line, expr.column);
      }

      case 'Subscript': {
        const obj = await this.evaluate(expr.object, env);
        const index = await this.evaluate(expr.index, env);
        return this.subscript(obj, index, expr.line, expr.column);
      }

      case 'Slice': {
        const obj = await this.evaluate(expr.object, env);
        const lower = expr.lower ? await this.evaluate(expr.lower, env) : null;
        const upper = expr.upper ? await this.evaluate(expr.upper, env) : null;
        const step = expr.step ? await this.evaluate(expr.step, env) : null;
        return this.slice(obj, lower, upper, step, expr.line, expr.column);
      }

      case 'Attribute': {
        const obj = await this.evaluate(expr.object, env);
        return this.getAttribute(obj, expr.attr, expr.line, expr.column);
      }

      case 'List': {
        const elements: PyValue[] = [];
        for (const el of expr.elements) {
          elements.push(await this.evaluate(el, env));
        }
        return pyList(elements);
      }

      case 'Dict': {
        const entries = new Map<string | number | boolean, PyValue>();
        for (let i = 0; i < expr.keys.length; i++) {
          const key = await this.evaluate(expr.keys[i], env);
          const value = await this.evaluate(expr.values[i], env);
          if (!isString(key) && !isNumber(key) && !isBoolean(key)) {
            throw new TypeError('unhashable type for dict key', expr.line, expr.column);
          }
          entries.set(key.value, value);
        }
        return pyDict(entries);
      }

      case 'Tuple': {
        const elements: PyValue[] = [];
        for (const el of expr.elements) {
          elements.push(await this.evaluate(el, env));
        }
        return pyTuple(elements);
      }

      case 'ListComp': {
        return await this.evaluateListComp(expr.element, expr.generators, env);
      }

      case 'DictComp': {
        return await this.evaluateDictComp(expr.key, expr.value, expr.generators, env);
      }

      case 'SetComp': {
        return await this.evaluateSetComp(expr.element, expr.generators, env);
      }

      case 'GeneratorExp': {
        return await this.evaluateGeneratorExp(expr.element, expr.generators, env);
      }

      case 'Ternary': {
        const test = await this.evaluate(expr.test, env);
        if (isTruthy(test)) {
          return await this.evaluate(expr.consequent, env);
        } else {
          return await this.evaluate(expr.alternate, env);
        }
      }

      case 'Lambda': {
        return {
          type: 'function',
          name: '<lambda>',
          params: expr.params.map(p => ({ name: p })),
          body: [{ type: 'Return', value: expr.body, line: expr.line, column: expr.column }],
          closure: env,
        };
      }

      case 'FString': {
        let result = '';
        for (const part of expr.parts) {
          result += part.text;
          if (part.expr) {
            const value = await this.evaluate(part.expr, env);
            result += pyStr(value);
          }
        }
        return pyString(result);
      }

      case 'NamedExpr': {
        // Walrus operator: name := value
        // Evaluates value, assigns it to name, and returns the value
        const value = await this.evaluate(expr.value, env);
        env.set(expr.target, value);
        return value;
      }

      default: {
        const unknownExpr = expr as unknown as { type: string; line: number; column: number };
        throw new InterpreterError(`Unknown expression type: ${unknownExpr.type}`, unknownExpr.line, unknownExpr.column);
      }
    }
  }

  private async evaluateListComp(
    element: Expression,
    generators: Comprehension[],
    env: Environment
  ): Promise<PyValue> {
    const results: PyValue[] = [];
    await this.evaluateComprehension(generators, 0, env, async (innerEnv) => {
      results.push(await this.evaluate(element, innerEnv));
    });
    return pyList(results);
  }

  private async evaluateDictComp(
    keyExpr: Expression,
    valueExpr: Expression,
    generators: Comprehension[],
    env: Environment
  ): Promise<PyValue> {
    const entries = new Map<string | number | boolean, PyValue>();
    await this.evaluateComprehension(generators, 0, env, async (innerEnv) => {
      const key = await this.evaluate(keyExpr, innerEnv);
      const value = await this.evaluate(valueExpr, innerEnv);
      if (!isString(key) && !isNumber(key) && !isBoolean(key)) {
        throw new TypeError('unhashable type for dict key', keyExpr.line, keyExpr.column);
      }
      entries.set(key.value, value);
    });
    return pyDict(entries);
  }

  private async evaluateSetComp(
    element: Expression,
    generators: Comprehension[],
    env: Environment
  ): Promise<PyValue> {
    const values = new Set<string | number | boolean>();
    await this.evaluateComprehension(generators, 0, env, async (innerEnv) => {
      const val = await this.evaluate(element, innerEnv);
      if (!isString(val) && !isNumber(val) && !isBoolean(val)) {
        throw new TypeError(`unhashable type: '${val.type}'`, element.line, element.column);
      }
      values.add(val.value);
    });
    return pySet(values);
  }

  private async evaluateGeneratorExp(
    element: Expression,
    generators: Comprehension[],
    env: Environment
  ): Promise<PyValue> {
    const results: PyValue[] = [];
    await this.evaluateComprehension(generators, 0, env, async (innerEnv) => {
      results.push(await this.evaluate(element, innerEnv));
    });
    return pyIterator(results);
  }

  private async evaluateComprehension(
    generators: Comprehension[],
    index: number,
    env: Environment,
    callback: (env: Environment) => Promise<void>
  ): Promise<void> {
    if (index >= generators.length) {
      await callback(env);
      return;
    }

    const gen = generators[index];
    const iter = await this.evaluate(gen.iter, env);
    const items = this.getIterableItems(iter, 0, 0);

    for (const item of items) {
      this.checkIterations(0, 0);
      const innerEnv = new Environment(env);
      await this.assignTarget(gen.target, item, innerEnv);

      // Check conditions
      let pass = true;
      for (const cond of gen.conditions) {
        if (!isTruthy(await this.evaluate(cond, innerEnv))) {
          pass = false;
          break;
        }
      }

      if (pass) {
        await this.evaluateComprehension(generators, index + 1, innerEnv, callback);
      }
    }
  }

  private binaryOp(op: string, left: PyValue, right: PyValue, line: number, column: number): PyValue {
    // String concatenation
    if (op === '+' && isString(left) && isString(right)) {
      return pyString(left.value + right.value);
    }

    // String repetition
    if (op === '*' && isString(left) && isNumber(right)) {
      return pyString(left.value.repeat(Math.max(0, Math.floor(right.value))));
    }
    if (op === '*' && isNumber(left) && isString(right)) {
      return pyString(right.value.repeat(Math.max(0, Math.floor(left.value))));
    }

    // List concatenation
    if (op === '+' && isList(left) && isList(right)) {
      return pyList([...left.elements, ...right.elements]);
    }

    // Tuple concatenation
    if (op === '+' && isTuple(left) && isTuple(right)) {
      return pyTuple([...left.elements, ...right.elements]);
    }

    // List repetition
    if (op === '*' && isList(left) && isNumber(right)) {
      const result: PyValue[] = [];
      for (let i = 0; i < Math.max(0, Math.floor(right.value)); i++) {
        result.push(...left.elements);
      }
      return pyList(result);
    }

    // Numeric operations
    if (isNumber(left) && isNumber(right)) {
      switch (op) {
        case '+': return pyNumber(left.value + right.value);
        case '-': return pyNumber(left.value - right.value);
        case '*': return pyNumber(left.value * right.value);
        case '/':
          if (right.value === 0) throw new ZeroDivisionError(line, column);
          return pyNumber(left.value / right.value);
        case '//':
          if (right.value === 0) throw new ZeroDivisionError(line, column);
          return pyNumber(Math.floor(left.value / right.value));
        case '%':
          if (right.value === 0) throw new ZeroDivisionError(line, column);
          return pyNumber(((left.value % right.value) + right.value) % right.value); // Python-style modulo
        case '**':
          return pyNumber(Math.pow(left.value, right.value));
      }
    }

    // Lenient None handling for arithmetic: treat None as 0 for data processing convenience
    // This is not standard Python, but helps when AI-generated code doesn't handle nulls
    if ((op === '+' || op === '-' || op === '*') &&
        (isNumber(left) || isNone(left)) &&
        (isNumber(right) || isNone(right))) {
      const leftVal = isNone(left) ? 0 : left.value;
      const rightVal = isNone(right) ? 0 : right.value;
      switch (op) {
        case '+': return pyNumber(leftVal + rightVal);
        case '-': return pyNumber(leftVal - rightVal);
        case '*': return pyNumber(leftVal * rightVal);
      }
    }

    throw new TypeError(
      `unsupported operand type(s) for ${op}: '${left.type}' and '${right.type}'`,
      line,
      column
    );
  }

  private unaryOp(op: string, operand: PyValue, line: number, column: number): PyValue {
    switch (op) {
      case '-':
        if (isNumber(operand)) return pyNumber(-operand.value);
        throw new TypeError(`bad operand type for unary -: '${operand.type}'`, line, column);
      case '+':
        if (isNumber(operand)) return operand;
        throw new TypeError(`bad operand type for unary +: '${operand.type}'`, line, column);
      case 'not':
        return pyBoolean(!isTruthy(operand));
      default:
        throw new InterpreterError(`Unknown unary operator: ${op}`, line, column);
    }
  }

  private compare(op: string, left: PyValue, right: PyValue, line: number, column: number): boolean {
    switch (op) {
      case '==': return pyEquals(left, right);
      case '!=': return !pyEquals(left, right);
      case '<':
      case '>':
      case '<=':
      case '>=':
        if (isNumber(left) && isNumber(right)) {
          switch (op) {
            case '<': return left.value < right.value;
            case '>': return left.value > right.value;
            case '<=': return left.value <= right.value;
            case '>=': return left.value >= right.value;
          }
        }
        if (isString(left) && isString(right)) {
          switch (op) {
            case '<': return left.value < right.value;
            case '>': return left.value > right.value;
            case '<=': return left.value <= right.value;
            case '>=': return left.value >= right.value;
          }
        }
        throw new TypeError(
          `'${op}' not supported between '${left.type}' and '${right.type}'`,
          line,
          column
        );
      case 'in':
        return this.contains(right, left, line, column);
      case 'not in':
        return !this.contains(right, left, line, column);
      case 'is':
        // Identity comparison - in Python, mainly used for None checks
        if (isNone(left) && isNone(right)) return true;
        if (isNone(left) || isNone(right)) return false;
        // For other types, fall back to equality (simplified)
        return pyEquals(left, right);
      case 'is not':
        if (isNone(left) && isNone(right)) return false;
        if (isNone(left) || isNone(right)) return true;
        return !pyEquals(left, right);
      default:
        throw new InterpreterError(`Unknown comparison operator: ${op}`, line, column);
    }
  }

  private contains(container: PyValue, item: PyValue, line: number, column: number): boolean {
    if (isList(container) || isTuple(container)) {
      return container.elements.some(el => pyEquals(el, item));
    }
    if (isString(container)) {
      if (!isString(item)) {
        throw new TypeError(`'in <string>' requires string as left operand`, line, column);
      }
      return container.value.includes(item.value);
    }
    if (isDict(container)) {
      if (!isString(item) && !isNumber(item) && !isBoolean(item)) {
        throw new TypeError('unhashable type', line, column);
      }
      return container.entries.has(item.value);
    }
    if (isSet(container)) {
      if (!isString(item) && !isNumber(item) && !isBoolean(item)) {
        throw new TypeError('unhashable type', line, column);
      }
      return container.values.has(item.value);
    }
    throw new TypeError(`argument of type '${container.type}' is not iterable`, line, column);
  }

  private async call(
    func: PyValue,
    args: PyValue[],
    kwargs: Record<string, PyValue>,
    line: number,
    column: number
  ): Promise<PyValue> {
    if (func.type === 'builtin') {
      // Handle special builtins that need interpreter access
      if ((func as any).requiresInterpreter) {
        return await this.handleSpecialBuiltin(func.name, args, line, column);
      }
      
      // Pass kwargs to builtins that accept them
      if (func.acceptsKwargs) {
        return await func.fn(...args, { type: 'kwargs' as const, values: kwargs });
      }
      return await func.fn(...args);
    }

    if (func.type === 'function') {
      const funcEnv = new Environment(func.closure);

      // Bind parameters
      for (let i = 0; i < func.params.length; i++) {
        const param = func.params[i];
        let value: PyValue;

        if (kwargs[param.name] !== undefined) {
          value = kwargs[param.name];
        } else if (i < args.length) {
          value = args[i];
        } else if (param.default !== undefined) {
          value = await this.evaluate(param.default, func.closure);
        } else {
          throw new TypeError(
            `${func.name}() missing required argument: '${param.name}'`,
            line,
            column
          );
        }

        funcEnv.set(param.name, value);
      }

      try {
        await this.executeBlock(func.body, funcEnv);
        return pyNone();
      } catch (e) {
        if (e instanceof ReturnException) {
          return e.value;
        }
        throw e;
      }
    }

    throw new TypeError(`'${func.type}' object is not callable`, line, column);
  }

  /**
   * Handle special builtins that need access to the interpreter
   * (for calling user-defined functions)
   */
  private async handleSpecialBuiltin(
    name: string,
    args: PyValue[],
    line: number,
    column: number
  ): Promise<PyValue> {
    switch (name) {
      case 'map': {
        if (args.length < 2) {
          throw new TypeError('map() requires at least 2 arguments', line, column);
        }
        const func = args[0];
        const iterable = args[1];
        
        // Get items from iterable
        let items: PyValue[];
        if (isList(iterable) || isTuple(iterable)) {
          items = iterable.elements;
        } else if (iterable.type === 'iterator') {
          items = iterable.values;
        } else if (isString(iterable)) {
          items = iterable.value.split('').map(c => pyString(c));
        } else {
          throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        }
        
        // Apply function to each item
        const results: PyValue[] = [];
        for (const item of items) {
          const result = await this.call(func, [item], {}, line, column);
          results.push(result);
        }
        
        return pyIterator(results);
      }
      
      case 'filter': {
        if (args.length < 2) {
          throw new TypeError('filter() requires 2 arguments', line, column);
        }
        const func = args[0];
        const iterable = args[1];
        
        // Get items from iterable
        let items: PyValue[];
        if (isList(iterable) || isTuple(iterable)) {
          items = iterable.elements;
        } else if (iterable.type === 'iterator') {
          items = iterable.values;
        } else if (isString(iterable)) {
          items = iterable.value.split('').map(c => pyString(c));
        } else {
          throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        }
        
        // Filter items
        const results: PyValue[] = [];
        for (const item of items) {
          let keep: boolean;
          if (func.type === 'none') {
            // filter(None, iterable) - filter by truthiness
            keep = isTruthy(item);
          } else {
            // filter(func, iterable) - filter by function result
            const result = await this.call(func, [item], {}, line, column);
            keep = isTruthy(result);
          }
          if (keep) {
            results.push(item);
          }
        }
        
        return pyIterator(results);
      }
      
      default:
        throw new TypeError(`Unknown special builtin: ${name}`, line, column);
    }
  }

  private subscript(obj: PyValue, index: PyValue, line: number, column: number): PyValue {
    if (isList(obj) || isTuple(obj)) {
      if (!isNumber(index)) {
        throw new TypeError('list indices must be integers', line, column);
      }
      let idx = Math.floor(index.value);
      if (idx < 0) idx = obj.elements.length + idx;
      if (idx < 0 || idx >= obj.elements.length) {
        throw new IndexError('list index out of range', line, column);
      }
      return obj.elements[idx];
    }

    if (isString(obj)) {
      if (!isNumber(index)) {
        throw new TypeError('string indices must be integers', line, column);
      }
      let idx = Math.floor(index.value);
      if (idx < 0) idx = obj.value.length + idx;
      if (idx < 0 || idx >= obj.value.length) {
        throw new IndexError('string index out of range', line, column);
      }
      return pyString(obj.value[idx]);
    }

    if (isDict(obj)) {
      if (!isString(index) && !isNumber(index) && !isBoolean(index)) {
        throw new TypeError('unhashable type for dict key', line, column);
      }
      const value = obj.entries.get(index.value);
      if (value === undefined) {
        throw new KeyError(String(index.value), line, column);
      }
      return value;
    }

    throw new TypeError(`'${obj.type}' object is not subscriptable`, line, column);
  }

  private slice(
    obj: PyValue,
    lower: PyValue | null,
    upper: PyValue | null,
    step: PyValue | null,
    line: number,
    column: number
  ): PyValue {
    let start: number | undefined;
    let end: number | undefined;
    let stepVal = 1;

    if (lower !== null) {
      if (!isNumber(lower)) throw new TypeError('slice indices must be integers', line, column);
      start = lower.value;
    }
    if (upper !== null) {
      if (!isNumber(upper)) throw new TypeError('slice indices must be integers', line, column);
      end = upper.value;
    }
    if (step !== null) {
      if (!isNumber(step)) throw new TypeError('slice indices must be integers', line, column);
      stepVal = step.value;
      if (stepVal === 0) throw new TypeError('slice step cannot be zero', line, column);
    }

    if (isList(obj) || isTuple(obj)) {
      const len = obj.elements.length;
      const [s, e] = this.normalizeSliceIndices(start, end, stepVal, len);
      const result: PyValue[] = [];
      
      if (stepVal > 0) {
        for (let i = s; i < e; i += stepVal) {
          result.push(obj.elements[i]);
        }
      } else {
        for (let i = s; i > e; i += stepVal) {
          result.push(obj.elements[i]);
        }
      }
      
      return isList(obj) ? pyList(result) : pyTuple(result);
    }

    if (isString(obj)) {
      const len = obj.value.length;
      const [s, e] = this.normalizeSliceIndices(start, end, stepVal, len);
      let result = '';
      
      if (stepVal > 0) {
        for (let i = s; i < e; i += stepVal) {
          result += obj.value[i];
        }
      } else {
        for (let i = s; i > e; i += stepVal) {
          result += obj.value[i];
        }
      }
      
      return pyString(result);
    }

    throw new TypeError(`'${obj.type}' object is not subscriptable`, line, column);
  }

  private normalizeSliceIndices(
    start: number | undefined,
    end: number | undefined,
    step: number,
    len: number
  ): [number, number] {
    let s: number;
    let e: number;

    if (step > 0) {
      s = start === undefined ? 0 : this.clampIndex(start, len);
      e = end === undefined ? len : this.clampIndex(end, len);
    } else {
      s = start === undefined ? len - 1 : this.clampIndex(start, len, true);
      e = end === undefined ? -1 : this.clampIndex(end, len, true);
    }

    return [s, e];
  }

  private clampIndex(index: number, len: number, forNegativeStep = false): number {
    if (index < 0) {
      index = len + index;
    }
    if (forNegativeStep) {
      return Math.max(-1, Math.min(len - 1, index));
    }
    return Math.max(0, Math.min(len, index));
  }

  private getAttribute(obj: PyValue, attr: string, line: number, column: number): PyValue {
    if (isString(obj)) return getStringMethod(obj, attr, line, column);
    if (isList(obj)) return getListMethod(obj, attr, line, column);
    if (isDict(obj)) return getDictMethod(obj, attr, line, column);
    if (isSet(obj)) return getSetMethod(obj, attr, line, column);
    throw new TypeError(`'${obj.type}' object has no attribute '${attr}'`, line, column);
  }

  private getIterableItems(value: PyValue, line: number, column: number): PyValue[] {
    if (isList(value) || isTuple(value)) {
      return value.elements;
    }
    if (value.type === 'iterator') {
      return value.values;
    }
    if (isString(value)) {
      return value.value.split('').map(c => pyString(c));
    }
    if (isDict(value)) {
      return Array.from(value.entries.keys()).map(k =>
        typeof k === 'string' ? pyString(k) : typeof k === 'number' ? pyNumber(k) : pyBoolean(k)
      );
    }
    if (isSet(value)) {
      return Array.from(value.values).map(v =>
        typeof v === 'string' ? pyString(v) : typeof v === 'number' ? pyNumber(v) : pyBoolean(v)
      );
    }
    throw new TypeError(`'${value.type}' object is not iterable`, line, column);
  }

  private checkIterations(line: number, column: number): void {
    this.iterationCount++;
    if (this.iterationCount > this.maxIterations) {
      throw new MaxIterationsError(line, column);
    }
  }

  /**
   * Check if an error matches an exception type.
   * If exceptionTypes is null (bare except), matches everything.
   */
  private exceptionMatches(error: Error, exceptionTypes: string[] | null): boolean {
    // Bare except catches everything
    if (exceptionTypes === null) {
      return true;
    }
    
    // Map our error types to Python exception names
    const errorTypeMap: Record<string, string[]> = {
      'Exception': ['TypeError', 'NameError', 'KeyError', 'IndexError', 'ZeroDivisionError', 'ValueError', 'SyntaxError', 'AttributeError'],
      'TypeError': ['TypeError'],
      'NameError': ['NameError'],
      'KeyError': ['KeyError'],
      'IndexError': ['IndexError'],
      'ZeroDivisionError': ['ZeroDivisionError'],
      'ValueError': ['ValueError'],
      'SyntaxError': ['SyntaxError'],
      'AttributeError': ['AttributeError'],
    };
    
    // Get the actual error type name from our error classes
    const errorTypeName = error.constructor.name;
    
    // Check if any of the exception types match
    for (const exceptionType of exceptionTypes) {
      const matchingTypes = errorTypeMap[exceptionType] || [exceptionType];
      if (matchingTypes.includes(errorTypeName)) {
        return true;
      }
    }

    return false;
  }
}

function isKwargsValue(value: PyValue): value is PyKwargs {
  return typeof value === 'object' && value !== null && (value as any).type === 'kwargs';
}

export function createInterpreter(options?: InterpreterOptions): Interpreter {
  return new Interpreter(options);
}
