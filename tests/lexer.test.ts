import { describe, test, expect } from 'bun:test';
import { tokenize, TokenType } from '../src';

describe('Lexer', () => {
  describe('Numbers', () => {
    test('integer', () => {
      const tokens = tokenize('42');
      expect(tokens[0].type).toBe(TokenType.NUMBER);
      expect(tokens[0].value).toBe(42);
    });

    test('float', () => {
      const tokens = tokenize('3.14');
      expect(tokens[0].type).toBe(TokenType.NUMBER);
      expect(tokens[0].value).toBe(3.14);
    });

    test('scientific notation', () => {
      const tokens = tokenize('1e10');
      expect(tokens[0].type).toBe(TokenType.NUMBER);
      expect(tokens[0].value).toBe(1e10);
    });

    test('negative exponent', () => {
      const tokens = tokenize('1e-5');
      expect(tokens[0].type).toBe(TokenType.NUMBER);
      expect(tokens[0].value).toBe(1e-5);
    });
  });

  describe('Strings', () => {
    test('double quoted', () => {
      const tokens = tokenize('"hello"');
      expect(tokens[0].type).toBe(TokenType.STRING);
      expect(tokens[0].value).toBe('hello');
    });

    test('single quoted', () => {
      const tokens = tokenize("'world'");
      expect(tokens[0].type).toBe(TokenType.STRING);
      expect(tokens[0].value).toBe('world');
    });

    test('escape sequences', () => {
      const tokens = tokenize('"hello\\nworld"');
      expect(tokens[0].value).toBe('hello\nworld');
    });

    test('escaped quotes', () => {
      const tokens = tokenize('"say \\"hi\\""');
      expect(tokens[0].value).toBe('say "hi"');
    });

    test('triple quoted', () => {
      const tokens = tokenize('"""multi\nline"""');
      expect(tokens[0].type).toBe(TokenType.STRING);
      expect(tokens[0].value).toBe('multi\nline');
    });
  });

  describe('Identifiers and Keywords', () => {
    test('identifier', () => {
      const tokens = tokenize('foo_bar');
      expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
      expect(tokens[0].value).toBe('foo_bar');
    });

    test('keywords', () => {
      const keywords = ['if', 'elif', 'else', 'for', 'while', 'in', 'def', 'return'];
      for (const kw of keywords) {
        const tokens = tokenize(kw);
        expect(tokens[0].type).toBe(kw.toUpperCase() as TokenType);
      }
    });

    test('True/False/None', () => {
      expect(tokenize('True')[0].type).toBe(TokenType.TRUE);
      expect(tokenize('False')[0].type).toBe(TokenType.FALSE);
      expect(tokenize('None')[0].type).toBe(TokenType.NONE);
    });
  });

  describe('Operators', () => {
    test('arithmetic', () => {
      const tokens = tokenize('+ - * / // % **');
      expect(tokens[0].type).toBe(TokenType.PLUS);
      expect(tokens[1].type).toBe(TokenType.MINUS);
      expect(tokens[2].type).toBe(TokenType.STAR);
      expect(tokens[3].type).toBe(TokenType.SLASH);
      expect(tokens[4].type).toBe(TokenType.DOUBLE_SLASH);
      expect(tokens[5].type).toBe(TokenType.PERCENT);
      expect(tokens[6].type).toBe(TokenType.DOUBLE_STAR);
    });

    test('comparison', () => {
      const tokens = tokenize('== != < > <= >=');
      expect(tokens[0].type).toBe(TokenType.EQ);
      expect(tokens[1].type).toBe(TokenType.NE);
      expect(tokens[2].type).toBe(TokenType.LT);
      expect(tokens[3].type).toBe(TokenType.GT);
      expect(tokens[4].type).toBe(TokenType.LE);
      expect(tokens[5].type).toBe(TokenType.GE);
    });

    test('assignment', () => {
      const tokens = tokenize('= += -= *= /=');
      expect(tokens[0].type).toBe(TokenType.ASSIGN);
      expect(tokens[1].type).toBe(TokenType.PLUS_ASSIGN);
      expect(tokens[2].type).toBe(TokenType.MINUS_ASSIGN);
      expect(tokens[3].type).toBe(TokenType.STAR_ASSIGN);
      expect(tokens[4].type).toBe(TokenType.SLASH_ASSIGN);
    });
  });

  describe('Delimiters', () => {
    test('brackets', () => {
      const tokens = tokenize('( ) [ ] { }');
      expect(tokens[0].type).toBe(TokenType.LPAREN);
      expect(tokens[1].type).toBe(TokenType.RPAREN);
      expect(tokens[2].type).toBe(TokenType.LBRACKET);
      expect(tokens[3].type).toBe(TokenType.RBRACKET);
      expect(tokens[4].type).toBe(TokenType.LBRACE);
      expect(tokens[5].type).toBe(TokenType.RBRACE);
    });

    test('punctuation', () => {
      const tokens = tokenize(', : .');
      expect(tokens[0].type).toBe(TokenType.COMMA);
      expect(tokens[1].type).toBe(TokenType.COLON);
      expect(tokens[2].type).toBe(TokenType.DOT);
    });
  });

  describe('Indentation', () => {
    test('simple indent', () => {
      const tokens = tokenize('if x:\n    y');
      const types = tokens.map(t => t.type);
      expect(types).toContain(TokenType.INDENT);
    });

    test('indent and dedent', () => {
      const code = `if x:
    y = 1
z = 2`;
      const tokens = tokenize(code);
      const types = tokens.map(t => t.type);
      expect(types).toContain(TokenType.INDENT);
      expect(types).toContain(TokenType.DEDENT);
    });

    test('nested indentation', () => {
      const code = `if x:
    if y:
        z = 1
    w = 2
v = 3`;
      const tokens = tokenize(code);
      const indents = tokens.filter(t => t.type === TokenType.INDENT).length;
      const dedents = tokens.filter(t => t.type === TokenType.DEDENT).length;
      expect(indents).toBe(2);
      expect(dedents).toBe(2);
    });
  });

  describe('Comments', () => {
    test('line comment', () => {
      const tokens = tokenize('x = 1 # this is a comment\ny = 2');
      const identifiers = tokens.filter(t => t.type === TokenType.IDENTIFIER);
      expect(identifiers.length).toBe(2);
      expect(identifiers[0].value).toBe('x');
      expect(identifiers[1].value).toBe('y');
    });

    test('comment only line', () => {
      const tokens = tokenize('# just a comment');
      expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
    });
  });

  describe('Implicit Line Continuation', () => {
    test('inside parentheses', () => {
      const code = `func(
    a,
    b
)`;
      const tokens = tokenize(code);
      // Should not have NEWLINE tokens inside the parentheses
      const newlines = tokens.filter(t => t.type === TokenType.NEWLINE);
      expect(newlines.length).toBeLessThan(3);
    });

    test('inside brackets', () => {
      const code = `[
    1,
    2
]`;
      const tokens = tokenize(code);
      const newlines = tokens.filter(t => t.type === TokenType.NEWLINE);
      expect(newlines.length).toBeLessThan(3);
    });

    test('multi-line if condition in parentheses should not emit DEDENT before colon', () => {
      const code = `for x in items:
    if (a and
        b and
        c):
        y = 1`;
      const tokens = tokenize(code);
      const types = tokens.map(t => t.type);

      // Find the RPAREN that closes the if condition
      const rparenIndex = types.indexOf(TokenType.RPAREN);
      // The next token should be COLON, not DEDENT
      expect(types[rparenIndex + 1]).toBe(TokenType.COLON);
    });

    test('multi-line if with slice syntax in parentheses', () => {
      const code = `for deal in deals:
    if (deal["closeDate"] and
        deal["closeDate"][:4] == "2025"):
        x = 1`;
      const tokens = tokenize(code);
      const types = tokens.map(t => t.type);

      // Find the last RPAREN (closes the if condition parens)
      let lastRparenIndex = -1;
      for (let i = 0; i < types.length; i++) {
        if (types[i] === TokenType.RPAREN) {
          lastRparenIndex = i;
        }
      }
      // The next token after closing paren should be COLON, not DEDENT
      expect(types[lastRparenIndex + 1]).toBe(TokenType.COLON);
    });

    test('nested brackets inside parentheses maintain line continuation', () => {
      const code = `if (items[0] and
        items[1]):
    pass`;
      const tokens = tokenize(code);
      const types = tokens.map(t => t.type);

      // Find the RPAREN
      const rparenIndex = types.lastIndexOf(TokenType.RPAREN);
      // Should be followed by COLON
      expect(types[rparenIndex + 1]).toBe(TokenType.COLON);
    });
  });

  describe('Complex Expressions', () => {
    test('assignment', () => {
      const tokens = tokenize('x = 42');
      expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
      expect(tokens[0].value).toBe('x');
      expect(tokens[1].type).toBe(TokenType.ASSIGN);
      expect(tokens[2].type).toBe(TokenType.NUMBER);
      expect(tokens[2].value).toBe(42);
    });

    test('function call', () => {
      const tokens = tokenize('print("hello")');
      expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
      expect(tokens[1].type).toBe(TokenType.LPAREN);
      expect(tokens[2].type).toBe(TokenType.STRING);
      expect(tokens[3].type).toBe(TokenType.RPAREN);
    });

    test('list literal', () => {
      const tokens = tokenize('[1, 2, 3]');
      expect(tokens[0].type).toBe(TokenType.LBRACKET);
      expect(tokens[1].type).toBe(TokenType.NUMBER);
      expect(tokens[2].type).toBe(TokenType.COMMA);
    });

    test('dict literal', () => {
      const tokens = tokenize("{'a': 1}");
      expect(tokens[0].type).toBe(TokenType.LBRACE);
      expect(tokens[1].type).toBe(TokenType.STRING);
      expect(tokens[2].type).toBe(TokenType.COLON);
      expect(tokens[3].type).toBe(TokenType.NUMBER);
      expect(tokens[4].type).toBe(TokenType.RBRACE);
    });
  });
});

