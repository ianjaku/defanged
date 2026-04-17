/**
 * Parser for Python
 * Converts tokens into an Abstract Syntax Tree (AST)
 * Uses recursive descent parsing with precedence climbing for expressions
 */

import { Token, TokenType } from './tokens';
import {
  Program,
  Statement,
  Expression,
  If,
  Comprehension,
  Parameter,
  FStringPart,
  ExceptHandler,
} from './ast';
import { SyntaxError } from './errors';
import { tokenize } from './lexer';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Program {
    const statements: Statement[] = [];

    // Skip leading newlines
    while (this.check(TokenType.NEWLINE)) {
      this.advance();
    }

    while (!this.isAtEnd()) {
      const stmt = this.statement();
      if (stmt) {
        statements.push(stmt);
      }
      // Skip trailing newlines between statements
      while (this.check(TokenType.NEWLINE)) {
        this.advance();
      }
    }

    return statements;
  }

  // ============ Statement Parsing ============

  private statement(): Statement | null {
    // Skip empty lines
    if (this.check(TokenType.NEWLINE)) {
      this.advance();
      return null;
    }

    // Check for import statements and give a clear error
    if (this.check(TokenType.IMPORT) || this.check(TokenType.FROM)) {
      const token = this.peek();
      throw new SyntaxError(
        "Import statements are not supported. All required functions (get_bank_transactions, get_invoices, get_balances, get_expenses) are already available.",
        token.line,
        token.column
      );
    }

    if (this.check(TokenType.IF)) return this.ifStatement();
    if (this.check(TokenType.FOR)) return this.forStatement();
    if (this.check(TokenType.WHILE)) return this.whileStatement();
    if (this.check(TokenType.DEF)) return this.functionDef();
    if (this.check(TokenType.RETURN)) return this.returnStatement();
    if (this.check(TokenType.BREAK)) return this.breakStatement();
    if (this.check(TokenType.CONTINUE)) return this.continueStatement();
    if (this.check(TokenType.PASS)) return this.passStatement();
    if (this.check(TokenType.TRY)) return this.tryStatement();

    return this.assignmentOrExpression();
  }

  private ifStatement(): Statement {
    const token = this.consume(TokenType.IF, "Expected 'if'");
    const test = this.expression();
    this.consume(TokenType.COLON, "Expected ':' after if condition");
    const body = this.block();

    let orelse: Statement[] = [];

    // Handle elif chains
    while (this.check(TokenType.ELIF)) {
      this.advance();
      const elifTest = this.expression();
      this.consume(TokenType.COLON, "Expected ':' after elif condition");
      const elifBody = this.block();
      orelse = [{
        type: 'If',
        test: elifTest,
        body: elifBody,
        orelse: [],
        line: this.previous().line,
        column: this.previous().column,
      }];
      // Continue building the chain
      const lastElif = orelse[0] as If;
      
      if (this.check(TokenType.ELIF)) {
        // More elifs coming, will be handled in next iteration
        const remainingOrelse: If[] = [];
        while (this.check(TokenType.ELIF)) {
          this.advance();
          const nextTest = this.expression();
          this.consume(TokenType.COLON, "Expected ':' after elif condition");
          const nextBody = this.block();
          remainingOrelse.push({
            type: 'If',
            test: nextTest,
            body: nextBody,
            orelse: [],
            line: this.previous().line,
            column: this.previous().column,
          });
        }
        // Chain them together
        for (let i = remainingOrelse.length - 1; i >= 0; i--) {
          if (i === remainingOrelse.length - 1) {
            if (this.check(TokenType.ELSE)) {
              this.advance();
              this.consume(TokenType.COLON, "Expected ':' after else");
              remainingOrelse[i].orelse = this.block();
            }
          } else {
            remainingOrelse[i].orelse = [remainingOrelse[i + 1]];
          }
        }
        if (remainingOrelse.length > 0) {
          lastElif.orelse = [remainingOrelse[0]];
        }
        break;
      } else if (this.check(TokenType.ELSE)) {
        this.advance();
        this.consume(TokenType.COLON, "Expected ':' after else");
        lastElif.orelse = this.block();
        break;
      }
    }

    // Handle else
    if (orelse.length === 0 && this.check(TokenType.ELSE)) {
      this.advance();
      this.consume(TokenType.COLON, "Expected ':' after else");
      orelse = this.block();
    }

    return {
      type: 'If',
      test,
      body,
      orelse,
      line: token.line,
      column: token.column,
    };
  }

  private forStatement(): Statement {
    const token = this.consume(TokenType.FOR, "Expected 'for'");
    const target = this.parseAssignmentTarget();
    this.consume(TokenType.IN, "Expected 'in' after for target");
    const iter = this.expression();
    this.consume(TokenType.COLON, "Expected ':' after for iterable");
    const body = this.block();

    return {
      type: 'For',
      target,
      iter,
      body,
      line: token.line,
      column: token.column,
    };
  }

  /**
   * Parse an assignment target, which can be:
   * - A simple identifier: x
   * - A tuple of identifiers: a, b, c
   * - Parenthesized tuple: (a, b)
   * - Nested tuples: (a, b), c or ((a, b), c)
   */
  private parseAssignmentTarget(): Expression {
    const token = this.peek();
    
    // Parse first element (which may be parenthesized)
    const first = this.parseSingleTarget();
    
    // Check if there's a comma (tuple unpacking at this level)
    // We stop at 'in' keyword to not consume the iterator expression
    if (this.check(TokenType.COMMA)) {
      const elements: Expression[] = [first];
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.IN)) break; // Stop before 'in' keyword
        elements.push(this.parseSingleTarget());
      }
      if (elements.length === 1) {
        return elements[0]; // Trailing comma, single element
      }
      return {
        type: 'Tuple',
        elements,
        line: token.line,
        column: token.column,
      };
    }
    
    return first;
  }
  
  /**
   * Parse a single assignment target element (identifier or parenthesized tuple)
   */
  private parseSingleTarget(): Expression {
    const token = this.peek();
    
    if (this.match(TokenType.LPAREN)) {
      // Parenthesized tuple
      const elements: Expression[] = [];
      if (!this.check(TokenType.RPAREN)) {
        elements.push(this.parseAssignmentTarget()); // Recursive for nested tuples
      }
      this.consume(TokenType.RPAREN, "Expected ')' after tuple");
      
      if (elements.length === 1 && elements[0].type === 'Tuple') {
        // Already a tuple from recursive call
        return elements[0];
      }
      if (elements.length === 1) {
        return elements[0]; // Just parenthesized single element
      }
      return {
        type: 'Tuple',
        elements,
        line: token.line,
        column: token.column,
      };
    }
    
    return this.primary();
  }

  private whileStatement(): Statement {
    const token = this.consume(TokenType.WHILE, "Expected 'while'");
    const test = this.expression();
    this.consume(TokenType.COLON, "Expected ':' after while condition");
    const body = this.block();

    return {
      type: 'While',
      test,
      body,
      line: token.line,
      column: token.column,
    };
  }

  private functionDef(): Statement {
    const token = this.consume(TokenType.DEF, "Expected 'def'");
    const nameToken = this.consume(TokenType.IDENTIFIER, "Expected function name");
    const name = nameToken.value as string;

    this.consume(TokenType.LPAREN, "Expected '(' after function name");
    const params = this.parameters();
    this.consume(TokenType.RPAREN, "Expected ')' after parameters");
    this.consume(TokenType.COLON, "Expected ':' after function signature");
    const body = this.block();

    return {
      type: 'FunctionDef',
      name,
      params,
      body,
      line: token.line,
      column: token.column,
    };
  }

  private parameters(): Parameter[] {
    const params: Parameter[] = [];

    if (!this.check(TokenType.RPAREN)) {
      do {
        const nameToken = this.consume(TokenType.IDENTIFIER, "Expected parameter name");
        const param: Parameter = { name: nameToken.value as string };

        // Check for default value
        if (this.match(TokenType.ASSIGN)) {
          param.default = this.expression();
        }

        params.push(param);
      } while (this.match(TokenType.COMMA));
    }

    return params;
  }

  private returnStatement(): Statement {
    const token = this.consume(TokenType.RETURN, "Expected 'return'");
    let value: Expression | null = null;

    if (!this.check(TokenType.NEWLINE) && !this.isAtEnd()) {
      const first = this.expression();
      if (this.check(TokenType.COMMA)) {
        const elements: Expression[] = [first];
        while (this.match(TokenType.COMMA)) {
          if (this.check(TokenType.NEWLINE) || this.isAtEnd()) break;
          elements.push(this.expression());
        }
        value = {
          type: 'Tuple',
          elements,
          line: first.line,
          column: first.column,
        };
      } else {
        value = first;
      }
    }

    this.consumeNewline();

    return {
      type: 'Return',
      value,
      line: token.line,
      column: token.column,
    };
  }

  private breakStatement(): Statement {
    const token = this.consume(TokenType.BREAK, "Expected 'break'");
    this.consumeNewline();
    return {
      type: 'Break',
      line: token.line,
      column: token.column,
    };
  }

  private continueStatement(): Statement {
    const token = this.consume(TokenType.CONTINUE, "Expected 'continue'");
    this.consumeNewline();
    return {
      type: 'Continue',
      line: token.line,
      column: token.column,
    };
  }

  private passStatement(): Statement {
    const token = this.consume(TokenType.PASS, "Expected 'pass'");
    this.consumeNewline();
    return {
      type: 'Pass',
      line: token.line,
      column: token.column,
    };
  }

  /**
   * Parse the optional exception type(s) that follow an `except` keyword.
   *
   * Supported:
   * - except ValueError:
   * - except (ValueError, TypeError):
   * - except (ValueError, TypeError,):   // trailing comma
   */
  private parseExceptExceptionTypes(): string[] {
    // Tuple of exception types: except (A, B)
    if (this.match(TokenType.LPAREN)) {
      if (this.check(TokenType.RPAREN)) {
        const token = this.peek();
        throw new SyntaxError("Expected exception type", token.line, token.column);
      }

      const types: string[] = [];
      const first = this.consume(TokenType.IDENTIFIER, "Expected exception type");
      types.push(first.value as string);

      while (this.match(TokenType.COMMA)) {
        // Allow trailing comma before ')'
        if (this.check(TokenType.RPAREN)) break;
        const next = this.consume(TokenType.IDENTIFIER, "Expected exception type");
        types.push(next.value as string);
      }

      this.consume(TokenType.RPAREN, "Expected ')' after exception types");
      return types;
    }

    // Single exception type: except ValueError
    const typeToken = this.consume(TokenType.IDENTIFIER, "Expected exception type");
    return [typeToken.value as string];
  }

  private tryStatement(): Statement {
    const token = this.consume(TokenType.TRY, "Expected 'try'");
    this.consume(TokenType.COLON, "Expected ':' after try");
    const body = this.block();

    const handlers: ExceptHandler[] = [];

    // Parse except handlers
    while (this.check(TokenType.EXCEPT)) {
      const exceptToken = this.advance();
      let exceptionTypes: string[] | null = null;
      let name: string | null = null;

      // Check for exception type(s): except ValueError or except (ValueError, TypeError) or with `as`
      if (!this.check(TokenType.COLON)) {
        exceptionTypes = this.parseExceptExceptionTypes();

        // Check for 'as' binding: except ValueError as e
        if (this.match(TokenType.AS)) {
          const nameToken = this.consume(TokenType.IDENTIFIER, "Expected variable name after 'as'");
          name = nameToken.value as string;
        }
      }

      this.consume(TokenType.COLON, "Expected ':' after except");
      const handlerBody = this.block();

      handlers.push({
        type: 'ExceptHandler',
        exceptionTypes,
        name,
        body: handlerBody,
        line: exceptToken.line,
        column: exceptToken.column,
      });
    }

    // Parse optional finally block
    let finalbody: Statement[] = [];
    if (this.match(TokenType.FINALLY)) {
      this.consume(TokenType.COLON, "Expected ':' after finally");
      finalbody = this.block();
    }

    // Must have at least one except handler or a finally block
    if (handlers.length === 0 && finalbody.length === 0) {
      throw new SyntaxError("try statement must have at least one except or finally clause", token.line, token.column);
    }

    return {
      type: 'Try',
      body,
      handlers,
      finalbody,
      line: token.line,
      column: token.column,
    };
  }

  private assignmentOrExpression(): Statement {
    const expr = this.expression();

    // Check for comma (potential tuple unpacking or implicit tuple expression)
    if (this.check(TokenType.COMMA) && !this.isAtEnd()) {
      const elements: Expression[] = [expr];
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.ASSIGN) || this.check(TokenType.NEWLINE) || this.isAtEnd()) break;
        elements.push(this.expression());
      }

      // Tuple unpacking assignment: a, b = 1, 2
      if (this.match(TokenType.ASSIGN)) {
        const target: Expression = elements.length === 1 ? elements[0] : {
          type: 'Tuple',
          elements,
          line: expr.line,
          column: expr.column,
        };
        // Parse the RHS, which may also be comma-separated (implicit tuple)
        const firstVal = this.expression();
        const valElements: Expression[] = [firstVal];
        while (this.match(TokenType.COMMA)) {
          if (this.check(TokenType.NEWLINE) || this.isAtEnd()) break;
          valElements.push(this.expression());
        }
        const value: Expression = valElements.length === 1 ? valElements[0] : {
          type: 'Tuple',
          elements: valElements,
          line: firstVal.line,
          column: firstVal.column,
        };
        this.consumeNewline();
        return {
          type: 'Assignment',
          targets: [target],
          value,
          line: expr.line,
          column: expr.column,
        };
      }

      // Implicit tuple expression statement: (not assignment)
      const tupleExpr: Expression = {
        type: 'Tuple',
        elements,
        line: expr.line,
        column: expr.column,
      };
      this.consumeNewline();
      return {
        type: 'ExpressionStmt',
        expression: tupleExpr,
        line: expr.line,
        column: expr.column,
      };
    }

    // Check for assignment (supports chained: x = y = z = value)
    if (this.match(TokenType.ASSIGN)) {
      const targets: Expression[] = [expr];
      let value = this.expression();
      while (this.match(TokenType.ASSIGN)) {
        targets.push(value);
        value = this.expression();
      }
      this.consumeNewline();
      return {
        type: 'Assignment',
        targets,
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    // Check for augmented assignment
    if (this.match(TokenType.PLUS_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '+=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    if (this.match(TokenType.MINUS_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '-=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    if (this.match(TokenType.STAR_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '*=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    if (this.match(TokenType.SLASH_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '/=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    if (this.match(TokenType.DOUBLE_SLASH_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '//=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    if (this.match(TokenType.PERCENT_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '%=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    if (this.match(TokenType.DOUBLE_STAR_ASSIGN)) {
      const value = this.expression();
      this.consumeNewline();
      return {
        type: 'AugmentedAssignment',
        target: expr,
        op: '**=',
        value,
        line: expr.line,
        column: expr.column,
      };
    }

    this.consumeNewline();
    return {
      type: 'ExpressionStmt',
      expression: expr,
      line: expr.line,
      column: expr.column,
    };
  }

  private block(): Statement[] {
    this.consume(TokenType.NEWLINE, "Expected newline after ':'");
    this.consume(TokenType.INDENT, "Expected indented block");

    const statements: Statement[] = [];

    while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      // Skip empty lines
      while (this.check(TokenType.NEWLINE)) {
        this.advance();
      }
      if (this.check(TokenType.DEDENT) || this.isAtEnd()) break;

      const stmt = this.statement();
      if (stmt) {
        statements.push(stmt);
      }
    }

    if (this.check(TokenType.DEDENT)) {
      this.advance();
    }

    return statements;
  }

  // ============ Expression Parsing ============
  // Precedence (lowest to highest):
  // 1. Ternary (if-else)
  // 2. or
  // 3. and
  // 4. not
  // 5. Comparisons (==, !=, <, >, <=, >=, in, not in)
  // 6. Addition/Subtraction (+, -)
  // 7. Multiplication/Division (*, /, //, %)
  // 8. Unary (+, -)
  // 9. Power (**)
  // 10. Primary (literals, identifiers, calls, subscripts, attributes)

  private expression(): Expression {
    return this.namedExpr();
  }

  // Named expression (walrus operator): name := value
  private namedExpr(): Expression {
    const expr = this.ternary();
    
    // Check for walrus operator
    if (this.match(TokenType.WALRUS)) {
      // The left side must be an identifier
      if (expr.type !== 'Identifier') {
        throw new SyntaxError(
          "cannot use assignment expressions with non-name",
          expr.line,
          expr.column
        );
      }
      
      const value = this.namedExpr(); // Right-associative
      return {
        type: 'NamedExpr',
        target: expr.name,
        value,
        line: expr.line,
        column: expr.column,
      };
    }
    
    return expr;
  }

  private ternary(): Expression {
    const expr = this.orExpr();

    // Python ternary: value_if_true if condition else value_if_false
    if (this.check(TokenType.IF)) {
      this.advance();
      const test = this.orExpr();
      this.consume(TokenType.ELSE, "Expected 'else' in ternary expression");
      const alternate = this.ternary();
      return {
        type: 'Ternary',
        test,
        consequent: expr,
        alternate,
        line: expr.line,
        column: expr.column,
      };
    }

    return expr;
  }

  private orExpr(): Expression {
    let left = this.andExpr();

    while (this.match(TokenType.OR)) {
      const right = this.andExpr();
      left = {
        type: 'BooleanOp',
        op: 'or',
        left,
        right,
        line: left.line,
        column: left.column,
      };
    }

    return left;
  }

  private andExpr(): Expression {
    let left = this.notExpr();

    while (this.match(TokenType.AND)) {
      const right = this.notExpr();
      left = {
        type: 'BooleanOp',
        op: 'and',
        left,
        right,
        line: left.line,
        column: left.column,
      };
    }

    return left;
  }

  private notExpr(): Expression {
    if (this.match(TokenType.NOT)) {
      const token = this.previous();
      const operand = this.notExpr();
      return {
        type: 'UnaryOp',
        op: 'not',
        operand,
        line: token.line,
        column: token.column,
      };
    }

    return this.comparison();
  }

  private comparison(): Expression {
    const left = this.addExpr();

    const ops: ('==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' | 'not in' | 'is' | 'is not')[] = [];
    const comparators: Expression[] = [];

    while (true) {
      let op: typeof ops[number] | null = null;

      if (this.match(TokenType.EQ)) op = '==';
      else if (this.match(TokenType.NE)) op = '!=';
      else if (this.match(TokenType.LT)) op = '<';
      else if (this.match(TokenType.GT)) op = '>';
      else if (this.match(TokenType.LE)) op = '<=';
      else if (this.match(TokenType.GE)) op = '>=';
      else if (this.match(TokenType.IN)) op = 'in';
      else if (this.check(TokenType.NOT) && this.peekNext()?.type === TokenType.IN) {
        this.advance(); // consume 'not'
        this.advance(); // consume 'in'
        op = 'not in';
      }
      else if (this.match(TokenType.IS)) {
        if (this.check(TokenType.NOT)) {
          this.advance(); // consume 'not'
          op = 'is not';
        } else {
          op = 'is';
        }
      }

      if (op === null) break;

      ops.push(op);
      comparators.push(this.addExpr());
    }

    if (ops.length === 0) {
      return left;
    }

    return {
      type: 'Compare',
      left,
      ops,
      comparators,
      line: left.line,
      column: left.column,
    };
  }

  private addExpr(): Expression {
    let left = this.mulExpr();

    while (this.check(TokenType.PLUS) || this.check(TokenType.MINUS)) {
      const op = this.advance().type === TokenType.PLUS ? '+' : '-';
      const right = this.mulExpr();
      left = {
        type: 'BinaryOp',
        op,
        left,
        right,
        line: left.line,
        column: left.column,
      };
    }

    return left;
  }

  private mulExpr(): Expression {
    let left = this.unaryExpr();

    while (
      this.check(TokenType.STAR) ||
      this.check(TokenType.SLASH) ||
      this.check(TokenType.DOUBLE_SLASH) ||
      this.check(TokenType.PERCENT)
    ) {
      const token = this.advance();
      let op: '*' | '/' | '//' | '%';
      switch (token.type) {
        case TokenType.STAR: op = '*'; break;
        case TokenType.SLASH: op = '/'; break;
        case TokenType.DOUBLE_SLASH: op = '//'; break;
        case TokenType.PERCENT: op = '%'; break;
        default: throw new Error('Unreachable');
      }
      const right = this.unaryExpr();
      left = {
        type: 'BinaryOp',
        op,
        left,
        right,
        line: left.line,
        column: left.column,
      };
    }

    return left;
  }

  private unaryExpr(): Expression {
    if (this.check(TokenType.MINUS) || this.check(TokenType.PLUS)) {
      const token = this.advance();
      const op = token.type === TokenType.MINUS ? '-' : '+';
      const operand = this.unaryExpr();
      return {
        type: 'UnaryOp',
        op,
        operand,
        line: token.line,
        column: token.column,
      };
    }

    return this.powerExpr();
  }

  private powerExpr(): Expression {
    let left = this.postfix(this.primary());

    if (this.match(TokenType.DOUBLE_STAR)) {
      const right = this.unaryExpr(); // Right associative
      left = {
        type: 'BinaryOp',
        op: '**',
        left,
        right,
        line: left.line,
        column: left.column,
      };
    }

    return left;
  }

  private primary(): Expression {
    const token = this.peek();

    // Number
    if (this.match(TokenType.NUMBER)) {
      return {
        type: 'Number',
        value: this.previous().value as number,
        line: token.line,
        column: token.column,
      };
    }

    // String
    if (this.match(TokenType.STRING)) {
      return {
        type: 'String',
        value: this.previous().value as string,
        line: token.line,
        column: token.column,
      };
    }

    // F-string
    if (this.match(TokenType.FSTRING)) {
      const fstringToken = this.previous();
      const rawParts = fstringToken.fstringParts || [];
      
      // Parse each expression string into an AST
      const parts: FStringPart[] = rawParts.map(part => {
        if (part.expr) {
          // Parse the expression string
          const exprTokens = tokenize(part.expr);
          const exprParser = new Parser(exprTokens);
          const exprAst = exprParser.expression();
          return { text: part.text, expr: exprAst };
        } else {
          return { text: part.text, expr: null };
        }
      });
      
      return {
        type: 'FString',
        parts,
        line: token.line,
        column: token.column,
      };
    }

    // Boolean
    if (this.match(TokenType.TRUE)) {
      return {
        type: 'Boolean',
        value: true,
        line: token.line,
        column: token.column,
      };
    }

    if (this.match(TokenType.FALSE)) {
      return {
        type: 'Boolean',
        value: false,
        line: token.line,
        column: token.column,
      };
    }

    // None
    if (this.match(TokenType.NONE)) {
      return {
        type: 'None',
        line: token.line,
        column: token.column,
      };
    }

    // Identifier
    if (this.match(TokenType.IDENTIFIER)) {
      return {
        type: 'Identifier',
        name: this.previous().value as string,
        line: token.line,
        column: token.column,
      };
    }

    // Parenthesized expression or tuple
    if (this.match(TokenType.LPAREN)) {
      // Empty tuple
      if (this.match(TokenType.RPAREN)) {
        return {
          type: 'Tuple',
          elements: [],
          line: token.line,
          column: token.column,
        };
      }

      const first = this.expression();

      // Generator expression: (x for x in items if ...)
      if (this.check(TokenType.FOR)) {
        const generators = this.comprehensionGenerators();
        this.consume(TokenType.RPAREN, "Expected ')' after generator expression");
        return {
          type: 'GeneratorExp',
          element: first,
          generators,
          line: token.line,
          column: token.column,
        };
      }

      // Check for tuple
      if (this.match(TokenType.COMMA)) {
        const elements = [first];
        if (!this.check(TokenType.RPAREN)) {
          do {
            elements.push(this.expression());
          } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
        }
        this.consume(TokenType.RPAREN, "Expected ')' after tuple");
        return {
          type: 'Tuple',
          elements,
          line: token.line,
          column: token.column,
        };
      }

      this.consume(TokenType.RPAREN, "Expected ')' after expression");
      return first;
    }

    // List literal or list comprehension
    if (this.match(TokenType.LBRACKET)) {
      return this.listOrComprehension(token);
    }

    // Dict literal or dict comprehension
    if (this.match(TokenType.LBRACE)) {
      return this.dictOrComprehension(token);
    }

    // Lambda expression: lambda x: x + 1
    if (this.match(TokenType.LAMBDA)) {
      return this.lambdaExpression(token);
    }

    throw new SyntaxError(
      `Unexpected token: ${token.type}`,
      token.line,
      token.column
    );
  }

  private lambdaExpression(startToken: Token): Expression {
    // Parse parameters (comma-separated identifiers before the colon)
    const params: string[] = [];
    
    if (!this.check(TokenType.COLON)) {
      // First parameter
      const firstParam = this.consume(TokenType.IDENTIFIER, "Expected parameter name in lambda");
      params.push(firstParam.value as string);
      
      // Additional parameters
      while (this.match(TokenType.COMMA)) {
        const param = this.consume(TokenType.IDENTIFIER, "Expected parameter name after ','");
        params.push(param.value as string);
      }
    }
    
    this.consume(TokenType.COLON, "Expected ':' after lambda parameters");
    
    // Parse the body expression
    const body = this.expression();
    
    return {
      type: 'Lambda',
      params,
      body,
      line: startToken.line,
      column: startToken.column,
    };
  }

  private listOrComprehension(startToken: Token): Expression {
    // Empty list
    if (this.match(TokenType.RBRACKET)) {
      return {
        type: 'List',
        elements: [],
        line: startToken.line,
        column: startToken.column,
      };
    }

    const first = this.expression();

    // Check for list comprehension
    if (this.check(TokenType.FOR)) {
      const generators = this.comprehensionGenerators();
      this.consume(TokenType.RBRACKET, "Expected ']' after list comprehension");
      return {
        type: 'ListComp',
        element: first,
        generators,
        line: startToken.line,
        column: startToken.column,
      };
    }

    // Regular list
    const elements = [first];
    while (this.match(TokenType.COMMA)) {
      if (this.check(TokenType.RBRACKET)) break;
      elements.push(this.expression());
    }

    this.consume(TokenType.RBRACKET, "Expected ']' after list");
    return {
      type: 'List',
      elements,
      line: startToken.line,
      column: startToken.column,
    };
  }

  private dictOrComprehension(startToken: Token): Expression {
    // Empty dict
    if (this.match(TokenType.RBRACE)) {
      return {
        type: 'Dict',
        keys: [],
        values: [],
        line: startToken.line,
        column: startToken.column,
      };
    }

    const firstExpr = this.expression();

    // Set comprehension: {expr for ...}
    if (this.check(TokenType.FOR)) {
      const generators = this.comprehensionGenerators();
      this.consume(TokenType.RBRACE, "Expected '}' after set comprehension");
      return {
        type: 'SetComp',
        element: firstExpr,
        generators,
        line: startToken.line,
        column: startToken.column,
      };
    }

    // Dict: {key: value, ...} or dict comprehension: {k: v for ...}
    if (this.match(TokenType.COLON)) {
      const firstValue = this.expression();

      // Check for dict comprehension
      if (this.check(TokenType.FOR)) {
        const generators = this.comprehensionGenerators();
        this.consume(TokenType.RBRACE, "Expected '}' after dict comprehension");
        return {
          type: 'DictComp',
          key: firstExpr,
          value: firstValue,
          generators,
          line: startToken.line,
          column: startToken.column,
        };
      }

      // Regular dict
      const keys = [firstExpr];
      const values = [firstValue];

      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.RBRACE)) break;
        keys.push(this.expression());
        this.consume(TokenType.COLON, "Expected ':' after dict key");
        values.push(this.expression());
      }

      this.consume(TokenType.RBRACE, "Expected '}' after dict");
      return {
        type: 'Dict',
        keys,
        values,
        line: startToken.line,
        column: startToken.column,
      };
    }

    // Set literal: {expr, expr, ...} — but we don't have set literals yet,
    // so this is an error for now
    throw new SyntaxError("Expected ':' after dict key or 'for' for set comprehension", startToken.line, startToken.column);
  }

  private comprehensionGenerators(): Comprehension[] {
    const generators: Comprehension[] = [];

    while (this.match(TokenType.FOR)) {
      // Match for-loop semantics: allow tuple unpacking targets like `for k, v in items`
      // This reuses the same target parsing as `for` statements.
      const target = this.parseAssignmentTarget();
      this.consume(TokenType.IN, "Expected 'in' in comprehension");
      const iter = this.orExpr(); // Don't parse full expression to avoid 'if' ambiguity

      const conditions: Expression[] = [];
      while (this.match(TokenType.IF)) {
        conditions.push(this.orExpr());
      }

      generators.push({ target, iter, conditions });
    }

    return generators;
  }

  private postfix(expr: Expression): Expression {
    while (true) {
      // Function call
      if (this.match(TokenType.LPAREN)) {
        const { args, kwargs } = this.argumentList();
        this.consume(TokenType.RPAREN, "Expected ')' after arguments");
        expr = {
          type: 'Call',
          func: expr,
          args,
          kwargs,
          line: expr.line,
          column: expr.column,
        };
        continue;
      }

      // Subscript or slice
      if (this.match(TokenType.LBRACKET)) {
        expr = this.subscriptOrSlice(expr);
        continue;
      }

      // Attribute access
      if (this.match(TokenType.DOT)) {
        const attrToken = this.consume(TokenType.IDENTIFIER, "Expected attribute name");
        expr = {
          type: 'Attribute',
          object: expr,
          attr: attrToken.value as string,
          line: expr.line,
          column: expr.column,
        };
        continue;
      }

      break;
    }

    return expr;
  }

  private argumentList(): { args: Expression[]; kwargs: { name: string; value: Expression }[] } {
    const args: Expression[] = [];
    const kwargs: { name: string; value: Expression }[] = [];

    if (!this.check(TokenType.RPAREN)) {
      do {
        // Check for keyword argument
        if (this.check(TokenType.IDENTIFIER) && this.peekNext()?.type === TokenType.ASSIGN) {
          const nameToken = this.advance();
          this.advance(); // consume '='
          const value = this.expression();
          kwargs.push({ name: nameToken.value as string, value });
        } else {
          const first = this.expression();

          // Generator expression in call args: f(x for x in y if ...)
          // Python allows this without extra parentheses.
          if (this.check(TokenType.FOR)) {
            const generators = this.comprehensionGenerators();
            args.push({
              type: 'GeneratorExp',
              element: first,
              generators,
              line: first.line,
              column: first.column,
            });
          } else {
            args.push(first);
          }
        }
      } while (this.match(TokenType.COMMA));
    }

    return { args, kwargs };
  }

  private subscriptOrSlice(object: Expression): Expression {
    // Check for slice
    let lower: Expression | null = null;
    let upper: Expression | null = null;
    let step: Expression | null = null;
    let isSlice = false;

    // Parse lower bound
    if (!this.check(TokenType.COLON) && !this.check(TokenType.RBRACKET)) {
      lower = this.expression();
    }

    // Check for first colon (slice)
    if (this.match(TokenType.COLON)) {
      isSlice = true;

      // Parse upper bound
      if (!this.check(TokenType.COLON) && !this.check(TokenType.RBRACKET)) {
        upper = this.expression();
      }

      // Check for second colon (step)
      if (this.match(TokenType.COLON)) {
        if (!this.check(TokenType.RBRACKET)) {
          step = this.expression();
        }
      }
    }

    this.consume(TokenType.RBRACKET, "Expected ']' after subscript");

    if (isSlice) {
      return {
        type: 'Slice',
        object,
        lower,
        upper,
        step,
        line: object.line,
        column: object.column,
      };
    }

    return {
      type: 'Subscript',
      object,
      index: lower!,
      line: object.line,
      column: object.column,
    };
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
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): Token {
    if (!this.isAtEnd()) {
      this.pos++;
    }
    return this.previous();
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) {
      return this.advance();
    }

    const token = this.peek();
    throw new SyntaxError(message, token.line, token.column);
  }

  private consumeNewline(): void {
    // Newline is optional at EOF
    if (!this.isAtEnd() && !this.check(TokenType.DEDENT)) {
      if (this.check(TokenType.NEWLINE)) {
        this.advance();
      }
    }
  }
}

export function parse(source: string): Program {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parse();
}
