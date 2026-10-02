/**
 * Parser for Python
 * Converts tokens into an Abstract Syntax Tree (AST)
 * Uses recursive descent parsing with precedence climbing for expressions
 */

import { Token, TokenType, FStringTokenPart } from './tokens';
import {
  Program,
  Statement,
  Expression,
  Comprehension,
  Parameter,
  Signature,
  FStringPart,
  ExceptHandler,
  AugmentedAssignment,
} from './ast';
import { SyntaxError } from './errors';
import { tokenize } from './lexer';

/** Targeted diagnostics for Python constructs this sandbox deliberately
 *  lacks. Keyed by the identifier that opens the construct. */
const UNSUPPORTED_CONSTRUCTS: Record<string, string> = {
  'class': 'class definitions are not supported in this sandbox — use dicts and functions instead',
  'with': 'with-statements are not supported in this sandbox — there are no files or context managers here; call functions directly',
  'async': 'async/await is not supported in this sandbox — tool calls already look synchronous to the script; use a regular def and call tools directly',
  'await': 'await is not supported in this sandbox — tool calls are awaited automatically; call the tool like a normal function',
};

const MATCH_UNSUPPORTED = 'match statements are not supported in this sandbox — use if/elif/else instead';

const AUGMENTED_OPS: Partial<Record<TokenType, AugmentedAssignment['op']>> = {
  [TokenType.PLUS_ASSIGN]: '+=',
  [TokenType.MINUS_ASSIGN]: '-=',
  [TokenType.STAR_ASSIGN]: '*=',
  [TokenType.SLASH_ASSIGN]: '/=',
  [TokenType.DOUBLE_SLASH_ASSIGN]: '//=',
  [TokenType.PERCENT_ASSIGN]: '%=',
  [TokenType.DOUBLE_STAR_ASSIGN]: '**=',
  [TokenType.AMPERSAND_ASSIGN]: '&=',
  [TokenType.PIPE_ASSIGN]: '|=',
  [TokenType.CARET_ASSIGN]: '^=',
  [TokenType.LSHIFT_ASSIGN]: '<<=',
  [TokenType.RSHIFT_ASSIGN]: '>>=',
};

type CompareOp = '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' | 'not in' | 'is' | 'is not';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;
  /** True right after a statement that ended with `;` on the same line. */
  private moreOnLine: boolean = false;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Program {
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.isAtEnd()) {
      statements.push(this.statement());
      this.skipNewlines();
    }
    return statements;
  }

  // ============ Statement Parsing ============

  private statement(): Statement {
    if (this.check(TokenType.INDENT)) {
      throw new SyntaxError('unexpected indent', this.peek().line, this.peek().column);
    }
    this.checkUnsupportedConstruct();

    switch (this.peek().type) {
      case TokenType.IF: return this.ifStatement();
      case TokenType.FOR: return this.forStatement();
      case TokenType.WHILE: return this.whileStatement();
      case TokenType.AT: return this.decoratedDef();
      case TokenType.DEF: return this.functionDef([]);
      case TokenType.TRY: return this.tryStatement();
      case TokenType.IMPORT: return this.importStatement();
      case TokenType.FROM: return this.fromImportStatement();
      case TokenType.RETURN: return this.returnStatement();
      case TokenType.RAISE: return this.raiseStatement();
      case TokenType.GLOBAL: return this.scopeStatement('Global');
      case TokenType.NONLOCAL: return this.scopeStatement('Nonlocal');
      case TokenType.DEL: return this.delStatement();
      case TokenType.ASSERT: return this.assertStatement();
      case TokenType.BREAK: return this.keywordStatement('Break');
      case TokenType.CONTINUE: return this.keywordStatement('Continue');
      case TokenType.PASS: return this.keywordStatement('Pass');
      default: return this.assignmentOrExpression();
    }
  }

  /** `class`, `with`, `async`, `await` and `match` lex as identifiers here
   *  since the constructs don't exist. Models emit them anyway, so fail with
   *  a message that says what to change instead of a generic syntax error. */
  private checkUnsupportedConstruct(): void {
    if (!this.check(TokenType.IDENTIFIER)) return;
    const token = this.peek();
    const name = token.value as string;
    if (Object.hasOwn(UNSUPPORTED_CONSTRUCTS, name)) {
      throw new SyntaxError(UNSUPPORTED_CONSTRUCTS[name], token.line, token.column);
    }
    if (token.value === 'match' && this.lineOpensBlock()) {
      throw new SyntaxError(MATCH_UNSUPPORTED, token.line, token.column);
    }
  }

  /** True when the current logical line ends in `:` and an indented block
   *  follows, which no expression statement can do. */
  private lineOpensBlock(): boolean {
    let i = this.pos;
    while (this.tokens[i].type !== TokenType.NEWLINE && this.tokens[i].type !== TokenType.EOF) i++;
    return i > this.pos + 1 &&
      this.tokens[i - 1].type === TokenType.COLON &&
      this.tokens[i + 1]?.type === TokenType.INDENT;
  }

  private ifStatement(): Statement {
    const token = this.advance(); // 'if' or 'elif'
    const test = this.expression();
    this.consume(TokenType.COLON, "Expected ':' after if condition");
    const body = this.block();

    let orelse: Statement[] = [];
    if (this.check(TokenType.ELIF)) {
      orelse = [this.ifStatement()];
    } else if (this.match(TokenType.ELSE)) {
      this.consume(TokenType.COLON, "Expected ':' after else");
      orelse = this.block();
    }
    return { type: 'If', test, body, orelse, line: token.line, column: token.column };
  }

  private forStatement(): Statement {
    const token = this.consume(TokenType.FOR, "Expected 'for'");
    const target = this.targetList();
    this.consume(TokenType.IN, "Expected 'in' after for target");
    const iter = this.expressionList();
    this.consume(TokenType.COLON, "Expected ':' after for iterable");
    const body = this.block();
    const orelse = this.elseBlock();
    return { type: 'For', target, iter, body, orelse, line: token.line, column: token.column };
  }

  private whileStatement(): Statement {
    const token = this.consume(TokenType.WHILE, "Expected 'while'");
    const test = this.expression();
    this.consume(TokenType.COLON, "Expected ':' after while condition");
    const body = this.block();
    const orelse = this.elseBlock();
    return { type: 'While', test, body, orelse, line: token.line, column: token.column };
  }

  private elseBlock(): Statement[] {
    if (!this.match(TokenType.ELSE)) return [];
    this.consume(TokenType.COLON, "Expected ':' after else");
    return this.block();
  }

  /**
   * Loop and comprehension targets: `x`, `a, b`, `(a, b), c`, `*rest`,
   * `d[k]`. Stops before `in` without consuming it as a comparison.
   */
  private targetList(): Expression {
    const token = this.peek();
    const first = this.target();
    if (!this.check(TokenType.COMMA)) return first;
    const elements: Expression[] = [first];
    while (this.match(TokenType.COMMA)) {
      if (this.check(TokenType.IN)) break;
      elements.push(this.target());
    }
    return { type: 'Tuple', elements, line: token.line, column: token.column };
  }

  private target(): Expression {
    const token = this.peek();
    if (this.match(TokenType.STAR)) {
      return { type: 'Starred', value: this.postfix(this.primary()), line: token.line, column: token.column };
    }
    return this.postfix(this.primary());
  }

  private decoratedDef(): Statement {
    const decorators: Expression[] = [];
    while (this.match(TokenType.AT)) {
      decorators.push(this.expression());
      this.skipNewlines();
    }
    this.checkUnsupportedConstruct();
    return this.functionDef(decorators);
  }

  private functionDef(decorators: Expression[]): Statement {
    const token = this.consume(TokenType.DEF, "Expected 'def'");
    const name = this.consume(TokenType.IDENTIFIER, 'Expected function name').value as string;
    this.consume(TokenType.LPAREN, "Expected '(' after function name");
    const signature = this.parameters(TokenType.RPAREN, true);
    this.consume(TokenType.RPAREN, "Expected ')' after parameters");
    if (this.match(TokenType.ARROW)) this.expression(); // return annotation, unused
    this.consume(TokenType.COLON, "Expected ':' after function signature");
    const body = this.block();
    return { type: 'FunctionDef', name, ...signature, decorators, body, line: token.line, column: token.column };
  }

  /** Parameter list up to (not including) `end`. Annotations are parsed and
   *  dropped; `/` (positional-only marker) is accepted and ignored. */
  private parameters(end: TokenType, allowAnnotations: boolean): Signature {
    const params: Parameter[] = [];
    const kwOnlyParams: Parameter[] = [];
    let restParam: string | undefined;
    let kwargsParam: string | undefined;
    let afterStar = false;

    const annotation = () => {
      if (allowAnnotations && this.match(TokenType.COLON)) this.expression();
    };

    while (!this.check(end)) {
      if (this.match(TokenType.DOUBLE_STAR)) {
        kwargsParam = this.consume(TokenType.IDENTIFIER, 'Expected parameter name after **').value as string;
        annotation();
      } else if (this.match(TokenType.STAR)) {
        afterStar = true;
        if (this.check(TokenType.IDENTIFIER)) {
          restParam = this.advance().value as string;
          annotation();
        }
      } else if (this.match(TokenType.SLASH)) {
        // positional-only marker
      } else {
        const param: Parameter = { name: this.consume(TokenType.IDENTIFIER, 'Expected parameter name').value as string };
        annotation();
        if (this.match(TokenType.ASSIGN)) param.default = this.expression();
        (afterStar ? kwOnlyParams : params).push(param);
      }
      if (!this.match(TokenType.COMMA)) break;
    }
    return { params, restParam, kwOnlyParams, kwargsParam };
  }

  private returnStatement(): Statement {
    const token = this.consume(TokenType.RETURN, "Expected 'return'");
    const value = this.atStatementEnd() ? null : this.expressionList();
    this.endStatement();
    return { type: 'Return', value, line: token.line, column: token.column };
  }

  private keywordStatement(type: 'Break' | 'Continue' | 'Pass'): Statement {
    const token = this.advance();
    this.endStatement();
    return { type, line: token.line, column: token.column };
  }

  /** Dotted name like `os.path` — kept as one string so the whitelist check
   *  and error message see the full name. */
  private dottedName(what: string): string {
    let name = this.consume(TokenType.IDENTIFIER, `Expected ${what}`).value as string;
    while (this.match(TokenType.DOT)) {
      name += '.' + (this.consume(TokenType.IDENTIFIER, "Expected name after '.'").value as string);
    }
    return name;
  }

  private importStatement(): Statement {
    const token = this.consume(TokenType.IMPORT, "Expected 'import'");
    const modules: Array<{ name: string; alias?: string }> = [];
    do {
      const name = this.dottedName('module name');
      let alias: string | undefined;
      if (this.match(TokenType.AS)) {
        alias = this.consume(TokenType.IDENTIFIER, "Expected name after 'as'").value as string;
      }
      modules.push({ name, alias });
    } while (this.match(TokenType.COMMA));
    this.endStatement();
    return { type: 'Import', modules, line: token.line, column: token.column };
  }

  private fromImportStatement(): Statement {
    const token = this.consume(TokenType.FROM, "Expected 'from'");
    const module = this.dottedName('module name');
    this.consume(TokenType.IMPORT, "Expected 'import' after module name");

    if (this.match(TokenType.STAR)) {
      this.endStatement();
      return { type: 'ImportFrom', module, names: '*', line: token.line, column: token.column };
    }

    const parenthesized = this.match(TokenType.LPAREN);
    const names: Array<{ name: string; alias?: string }> = [];
    do {
      if (parenthesized && this.check(TokenType.RPAREN)) break;
      const name = this.consume(TokenType.IDENTIFIER, 'Expected name to import').value as string;
      let alias: string | undefined;
      if (this.match(TokenType.AS)) {
        alias = this.consume(TokenType.IDENTIFIER, "Expected name after 'as'").value as string;
      }
      names.push({ name, alias });
    } while (this.match(TokenType.COMMA));
    if (parenthesized) this.consume(TokenType.RPAREN, "Expected ')'");
    this.endStatement();
    return { type: 'ImportFrom', module, names, line: token.line, column: token.column };
  }

  private raiseStatement(): Statement {
    const token = this.consume(TokenType.RAISE, "Expected 'raise'");
    let value: Expression | null = null;
    let cause: Expression | null = null;
    if (!this.atStatementEnd()) {
      value = this.expression();
      if (this.match(TokenType.FROM)) cause = this.expression();
    }
    this.endStatement();
    return { type: 'Raise', value, cause, line: token.line, column: token.column };
  }

  private scopeStatement(type: 'Global' | 'Nonlocal'): Statement {
    const token = this.advance();
    const keyword = type.toLowerCase();
    const names: string[] = [];
    do {
      names.push(this.consume(TokenType.IDENTIFIER, `Expected variable name after '${keyword}'`).value as string);
    } while (this.match(TokenType.COMMA));
    this.endStatement();
    return { type, names, line: token.line, column: token.column };
  }

  private delStatement(): Statement {
    const token = this.consume(TokenType.DEL, "Expected 'del'");
    const targets: Expression[] = [this.expression()];
    while (this.match(TokenType.COMMA)) {
      if (this.atStatementEnd()) break;
      targets.push(this.expression());
    }
    this.endStatement();
    return { type: 'Del', targets, line: token.line, column: token.column };
  }

  private assertStatement(): Statement {
    const token = this.consume(TokenType.ASSERT, "Expected 'assert'");
    const test = this.expression();
    const msg = this.match(TokenType.COMMA) ? this.expression() : null;
    this.endStatement();
    return { type: 'Assert', test, msg, line: token.line, column: token.column };
  }

  /**
   * Exception type(s) after `except`: `ValueError`, `re.error`, or a
   * parenthesized list with an optional trailing comma.
   */
  private exceptionTypes(): string[] {
    if (!this.match(TokenType.LPAREN)) return [this.dottedName('exception type')];
    const types: string[] = [this.dottedName('exception type')];
    while (this.match(TokenType.COMMA)) {
      if (this.check(TokenType.RPAREN)) break;
      types.push(this.dottedName('exception type'));
    }
    this.consume(TokenType.RPAREN, "Expected ')' after exception types");
    return types;
  }

  private tryStatement(): Statement {
    const token = this.consume(TokenType.TRY, "Expected 'try'");
    this.consume(TokenType.COLON, "Expected ':' after try");
    const body = this.block();

    const handlers: ExceptHandler[] = [];
    while (this.check(TokenType.EXCEPT)) {
      const exceptToken = this.advance();
      let exceptionTypes: string[] | null = null;
      let name: string | null = null;
      if (!this.check(TokenType.COLON)) {
        exceptionTypes = this.exceptionTypes();
        if (this.match(TokenType.AS)) {
          name = this.consume(TokenType.IDENTIFIER, "Expected variable name after 'as'").value as string;
        }
      }
      this.consume(TokenType.COLON, "Expected ':' after except");
      handlers.push({
        type: 'ExceptHandler',
        exceptionTypes,
        name,
        body: this.block(),
        line: exceptToken.line,
        column: exceptToken.column,
      });
    }

    const orelse = this.elseBlock();
    let finalbody: Statement[] = [];
    if (this.match(TokenType.FINALLY)) {
      this.consume(TokenType.COLON, "Expected ':' after finally");
      finalbody = this.block();
    }

    if (handlers.length === 0 && finalbody.length === 0) {
      throw new SyntaxError('try statement must have at least one except or finally clause', token.line, token.column);
    }
    return { type: 'Try', body, handlers, orelse, finalbody, line: token.line, column: token.column };
  }

  /** `yield`, `yield value`, `yield a, b` or `yield from iterable`. */
  private yieldExpression(): Expression {
    const token = this.consume(TokenType.YIELD, "Expected 'yield'");
    if (this.match(TokenType.FROM)) {
      return { type: 'YieldFrom', value: this.expression(), line: token.line, column: token.column };
    }
    const bare = this.atStatementEnd() || this.check(TokenType.RPAREN);
    const value = bare ? null : this.expressionList();
    return { type: 'Yield', value, line: token.line, column: token.column };
  }

  /** One or more comma-separated expressions; several make a tuple. */
  private expressionList(): Expression {
    const first = this.starredOrExpression();
    if (!this.check(TokenType.COMMA)) return first;
    const elements: Expression[] = [first];
    while (this.match(TokenType.COMMA)) {
      if (this.atListEnd()) break;
      elements.push(this.starredOrExpression());
    }
    return { type: 'Tuple', elements, line: first.line, column: first.column };
  }

  /** Whether a comma-separated list has ended (trailing comma case). */
  private atListEnd(): boolean {
    if (this.atStatementEnd()) return true;
    switch (this.peek().type) {
      case TokenType.ASSIGN: case TokenType.COLON: case TokenType.RPAREN:
      case TokenType.RBRACKET: case TokenType.RBRACE: case TokenType.IN:
        return true;
      default:
        return false;
    }
  }

  private starredOrExpression(): Expression {
    if (this.check(TokenType.STAR)) {
      const token = this.advance();
      return { type: 'Starred', value: this.bitwiseOr(), line: token.line, column: token.column };
    }
    return this.expression();
  }

  private valueList(): Expression {
    return this.check(TokenType.YIELD) ? this.yieldExpression() : this.expressionList();
  }

  private assignmentOrExpression(): Statement {
    const expr = this.valueList();
    const { line, column } = expr;

    // Annotated assignment `x: int = 1`, or a bare declaration `x: int`.
    if (this.match(TokenType.COLON)) {
      this.expression();
      if (!this.match(TokenType.ASSIGN)) {
        this.endStatement();
        return { type: 'Pass', line, column };
      }
      const value = this.valueList();
      this.endStatement();
      return { type: 'Assignment', targets: [expr], value, line, column };
    }

    // Assignment, possibly chained: x = y = value
    if (this.check(TokenType.ASSIGN)) {
      const targets: Expression[] = [expr];
      let value: Expression = expr;
      while (this.match(TokenType.ASSIGN)) {
        value = this.valueList();
        targets.push(value);
      }
      targets.pop();
      this.endStatement();
      return { type: 'Assignment', targets, value, line, column };
    }

    const op = AUGMENTED_OPS[this.peek().type];
    if (op) {
      this.advance();
      const value = this.valueList();
      this.endStatement();
      return { type: 'AugmentedAssignment', target: expr, op, value, line, column };
    }

    this.endStatement();
    return { type: 'ExpressionStmt', expression: expr, line, column };
  }

  /** The body after a `:` — an indented block, or simple statements on the
   *  same line (`if x: return 1`). */
  private block(): Statement[] {
    const statements: Statement[] = [];

    if (!this.check(TokenType.NEWLINE)) {
      do {
        statements.push(this.statement());
      } while (this.moreOnLine && !this.check(TokenType.DEDENT) && !this.isAtEnd());
      return statements;
    }

    this.advance();
    this.consume(TokenType.INDENT, 'Expected indented block');
    while (true) {
      this.skipNewlines();
      if (this.check(TokenType.DEDENT) || this.isAtEnd()) break;
      statements.push(this.statement());
    }
    this.match(TokenType.DEDENT);
    return statements;
  }

  // ============ Expression Parsing ============
  // Precedence (lowest to highest):
  // 1. Named expression (:=)
  // 2. Ternary (if-else), lambda
  // 3. or
  // 4. and
  // 5. not
  // 6. Comparisons (==, !=, <, >, <=, >=, in, not in, is, is not)
  // 7. Bitwise | ^ & and shifts
  // 8. Addition/Subtraction (+, -)
  // 9. Multiplication/Division (*, /, //, %)
  // 10. Unary (+, -, ~)
  // 11. Power (**)
  // 12. Primary (literals, identifiers, calls, subscripts, attributes)

  /** Parses one expression and requires the tokens to end there. Used for
   *  the expressions embedded in f-strings. */
  parseEmbeddedExpression(): Expression {
    const expr = this.expressionList();
    if (!this.check(TokenType.NEWLINE) && !this.isAtEnd()) {
      const token = this.peek();
      throw new SyntaxError('f-string: invalid syntax', token.line, token.column);
    }
    return expr;
  }

  private expression(): Expression {
    const expr = this.ternary();
    if (this.match(TokenType.WALRUS)) {
      if (expr.type !== 'Identifier') {
        throw new SyntaxError('cannot use assignment expressions with non-name', expr.line, expr.column);
      }
      const value = this.expression(); // Right-associative
      return { type: 'NamedExpr', target: expr.name, value, line: expr.line, column: expr.column };
    }
    return expr;
  }

  private ternary(): Expression {
    const expr = this.orExpr();
    // Python ternary: value_if_true if condition else value_if_false
    if (this.match(TokenType.IF)) {
      const test = this.orExpr();
      this.consume(TokenType.ELSE, "Expected 'else' in ternary expression");
      const alternate = this.ternary();
      return { type: 'Ternary', test, consequent: expr, alternate, line: expr.line, column: expr.column };
    }
    return expr;
  }

  private orExpr(): Expression {
    let left = this.andExpr();
    while (this.match(TokenType.OR)) {
      const right = this.andExpr();
      left = { type: 'BooleanOp', op: 'or', left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private andExpr(): Expression {
    let left = this.notExpr();
    while (this.match(TokenType.AND)) {
      const right = this.notExpr();
      left = { type: 'BooleanOp', op: 'and', left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private notExpr(): Expression {
    if (this.check(TokenType.NOT)) {
      const token = this.advance();
      return { type: 'UnaryOp', op: 'not', operand: this.notExpr(), line: token.line, column: token.column };
    }
    return this.comparison();
  }

  private comparisonOp(): CompareOp | null {
    switch (this.peek().type) {
      case TokenType.EQ: this.advance(); return '==';
      case TokenType.NE: this.advance(); return '!=';
      case TokenType.LT: this.advance(); return '<';
      case TokenType.GT: this.advance(); return '>';
      case TokenType.LE: this.advance(); return '<=';
      case TokenType.GE: this.advance(); return '>=';
      case TokenType.IN: this.advance(); return 'in';
      case TokenType.NOT:
        if (this.peekNext()?.type !== TokenType.IN) return null;
        this.advance();
        this.advance();
        return 'not in';
      case TokenType.IS:
        this.advance();
        return this.match(TokenType.NOT) ? 'is not' : 'is';
      default:
        return null;
    }
  }

  private comparison(): Expression {
    const left = this.bitwiseOr();
    const ops: CompareOp[] = [];
    const comparators: Expression[] = [];
    for (let op = this.comparisonOp(); op !== null; op = this.comparisonOp()) {
      ops.push(op);
      comparators.push(this.bitwiseOr());
    }
    if (ops.length === 0) return left;
    return { type: 'Compare', left, ops, comparators, line: left.line, column: left.column };
  }

  private bitwiseOr(): Expression {
    let left = this.bitwiseXor();
    while (this.match(TokenType.PIPE)) {
      const right = this.bitwiseXor();
      left = { type: 'BinaryOp', op: '|', left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private bitwiseXor(): Expression {
    let left = this.bitwiseAnd();
    while (this.match(TokenType.CARET)) {
      const right = this.bitwiseAnd();
      left = { type: 'BinaryOp', op: '^', left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private bitwiseAnd(): Expression {
    let left = this.shiftExpr();
    while (this.match(TokenType.AMPERSAND)) {
      const right = this.shiftExpr();
      left = { type: 'BinaryOp', op: '&', left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private shiftExpr(): Expression {
    let left = this.addExpr();
    while (this.check(TokenType.LSHIFT) || this.check(TokenType.RSHIFT)) {
      const op = this.advance().type === TokenType.LSHIFT ? '<<' : '>>';
      const right = this.addExpr();
      left = { type: 'BinaryOp', op, left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private addExpr(): Expression {
    let left = this.mulExpr();
    while (this.check(TokenType.PLUS) || this.check(TokenType.MINUS)) {
      const op = this.advance().type === TokenType.PLUS ? '+' : '-';
      const right = this.mulExpr();
      left = { type: 'BinaryOp', op, left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private mulExpr(): Expression {
    let left = this.unaryExpr();
    while (true) {
      let op: '*' | '/' | '//' | '%';
      switch (this.peek().type) {
        case TokenType.STAR: op = '*'; break;
        case TokenType.SLASH: op = '/'; break;
        case TokenType.DOUBLE_SLASH: op = '//'; break;
        case TokenType.PERCENT: op = '%'; break;
        default: return left;
      }
      this.advance();
      const right = this.unaryExpr();
      left = { type: 'BinaryOp', op, left, right, line: left.line, column: left.column };
    }
  }

  private unaryExpr(): Expression {
    if (this.check(TokenType.MINUS) || this.check(TokenType.PLUS) || this.check(TokenType.TILDE)) {
      const token = this.advance();
      const op = token.type === TokenType.MINUS ? '-' : token.type === TokenType.PLUS ? '+' : '~';
      return { type: 'UnaryOp', op, operand: this.unaryExpr(), line: token.line, column: token.column };
    }
    return this.powerExpr();
  }

  private powerExpr(): Expression {
    const left = this.postfix(this.primary());
    if (this.match(TokenType.DOUBLE_STAR)) {
      const right = this.unaryExpr(); // Right associative
      return { type: 'BinaryOp', op: '**', left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private primary(): Expression {
    const token = this.peek();
    const { line, column } = token;

    switch (token.type) {
      case TokenType.NUMBER:
        this.advance();
        return { type: 'Number', value: token.value as number | bigint, isFloat: token.isFloat === true, line, column };

      case TokenType.STRING:
      case TokenType.FSTRING:
        return this.stringLiteral();

      case TokenType.TRUE:
        this.advance();
        return { type: 'Boolean', value: true, line, column };

      case TokenType.FALSE:
        this.advance();
        return { type: 'Boolean', value: false, line, column };

      case TokenType.NONE:
        this.advance();
        return { type: 'None', line, column };

      case TokenType.ELLIPSIS:
        this.advance();
        return { type: 'Ellipsis', line, column };

      case TokenType.IDENTIFIER: {
        this.advance();
        const name = token.value as string;
        // `x = await foo()` — catch await in expression position too.
        if (name === 'await') throw new SyntaxError(UNSUPPORTED_CONSTRUCTS['await'], line, column);
        return { type: 'Identifier', name, line, column };
      }

      case TokenType.LPAREN:
        this.advance();
        return this.parenthesized(token);

      case TokenType.LBRACKET:
        this.advance();
        return this.listOrComprehension(token);

      case TokenType.LBRACE:
        this.advance();
        return this.dictOrSet(token);

      case TokenType.LAMBDA: {
        this.advance();
        const signature = this.parameters(TokenType.COLON, false);
        this.consume(TokenType.COLON, "Expected ':' after lambda parameters");
        return { type: 'Lambda', ...signature, body: this.expression(), line, column };
      }

      default:
        throw new SyntaxError(`Unexpected token: ${token.type}`, line, column);
    }
  }

  /** Adjacent string and f-string literals concatenate into one value. */
  private stringLiteral(): Expression {
    const first = this.peek();
    let text = '';
    let parts: FStringPart[] | null = null;
    while (this.check(TokenType.STRING) || this.check(TokenType.FSTRING)) {
      const token = this.advance();
      if (token.type === TokenType.STRING) {
        if (parts) parts.push({ text: token.value as string, expr: null });
        else text += token.value as string;
      } else {
        if (!parts) parts = text ? [{ text, expr: null }] : [];
        for (const part of token.fstringParts ?? []) parts.push(this.fstringPart(part, token));
      }
    }
    if (parts) return { type: 'FString', parts, line: first.line, column: first.column };
    return { type: 'String', value: text, line: first.line, column: first.column };
  }

  private fstringPart(part: FStringTokenPart, token: Token): FStringPart {
    if (part.expr === null) return { text: part.text, expr: null };
    const out: FStringPart = { text: part.text, expr: this.embeddedExpression(part.expr, token) };
    if (part.conversion !== undefined) {
      if (part.conversion !== 'r' && part.conversion !== 's' && part.conversion !== 'a') {
        throw new SyntaxError(`f-string: invalid conversion character '${part.conversion}'`, token.line, token.column);
      }
      out.conversion = part.conversion;
    }
    if (part.formatSpec !== undefined) {
      if (part.formatSpec.includes('{')) out.specParts = this.formatSpecParts(part.formatSpec, token);
      else out.formatSpec = part.formatSpec;
    }
    return out;
  }

  /** Splits a format spec like `>{width}.{prec}f` into literal and
   *  interpolated parts. */
  private formatSpecParts(spec: string, token: Token): FStringPart[] {
    const parts: FStringPart[] = [];
    let text = '';
    for (let i = 0; i < spec.length; i++) {
      if (spec[i] !== '{') {
        text += spec[i];
        continue;
      }
      const close = spec.indexOf('}', i);
      if (close < 0) throw new SyntaxError("f-string: expecting '}'", token.line, token.column);
      parts.push({ text, expr: this.embeddedExpression(spec.slice(i + 1, close), token) });
      text = '';
      i = close;
    }
    if (text) parts.push({ text, expr: null });
    return parts;
  }

  private embeddedExpression(source: string, token: Token): Expression {
    if (source.trim() === '') {
      throw new SyntaxError('f-string: empty expression not allowed', token.line, token.column);
    }
    const tokens = tokenize(source.trim());
    // Report positions on the f-string's own line rather than line 1.
    for (const t of tokens) {
      t.line += token.line - 1;
      t.column += token.column;
    }
    return new Parser(tokens).parseEmbeddedExpression();
  }

  /** After `(`: empty tuple, parenthesized expression, tuple, generator
   *  expression, or a parenthesized yield. */
  private parenthesized(open: Token): Expression {
    const { line, column } = open;
    if (this.match(TokenType.RPAREN)) return { type: 'Tuple', elements: [], line, column };

    if (this.check(TokenType.YIELD)) {
      const expr = this.yieldExpression();
      this.consume(TokenType.RPAREN, "Expected ')' after yield expression");
      return expr;
    }

    const first = this.starredOrExpression();
    if (this.check(TokenType.FOR)) {
      const generators = this.comprehensionGenerators();
      this.consume(TokenType.RPAREN, "Expected ')' after generator expression");
      return { type: 'GeneratorExp', element: first, generators, line, column };
    }

    if (this.check(TokenType.COMMA) || first.type === 'Starred') {
      const elements = [first];
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.RPAREN)) break;
        elements.push(this.starredOrExpression());
      }
      this.consume(TokenType.RPAREN, "Expected ')' after tuple");
      return { type: 'Tuple', elements, line, column };
    }

    this.consume(TokenType.RPAREN, "Expected ')' after expression");
    return first;
  }

  private listOrComprehension(open: Token): Expression {
    const { line, column } = open;
    if (this.match(TokenType.RBRACKET)) return { type: 'List', elements: [], line, column };

    const first = this.starredOrExpression();
    if (this.check(TokenType.FOR)) {
      const generators = this.comprehensionGenerators();
      this.consume(TokenType.RBRACKET, "Expected ']' after list comprehension");
      return { type: 'ListComp', element: first, generators, line, column };
    }

    const elements = [first];
    while (this.match(TokenType.COMMA)) {
      if (this.check(TokenType.RBRACKET)) break;
      elements.push(this.starredOrExpression());
    }
    this.consume(TokenType.RBRACKET, "Expected ']' after list");
    return { type: 'List', elements, line, column };
  }

  /** After `{`: dict, set, or one of their comprehensions. */
  private dictOrSet(open: Token): Expression {
    const { line, column } = open;
    if (this.match(TokenType.RBRACE)) return { type: 'Dict', keys: [], values: [], line, column };

    const keys: (Expression | null)[] = [];
    const values: Expression[] = [];
    const dictEntry = (key: Expression | null) => {
      if (key === null) {
        keys.push(null);
        values.push(this.bitwiseOr());
      } else {
        this.consume(TokenType.COLON, "Expected ':' after dict key");
        keys.push(key);
        values.push(this.expression());
      }
    };

    let isDict = false;
    let first: Expression | null = null;
    if (this.match(TokenType.DOUBLE_STAR)) {
      isDict = true;
      dictEntry(null);
    } else {
      first = this.starredOrExpression();
      if (this.check(TokenType.FOR)) {
        const generators = this.comprehensionGenerators();
        this.consume(TokenType.RBRACE, "Expected '}' after set comprehension");
        return { type: 'SetComp', element: first, generators, line, column };
      }
      if (this.check(TokenType.COLON)) {
        isDict = true;
        dictEntry(first);
        if (this.check(TokenType.FOR)) {
          const generators = this.comprehensionGenerators();
          this.consume(TokenType.RBRACE, "Expected '}' after dict comprehension");
          return { type: 'DictComp', key: first, value: values[0], generators, line, column };
        }
      }
    }

    if (isDict) {
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.RBRACE)) break;
        dictEntry(this.match(TokenType.DOUBLE_STAR) ? null : this.expression());
      }
      this.consume(TokenType.RBRACE, "Expected '}' after dict");
      return { type: 'Dict', keys, values, line, column };
    }

    const elements = [first!];
    while (this.match(TokenType.COMMA)) {
      if (this.check(TokenType.RBRACE)) break;
      elements.push(this.starredOrExpression());
    }
    this.consume(TokenType.RBRACE, "Expected '}' after set literal");
    return { type: 'Set', elements, line, column };
  }

  private comprehensionGenerators(): Comprehension[] {
    const generators: Comprehension[] = [];
    while (this.match(TokenType.FOR)) {
      // Same target grammar as `for` statements: `for k, v in items`
      const target = this.targetList();
      this.consume(TokenType.IN, "Expected 'in' in comprehension");
      const iter = this.orExpr(); // Not a full expression, to avoid 'if' ambiguity
      const conditions: Expression[] = [];
      while (this.match(TokenType.IF)) conditions.push(this.orExpr());
      generators.push({ target, iter, conditions });
    }
    return generators;
  }

  private postfix(expr: Expression): Expression {
    while (true) {
      const { line, column } = expr;
      if (this.match(TokenType.LPAREN)) {
        const call = this.argumentList();
        this.consume(TokenType.RPAREN, "Expected ')' after arguments");
        expr = { type: 'Call', func: expr, ...call, line, column };
      } else if (this.match(TokenType.LBRACKET)) {
        expr = this.subscriptOrSlice(expr);
      } else if (this.match(TokenType.DOT)) {
        const attr = this.consume(TokenType.IDENTIFIER, 'Expected attribute name').value as string;
        expr = { type: 'Attribute', object: expr, attr, line, column };
      } else {
        return expr;
      }
    }
  }

  private argumentList(): { args: Expression[]; kwargs: { name: string; value: Expression }[]; doubleStarArgs?: Expression[] } {
    const args: Expression[] = [];
    const kwargs: { name: string; value: Expression }[] = [];
    const doubleStarArgs: Expression[] = [];

    while (!this.check(TokenType.RPAREN)) {
      if (this.match(TokenType.DOUBLE_STAR)) {
        doubleStarArgs.push(this.expression());
      } else if (this.check(TokenType.STAR)) {
        const star = this.advance();
        args.push({ type: 'Starred', value: this.expression(), line: star.line, column: star.column });
      } else if (this.check(TokenType.IDENTIFIER) && this.peekNext()?.type === TokenType.ASSIGN) {
        const name = this.advance().value as string;
        this.advance(); // consume '='
        kwargs.push({ name, value: this.expression() });
      } else {
        const first = this.expression();
        if (this.check(TokenType.FOR)) {
          const generators = this.comprehensionGenerators();
          args.push({ type: 'GeneratorExp', element: first, generators, line: first.line, column: first.column });
        } else {
          args.push(first);
        }
      }
      if (!this.match(TokenType.COMMA)) break;
    }

    return { args, kwargs, doubleStarArgs: doubleStarArgs.length > 0 ? doubleStarArgs : undefined };
  }

  /** After `[`: an index, a slice, or a tuple index like `d[a, b]`. */
  private subscriptOrSlice(object: Expression): Expression {
    const { line, column } = object;
    let lower: Expression | null = null;
    let upper: Expression | null = null;
    let step: Expression | null = null;

    if (!this.check(TokenType.COLON)) lower = this.expression();

    if (this.match(TokenType.COLON)) {
      if (!this.check(TokenType.COLON) && !this.check(TokenType.RBRACKET)) upper = this.expression();
      if (this.match(TokenType.COLON) && !this.check(TokenType.RBRACKET)) step = this.expression();
      this.consume(TokenType.RBRACKET, "Expected ']' after subscript");
      return { type: 'Slice', object, lower, upper, step, line, column };
    }

    let index = lower!;
    if (this.check(TokenType.COMMA)) {
      const elements = [index];
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.RBRACKET)) break;
        elements.push(this.expression());
      }
      index = { type: 'Tuple', elements, line: index.line, column: index.column };
    }
    this.consume(TokenType.RBRACKET, "Expected ']' after subscript");
    return { type: 'Subscript', object, index, line, column };
  }

  // ============ Helper Methods ============

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private peekNext(): Token | null {
    if (this.pos + 1 >= this.tokens.length) return null;
    return this.tokens[this.pos + 1];
  }

  private previous(): Token {
    return this.tokens[this.pos - 1];
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type && type !== TokenType.EOF;
  }

  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.pos++;
    return this.previous();
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    const token = this.peek();
    throw new SyntaxError(message, token.line, token.column);
  }

  private skipNewlines(): void {
    while (this.check(TokenType.NEWLINE)) this.pos++;
  }

  private atStatementEnd(): boolean {
    const type = this.peek().type;
    return type === TokenType.NEWLINE || type === TokenType.DEDENT || type === TokenType.EOF;
  }

  /** A simple statement must be followed by a line break or `;`. */
  private endStatement(): void {
    const token = this.peek();
    if (token.type === TokenType.NEWLINE) {
      this.moreOnLine = token.value === ';';
      this.pos++;
      return;
    }
    this.moreOnLine = false;
    if (token.type === TokenType.DEDENT || token.type === TokenType.EOF) return;
    throw new SyntaxError('invalid syntax', token.line, token.column);
  }
}

export function parse(source: string): Program {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parse();
}
