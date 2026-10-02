/**
 * Lexer/Tokenizer for Python
 * Converts source code into a stream of tokens
 */

import { Token, TokenType, KEYWORDS, FStringTokenPart } from './tokens';
import { SyntaxError } from './errors';
import { parseIntString } from './numbers';

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
    if (this.peek() === '\\' && (this.peekNext() === '\n' || (this.peekNext() === '\r' && this.peekAhead(2) === '\n'))) {
      this.advance(); // consume backslash
      if (this.peek() === '\r') this.advance();
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

    // Numbers (including a leading-dot float like .5)
    if (this.isDigit(char) || (char === '.' && this.isDigit(this.peekNext()))) {
      this.number();
      return;
    }

    // u"..." is a plain string; b"..." has no equivalent here.
    if ((char === 'u' || char === 'U') && (this.peekNext() === '"' || this.peekNext() === "'")) {
      this.advance();
      this.string(this.peek());
      return;
    }
    if (char === 'b' || char === 'B' || ((char === 'r' || char === 'R') && (this.peekNext() === 'b' || this.peekNext() === 'B'))) {
      const afterPrefix = char === 'b' || char === 'B'
        ? (this.peekNext() === 'r' || this.peekNext() === 'R' ? this.peekAhead(2) : this.peekNext())
        : this.peekAhead(2);
      if (afterPrefix === '"' || afterPrefix === "'") {
        throw new SyntaxError('bytes literals are not supported in this sandbox — use a regular str', this.line, this.column);
      }
    }

    // String prefixes: f"...", r"...", rf"..."/fr"..." (case-insensitive)
    if (char === 'f' || char === 'F' || char === 'r' || char === 'R') {
      const prefixChar = char === 'f' || char === 'F' ? 'f' : 'r';
      const next = this.peekNext();
      if (next === '"' || next === "'") {
        if (prefixChar === 'f') {
          this.fstring();
        } else {
          this.advance(); // consume 'r'
          this.string(next, true);
        }
        return;
      }
      const nextLower = next.toLowerCase();
      // Two-char prefix: rf"..." or fr"..." — a raw f-string
      if ((nextLower === 'f' || nextLower === 'r') && nextLower !== prefixChar) {
        const quote = this.peekAhead(2);
        if (quote === '"' || quote === "'") {
          this.advance(); // consume first prefix char; fstring() consumes the second
          this.fstring(true);
          return;
        }
      }
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

    // Semicolon separates simple statements on one line (a = 1; b = 2).
    // Emits a logical-line break without touching indentation, so the rest
    // of the line stays in the same block. Illegal inside parentheses.
    if (char === ';') {
      if (this.parenDepth > 0) {
        throw new SyntaxError(`Unexpected character ';'`, this.line, this.column);
      }
      if (this.tokens.length === 0 || this.tokens[this.tokens.length - 1].type !== TokenType.NEWLINE) {
        this.tokens.push(this.makeToken(TokenType.NEWLINE, ';'));
      }
      this.advance();
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
      const last = this.tokens[this.tokens.length - 1];
      if (!last || last.type !== TokenType.NEWLINE) {
        this.tokens.push(this.makeToken(TokenType.NEWLINE, null));
      } else {
        // A `;` right before the line break ends the line, not just a statement.
        last.value = null;
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
    const start = this.pos;
    const push = (value: number | bigint, isFloat: boolean) => {
      this.tokens.push({ type: TokenType.NUMBER, value, isFloat, line: this.line, column: startColumn });
    };

    // 0x / 0o / 0b prefixed ints
    if (this.peek() === '0' && 'xXoObB'.includes(this.peekNext())) {
      this.advance();
      this.advance();
      while (this.isHexDigit(this.peek()) || this.peek() === '_') this.advance();
      const text = this.source.slice(start, this.pos);
      const value = parseIntString(text, 0);
      if (value === undefined) throw new SyntaxError(`invalid number literal '${text}'`, this.line, startColumn);
      push(value, false);
      return;
    }

    let isFloat = false;
    while (this.isDigit(this.peek()) || this.peek() === '_') this.advance();

    // Fraction: `1.5`, `.5`, and a bare trailing dot (`1.`), but not `1.real`.
    if (this.peek() === '.' && !this.isAlpha(this.peekNext()) && this.peekNext() !== '.') {
      isFloat = true;
      this.advance();
      while (this.isDigit(this.peek()) || this.peek() === '_') this.advance();
    }

    // Exponent, only when digits actually follow (`1e5`, `1e-5`)
    if (this.peek() === 'e' || this.peek() === 'E') {
      const sign = this.peekNext() === '+' || this.peekNext() === '-';
      if (this.isDigit(sign ? this.peekAhead(2) : this.peekNext())) {
        isFloat = true;
        this.advance();
        if (sign) this.advance();
        while (this.isDigit(this.peek()) || this.peek() === '_') this.advance();
      }
    }

    const text = this.source.slice(start, this.pos);
    if (isFloat) {
      push(Number(text.replace(/_/g, '')), true);
    } else {
      const value = parseIntString(text, 10);
      if (value === undefined) throw new SyntaxError(`invalid number literal '${text}'`, this.line, startColumn);
      push(value, false);
    }
  }

  /** Decodes the escape after a backslash that has just been consumed.
   *  Unknown escapes keep their backslash, like CPython ("\\d" stays `\\d`). */
  private readEscape(): string {
    const c = this.advance();
    switch (c) {
      case '\n': this.line++; this.column = 1; return '';
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case 'x': case 'u': case 'U': {
        const len = c === 'x' ? 2 : c === 'u' ? 4 : 8;
        const hex = this.source.slice(this.pos, this.pos + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new SyntaxError(`truncated \\${c} escape`, this.line, this.column);
        }
        for (let i = 0; i < len; i++) this.advance();
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) throw new SyntaxError('illegal Unicode character', this.line, this.column);
        return String.fromCodePoint(code);
      }
      case 'N':
        throw new SyntaxError('\\N{...} named escapes are not supported in this sandbox — use \\uXXXX', this.line, this.column);
      default:
        if (c >= '0' && c <= '7') {
          let oct = c;
          while (oct.length < 3 && this.peek() >= '0' && this.peek() <= '7') oct += this.advance();
          return String.fromCharCode(parseInt(oct, 8));
        }
        return '\\' + c;
    }
  }

  private string(quote: string, raw = false): void {
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

      // Handle escape sequences. In raw strings the backslash is kept
      // literally, but still consumes the next char so r"a\"b" works
      // (a backslash can't be the last character, like CPython).
      if (this.peek() === '\\') {
        this.advance(); // consume backslash
        if (raw) {
          if (this.peek() === '\n') { this.line++; this.column = 0; }
          value += '\\' + this.advance();
        } else {
          value += this.readEscape();
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

  private fstring(raw = false): void {
    const startColumn = this.column;
    const startLine = this.line;

    this.advance(); // consume 'f' (or the second char of an rf/fr prefix)
    const quote = this.advance(); // consume opening quote
    
    // Check for triple-quoted f-string
    const isTriple = this.peek() === quote && this.peekNext() === quote;
    if (isTriple) {
      this.advance(); // consume second quote
      this.advance(); // consume third quote
    }
    
    const parts: FStringTokenPart[] = [];
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
        
        const split = splitFStringField(expr);
        if (split.debugText !== undefined) parts.push({ text: split.debugText, expr: null });
        parts.push({ text: '', expr: split.expr, formatSpec: split.formatSpec, conversion: split.conversion });
        continue;
      }
      
      // Handle escape sequences (kept literal in raw f-strings)
      if (this.peek() === '\\') {
        this.advance();
        if (raw) {
          currentText += '\\' + this.advance();
        } else {
          currentText += this.readEscape();
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

    const type = Object.hasOwn(KEYWORDS, name) ? KEYWORDS[name] : TokenType.IDENTIFIER;
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

    switch (char) {
      case '+':
        if (next === '=') { this.advance(); type = TokenType.PLUS_ASSIGN; }
        else { type = TokenType.PLUS; }
        break;
      case '-':
        if (next === '=') { this.advance(); type = TokenType.MINUS_ASSIGN; }
        else if (next === '>') { this.advance(); type = TokenType.ARROW; }
        else { type = TokenType.MINUS; }
        break;
      case '*':
        if (next === '*') {
          this.advance();
          if (this.peek() === '=') { this.advance(); type = TokenType.DOUBLE_STAR_ASSIGN; }
          else { type = TokenType.DOUBLE_STAR; }
         
        }
        else if (next === '=') { this.advance(); type = TokenType.STAR_ASSIGN; }
        else { type = TokenType.STAR; }
        break;
      case '/':
        if (next === '/') {
          this.advance();
          if (this.peek() === '=') { this.advance(); type = TokenType.DOUBLE_SLASH_ASSIGN; }
          else { type = TokenType.DOUBLE_SLASH; }
         
        }
        else if (next === '=') { this.advance(); type = TokenType.SLASH_ASSIGN; }
        else { type = TokenType.SLASH; }
        break;
      case '%':
        if (next === '=') { this.advance(); type = TokenType.PERCENT_ASSIGN; }
        else { type = TokenType.PERCENT; }
        break;
      case '=':
        if (next === '=') { this.advance(); type = TokenType.EQ; }
        else { type = TokenType.ASSIGN; }
        break;
      case '!':
        if (next === '=') { this.advance(); type = TokenType.NE; }
        else { throw new SyntaxError(`Unexpected character '${char}'`, this.line, startColumn); }
        break;
      case '<':
        if (next === '<') {
          this.advance();
          if (this.peek() === '=') { this.advance(); type = TokenType.LSHIFT_ASSIGN; }
          else { type = TokenType.LSHIFT; }
         
        }
        else if (next === '=') { this.advance(); type = TokenType.LE; }
        else { type = TokenType.LT; }
        break;
      case '>':
        if (next === '>') {
          this.advance();
          if (this.peek() === '=') { this.advance(); type = TokenType.RSHIFT_ASSIGN; }
          else { type = TokenType.RSHIFT; }
         
        }
        else if (next === '=') { this.advance(); type = TokenType.GE; }
        else { type = TokenType.GT; }
        break;
      case '&':
        if (next === '=') { this.advance(); type = TokenType.AMPERSAND_ASSIGN; }
        else { type = TokenType.AMPERSAND; }
        break;
      case '|':
        if (next === '=') { this.advance(); type = TokenType.PIPE_ASSIGN; }
        else { type = TokenType.PIPE; }
        break;
      case '^':
        if (next === '=') { this.advance(); type = TokenType.CARET_ASSIGN; }
        else { type = TokenType.CARET; }
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
        if (next === '.' && this.peekNext() === '.') {
          this.advance();
          this.advance();
          type = TokenType.ELLIPSIS;
        } else {
          type = TokenType.DOT;
        }
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

  private makeToken(type: TokenType, value: string | null): Token {
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
           char === '_' ||
           char > '\x7f';
  }

  private isHexDigit(char: string): boolean {
    return (char >= '0' && char <= '9') ||
           (char >= 'a' && char <= 'f') ||
           (char >= 'A' && char <= 'F');
  }

  private isAlphaNumeric(char: string): boolean {
    return this.isAlpha(char) || this.isDigit(char);
  }
}

/**
 * Splits the text inside an f-string `{...}` into its expression, optional
 * `!r`-style conversion and optional format spec. `{x=}` also yields the
 * literal `x=` text to print before the value, and defaults to repr.
 */
function splitFStringField(raw: string): { expr: string; formatSpec?: string; conversion?: string; debugText?: string } {
  let depth = 0;
  let inStr: string | null = null;
  let exprEnd = raw.length;
  let conversion: string | undefined;
  let formatSpec: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (c === '!' && raw[i + 1] !== '=') {
      exprEnd = i;
      const colon = raw.indexOf(':', i);
      conversion = raw.slice(i + 1, colon >= 0 ? colon : undefined).trim();
      if (colon >= 0) formatSpec = raw.slice(colon + 1);
      break;
    }
    if (c === ':') {
      exprEnd = i;
      formatSpec = raw.slice(i + 1);
      break;
    }
  }
  let exprText = raw.slice(0, exprEnd);
  let debugText: string | undefined;
  if (/=\s*$/.test(exprText) && !/[=!<>]=\s*$/.test(exprText)) {
    debugText = exprText;
    exprText = exprText.replace(/=\s*$/, '');
    if (conversion === undefined && formatSpec === undefined) conversion = 'r';
  }
  return { expr: exprText.trim(), formatSpec, conversion, debugText };
}

export function tokenize(source: string): Token[] {
  const lexer = new Lexer(source);
  return lexer.tokenize();
}

