/**
 * Lexer/Tokenizer for Python
 * Converts source code into a stream of tokens
 */

import { Token, TokenType, KEYWORDS } from './tokens';
import { SyntaxError } from './errors';

export class Lexer {
  private source: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];
  private indentStack: number[] = [0];
  private atLineStart: boolean = true;
  private parenDepth: number = 0; // Track parentheses for implicit line continuation

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    while (!this.isAtEnd()) {
      this.scanToken();
    }

    // Emit any remaining DEDENTs at EOF
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.tokens.push(this.makeToken(TokenType.DEDENT, null));
    }

    // Add final NEWLINE if needed
    if (this.tokens.length > 0 && this.tokens[this.tokens.length - 1].type !== TokenType.NEWLINE) {
      this.tokens.push(this.makeToken(TokenType.NEWLINE, null));
    }

    this.tokens.push(this.makeToken(TokenType.EOF, null));
    return this.tokens;
  }

  private scanToken(): void {
    // Handle indentation at line start
    if (this.atLineStart && this.parenDepth === 0) {
      this.handleIndentation();
      this.atLineStart = false;
    }

    // Skip spaces and tabs (not at line start)
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.advance();
    }

    if (this.isAtEnd()) return;

    // Backslash line continuation
    if (this.peek() === '\\' && this.peekNext() === '\n') {
      this.advance(); // consume backslash
      this.advance(); // consume newline
      this.line++;
      this.column = 1;
      return;
    }

    const char = this.peek();

    // Comments
    if (char === '#') {
      this.skipComment();
      return;
    }

    // Newlines
    if (char === '\n') {
      this.handleNewline();
      return;
    }

    // Skip carriage return
    if (char === '\r') {
      this.advance();
      return;
    }

    // Numbers
    if (this.isDigit(char)) {
      this.number();
      return;
    }

    // F-strings (f"..." or f'...')
    if (char === 'f' && (this.peekNext() === '"' || this.peekNext() === "'")) {
      this.fstring();
      return;
    }

    // Strings
    if (char === '"' || char === "'") {
      this.string(char);
      return;
    }

    // Identifiers and keywords
    if (this.isAlpha(char)) {
      this.identifier();
      return;
    }

    // Operators and delimiters
    this.operator();
  }

  private handleIndentation(): void {
    let indent = 0;
    while (this.peek() === ' ' || this.peek() === '\t') {
      if (this.peek() === ' ') {
        indent++;
      } else {
        // Tab counts as moving to the next multiple of 8
        indent = Math.floor(indent / 8) * 8 + 8;
      }
      this.advance();
    }

    // Skip blank lines and comment-only lines
    if (this.peek() === '\n' || this.peek() === '#' || this.isAtEnd()) {
      return;
    }

    const currentIndent = this.indentStack[this.indentStack.length - 1];

    if (indent > currentIndent) {
      this.indentStack.push(indent);
      this.tokens.push(this.makeToken(TokenType.INDENT, null));
    } else if (indent < currentIndent) {
      while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > indent) {
        this.indentStack.pop();
        this.tokens.push(this.makeToken(TokenType.DEDENT, null));
      }
      if (this.indentStack[this.indentStack.length - 1] !== indent) {
        throw new SyntaxError('Inconsistent indentation', this.line, this.column);
      }
    }
  }

  private handleNewline(): void {
    // Don't emit NEWLINE inside parentheses (implicit line continuation)
    if (this.parenDepth === 0) {
      // Don't emit multiple NEWLINEs in a row
      if (this.tokens.length === 0 || this.tokens[this.tokens.length - 1].type !== TokenType.NEWLINE) {
        this.tokens.push(this.makeToken(TokenType.NEWLINE, null));
      }
    }
    this.advance();
    this.line++;
    this.column = 1;
    // Only mark as line start if not inside parentheses
    // (inside parens, newlines are implicit line continuation, not new logical lines)
    this.atLineStart = this.parenDepth === 0;
  }

  private skipComment(): void {
    while (this.peek() !== '\n' && !this.isAtEnd()) {
      this.advance();
    }
  }

  private number(): void {
    const startColumn = this.column;
    let numStr = '';

    // Check for 0x, 0o, 0b prefixes
    if (this.peek() === '0' && (this.peekNext() === 'x' || this.peekNext() === 'X' ||
                                 this.peekNext() === 'o' || this.peekNext() === 'O' ||
                                 this.peekNext() === 'b' || this.peekNext() === 'B')) {
      const prefix = this.peekNext().toLowerCase();
      this.advance(); // consume '0'
      this.advance(); // consume prefix char
      let digits = '';
      if (prefix === 'x') {
        while (this.isHexDigit(this.peek()) || this.peek() === '_') {
          if (this.peek() !== '_') digits += this.peek();
          this.advance();
        }
        this.tokens.push({ type: TokenType.NUMBER, value: parseInt(digits, 16), line: this.line, column: startColumn });
      } else if (prefix === 'o') {
        while (this.isOctDigit(this.peek()) || this.peek() === '_') {
          if (this.peek() !== '_') digits += this.peek();
          this.advance();
        }
        this.tokens.push({ type: TokenType.NUMBER, value: parseInt(digits, 8), line: this.line, column: startColumn });
      } else {
        while (this.peek() === '0' || this.peek() === '1' || this.peek() === '_') {
          if (this.peek() !== '_') digits += this.peek();
          this.advance();
        }
        this.tokens.push({ type: TokenType.NUMBER, value: parseInt(digits, 2), line: this.line, column: startColumn });
      }
      return;
    }

    while (this.isDigit(this.peek()) || this.peek() === '_') {
      if (this.peek() !== '_') numStr += this.peek();
      this.advance();
    }

    // Check for float
    if (this.peek() === '.' && this.isDigit(this.peekNext())) {
      numStr += this.advance(); // consume '.'
      while (this.isDigit(this.peek()) || this.peek() === '_') {
        if (this.peek() !== '_') numStr += this.peek();
        this.advance();
      }
    }

    // Scientific notation
    if (this.peek() === 'e' || this.peek() === 'E') {
      numStr += this.advance();
      if (this.peek() === '+' || this.peek() === '-') {
        numStr += this.advance();
      }
      while (this.isDigit(this.peek())) {
        numStr += this.advance();
      }
    }

    const value = numStr.includes('.') || numStr.includes('e') || numStr.includes('E')
      ? parseFloat(numStr)
      : parseInt(numStr, 10);

    this.tokens.push({
      type: TokenType.NUMBER,
      value,
      line: this.line,
      column: startColumn,
    });
  }

  private string(quote: string): void {
    const startColumn = this.column;
    const startLine = this.line;
    this.advance(); // consume opening quote

    // Check for triple-quoted string
    const isTriple = this.peek() === quote && this.peekNext() === quote;
    if (isTriple) {
      this.advance(); // consume second quote
      this.advance(); // consume third quote
    }

    let value = '';
    let terminated = false;
    
    while (!this.isAtEnd()) {
      if (isTriple) {
        if (this.peek() === quote && this.peekNext() === quote && this.peekAhead(2) === quote) {
          this.advance(); // consume first quote
          this.advance(); // consume second quote
          this.advance(); // consume third quote
          terminated = true;
          break;
        }
      } else {
        if (this.peek() === quote) {
          this.advance(); // consume closing quote
          terminated = true;
          break;
        }
        if (this.peek() === '\n') {
          throw new SyntaxError('Unterminated string literal', startLine, startColumn);
        }
      }

      // Handle escape sequences
      if (this.peek() === '\\') {
        this.advance(); // consume backslash
        const escaped = this.advance();
        switch (escaped) {
          case 'n': value += '\n'; break;
          case 't': value += '\t'; break;
          case 'r': value += '\r'; break;
          case '\\': value += '\\'; break;
          case "'": value += "'"; break;
          case '"': value += '"'; break;
          default: value += escaped; break;
        }
      } else {
        if (this.peek() === '\n') {
          this.line++;
          this.column = 0;
        }
        value += this.advance();
      }
    }

    if (!terminated) {
      throw new SyntaxError('Unterminated string literal', startLine, startColumn);
    }

    // Implicit string concatenation: merge with previous string token
    const prev = this.tokens[this.tokens.length - 1];
    if (prev && prev.type === TokenType.STRING) {
      prev.value = (prev.value as string) + value;
    } else {
      this.tokens.push({
        type: TokenType.STRING,
        value,
        line: startLine,
        column: startColumn,
      });
    }
  }

  private fstring(): void {
    const startColumn = this.column;
    const startLine = this.line;
    
    this.advance(); // consume 'f'
    const quote = this.advance(); // consume opening quote
    
    // Check for triple-quoted f-string
    const isTriple = this.peek() === quote && this.peekNext() === quote;
    if (isTriple) {
      this.advance(); // consume second quote
      this.advance(); // consume third quote
    }
    
    const parts: { text: string; expr: string | null; formatSpec?: string }[] = [];
    let currentText = '';
    let terminated = false;
    
    while (!this.isAtEnd()) {
      // Check for end of string
      if (isTriple) {
        if (this.peek() === quote && this.peekNext() === quote && this.peekAhead(2) === quote) {
          this.advance();
          this.advance();
          this.advance();
          terminated = true;
          break;
        }
      } else {
        if (this.peek() === quote) {
          this.advance();
          terminated = true;
          break;
        }
        if (this.peek() === '\n') {
          throw new SyntaxError('Unterminated f-string literal', startLine, startColumn);
        }
      }
      
      // Handle escaped braces {{ and }}
      if (this.peek() === '{' && this.peekNext() === '{') {
        currentText += '{';
        this.advance();
        this.advance();
        continue;
      }
      if (this.peek() === '}' && this.peekNext() === '}') {
        currentText += '}';
        this.advance();
        this.advance();
        continue;
      }
      
      // Handle expression placeholder {expr}
      if (this.peek() === '{') {
        // Save current text part
        if (currentText.length > 0 || parts.length === 0) {
          parts.push({ text: currentText, expr: null });
          currentText = '';
        }
        
        this.advance(); // consume '{'
        
        // Read expression until matching '}'
        let expr = '';
        let braceDepth = 1;
        while (!this.isAtEnd() && braceDepth > 0) {
          const ch = this.peek();
          if (ch === '{') {
            braceDepth++;
            expr += this.advance();
          } else if (ch === '}') {
            braceDepth--;
            if (braceDepth > 0) {
              expr += this.advance();
            } else {
              this.advance(); // consume closing '}'
            }
          } else if (ch === '"' || ch === "'") {
            // String literal inside expression — consume it whole
            const strQuote = this.advance();
            expr += strQuote;
            while (!this.isAtEnd() && this.peek() !== strQuote) {
              if (this.peek() === '\\') {
                expr += this.advance(); // backslash
                if (!this.isAtEnd()) expr += this.advance(); // escaped char
              } else {
                expr += this.advance();
              }
            }
            if (!this.isAtEnd()) {
              expr += this.advance(); // closing quote
            }
          } else {
            expr += this.advance();
          }
        }
        
        if (braceDepth > 0) {
          throw new SyntaxError('Unterminated expression in f-string', startLine, startColumn);
        }
        
        // Split format spec from expression (e.g. "x:.2f" → expr="x", fmt=".2f")
        let exprStr = expr.trim();
        let formatSpec: string | undefined;
        let colonIdx = -1;
        let depth = 0;
        let inStr: string | null = null;
        for (let ci = 0; ci < exprStr.length; ci++) {
          const cc = exprStr[ci];
          if (inStr) {
            if (cc === '\\') { ci++; continue; }
            if (cc === inStr) inStr = null;
            continue;
          }
          if (cc === '"' || cc === "'") { inStr = cc; continue; }
          if (cc === '(' || cc === '[' || cc === '{') { depth++; continue; }
          if (cc === ')' || cc === ']' || cc === '}') { depth--; continue; }
          if (cc === ':' && depth === 0) { colonIdx = ci; break; }
        }
        if (colonIdx >= 0) {
          formatSpec = exprStr.slice(colonIdx + 1);
          exprStr = exprStr.slice(0, colonIdx).trim();
        }

        // Add expression part
        parts.push({ text: '', expr: exprStr, formatSpec });
        continue;
      }
      
      // Handle escape sequences
      if (this.peek() === '\\') {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case 'n': currentText += '\n'; break;
          case 't': currentText += '\t'; break;
          case 'r': currentText += '\r'; break;
          case '\\': currentText += '\\'; break;
          case "'": currentText += "'"; break;
          case '"': currentText += '"'; break;
          default: currentText += escaped; break;
        }
      } else {
        if (this.peek() === '\n') {
          this.line++;
          this.column = 0;
        }
        currentText += this.advance();
      }
    }
    
    if (!terminated) {
      throw new SyntaxError('Unterminated f-string literal', startLine, startColumn);
    }
    
    // Add any remaining text
    if (currentText.length > 0 || parts.length === 0) {
      parts.push({ text: currentText, expr: null });
    }
    
    this.tokens.push({
      type: TokenType.FSTRING,
      value: null,
      line: startLine,
      column: startColumn,
      fstringParts: parts,
    });
  }

  private identifier(): void {
    const startColumn = this.column;
    let name = '';

    while (this.isAlphaNumeric(this.peek())) {
      name += this.advance();
    }

    const type = KEYWORDS[name] ?? TokenType.IDENTIFIER;
    this.tokens.push({
      type,
      value: type === TokenType.IDENTIFIER ? name : null,
      line: this.line,
      column: startColumn,
    });
  }

  private operator(): void {
    const startColumn = this.column;
    const char = this.advance();

    // Two-character operators
    const next = this.peek();
    let type: TokenType;
    let consumed = false;

    switch (char) {
      case '+':
        if (next === '=') { this.advance(); type = TokenType.PLUS_ASSIGN; consumed = true; }
        else { type = TokenType.PLUS; }
        break;
      case '-':
        if (next === '=') { this.advance(); type = TokenType.MINUS_ASSIGN; consumed = true; }
        else { type = TokenType.MINUS; }
        break;
      case '*':
        if (next === '*') {
          this.advance();
          if (this.peek() === '=') { this.advance(); type = TokenType.DOUBLE_STAR_ASSIGN; }
          else { type = TokenType.DOUBLE_STAR; }
          consumed = true;
        }
        else if (next === '=') { this.advance(); type = TokenType.STAR_ASSIGN; consumed = true; }
        else { type = TokenType.STAR; }
        break;
      case '/':
        if (next === '/') {
          this.advance();
          if (this.peek() === '=') { this.advance(); type = TokenType.DOUBLE_SLASH_ASSIGN; }
          else { type = TokenType.DOUBLE_SLASH; }
          consumed = true;
        }
        else if (next === '=') { this.advance(); type = TokenType.SLASH_ASSIGN; consumed = true; }
        else { type = TokenType.SLASH; }
        break;
      case '%':
        if (next === '=') { this.advance(); type = TokenType.PERCENT_ASSIGN; consumed = true; }
        else { type = TokenType.PERCENT; }
        break;
      case '=':
        if (next === '=') { this.advance(); type = TokenType.EQ; consumed = true; }
        else { type = TokenType.ASSIGN; }
        break;
      case '!':
        if (next === '=') { this.advance(); type = TokenType.NE; consumed = true; }
        else { throw new SyntaxError(`Unexpected character '${char}'`, this.line, startColumn); }
        break;
      case '<':
        if (next === '<') { this.advance(); type = TokenType.LSHIFT; consumed = true; }
        else if (next === '=') { this.advance(); type = TokenType.LE; consumed = true; }
        else { type = TokenType.LT; }
        break;
      case '>':
        if (next === '>') { this.advance(); type = TokenType.RSHIFT; consumed = true; }
        else if (next === '=') { this.advance(); type = TokenType.GE; consumed = true; }
        else { type = TokenType.GT; }
        break;
      case '&':
        type = TokenType.AMPERSAND;
        break;
      case '|':
        type = TokenType.PIPE;
        break;
      case '^':
        type = TokenType.CARET;
        break;
      case '~':
        type = TokenType.TILDE;
        break;
      case '@':
        type = TokenType.AT;
        break;
      case '(':
        type = TokenType.LPAREN;
        this.parenDepth++;
        break;
      case ')':
        type = TokenType.RPAREN;
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        break;
      case '[':
        type = TokenType.LBRACKET;
        this.parenDepth++;
        break;
      case ']':
        type = TokenType.RBRACKET;
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        break;
      case '{':
        type = TokenType.LBRACE;
        this.parenDepth++;
        break;
      case '}':
        type = TokenType.RBRACE;
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        break;
      case ',':
        type = TokenType.COMMA;
        break;
      case ':':
        if (this.peek() === '=') {
          this.advance();
          type = TokenType.WALRUS;
        } else {
          type = TokenType.COLON;
        }
        break;
      case '.':
        type = TokenType.DOT;
        break;
      default:
        throw new SyntaxError(`Unexpected character '${char}'`, this.line, startColumn);
    }

    this.tokens.push({
      type,
      value: null,
      line: this.line,
      column: startColumn,
    });
  }

  private makeToken(type: TokenType, value: string | number | null): Token {
    return {
      type,
      value,
      line: this.line,
      column: this.column,
    };
  }

  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(): string {
    if (this.isAtEnd()) return '\0';
    return this.source[this.pos];
  }

  private peekNext(): string {
    if (this.pos + 1 >= this.source.length) return '\0';
    return this.source[this.pos + 1];
  }

  private peekAhead(n: number): string {
    if (this.pos + n >= this.source.length) return '\0';
    return this.source[this.pos + n];
  }

  private advance(): string {
    const char = this.source[this.pos];
    this.pos++;
    this.column++;
    return char;
  }

  private isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
  }

  private isAlpha(char: string): boolean {
    return (char >= 'a' && char <= 'z') ||
           (char >= 'A' && char <= 'Z') ||
           char === '_';
  }

  private isHexDigit(char: string): boolean {
    return (char >= '0' && char <= '9') ||
           (char >= 'a' && char <= 'f') ||
           (char >= 'A' && char <= 'F');
  }

  private isOctDigit(char: string): boolean {
    return char >= '0' && char <= '7';
  }

  private isAlphaNumeric(char: string): boolean {
    return this.isAlpha(char) || this.isDigit(char);
  }
}

export function tokenize(source: string): Token[] {
  const lexer = new Lexer(source);
  return lexer.tokenize();
}

