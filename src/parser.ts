
import {
  ReferenceTypeExpression,
  SourceFile,
  SourceFileElement,
  StructDeclaration,
  StructDeclarationField,
  SyntaxKind,
  Token,
  TokenKind,
  Expression,
  TypeExpression,
  ConstantExpression,
  ReferenceExpression,
  Dot,
  Identifier,
  TupleExpression,
  PrefixExpression,
  ExpressionStatement,
  ImportDeclaration,
  Param,
  Pattern,
  BindPattern,
  LetDeclaration,
  TypeAssert,
  ExprBody,
  BlockBody,
  QualifiedName,
  NestedExpression,
  NamedTuplePattern,
  StructPattern,
  VariadicStructPatternElement,
  PunnedStructPatternField,
  StructPatternField,
  TuplePattern,
  InfixExpression,
  TextFile,
  CallExpression,
  NamedTupleExpression,
  LetBodyElement,
  ReturnStatement,
  StructExpression,
  StructExpressionField,
  PunnedStructExpressionField,
  IfStatementCase,
  IfStatement,
  MemberExpression,
  IdentifierAlt,
  WrappedOperator,
  ArrowTypeExpression,
} from "./cst"
import { Stream } from "./util";

export class ParseError extends Error {

  public constructor(
    public file: TextFile,
    public actual: Token,
    public expected: SyntaxKind[],
  ) {
    super(`Uncaught parse error`);
  }

}

function isBinaryOperatorLike(token: Token): boolean {
  return token.kind === SyntaxKind.CustomOperator;
}

function isPrefixOperatorLike(token: Token): boolean {
  return token.kind === SyntaxKind.CustomOperator;
}

const enum OperatorMode {
  None   = 0,
  Prefix = 1,
  InfixL = 2,
  InfixR = 4,
  Infix = 6,
  Suffix = 8,
}

interface OperatorInfo {
  name: string,
  mode: OperatorMode,
  precedence: number,
}

const EXPR_OPERATOR_TABLE: Array<[string, OperatorMode, number]> = [
  ["**", OperatorMode.InfixR, 11],
  ["*", OperatorMode.InfixL, 8],
  ["/", OperatorMode.InfixL, 8],
  ["+", OperatorMode.InfixL, 7],
  ["-", OperatorMode.InfixL, 7],
  ["<", OperatorMode.InfixL, 6],
  [">", OperatorMode.InfixL, 6],
  ["<=", OperatorMode.InfixL, 5],
  [">=", OperatorMode.InfixL, 5],
  ["==", OperatorMode.InfixL, 5],
  ["!=", OperatorMode.InfixL, 5],
  ["<*", OperatorMode.InfixL, 4],
  [":", OperatorMode.InfixL, 3],
  ["<|>", OperatorMode.InfixL, 2],
  ["<?>", OperatorMode.InfixL, 1],
  ["$", OperatorMode.InfixR, 0]
];

export class Parser {

  private prefixExprOperators = new Set<string>();
  private binaryExprOperators = new Map<string, OperatorInfo>();
  private suffixExprOperators = new Set<string>();

  public constructor(
    public file: TextFile,
    public tokens: Stream<Token>,
  ) {
    for (const [name, mode, precedence] of EXPR_OPERATOR_TABLE) {
      this.binaryExprOperators.set(name, { name, mode, precedence });
    }
  }

  private getToken(): Token {
    return this.tokens.get();
  }

  private peekToken(offset = 1): Token {
    return this.tokens.peek(offset);
  }

  private assertToken<K extends Token['kind']>(token: Token, expectedKind: K): void {
    if (token.kind !== expectedKind) {
      this.raiseParseError(token, [ expectedKind ]);
    }
  }

  private expectToken<K extends TokenKind>(expectedKind: K): Token & { kind: K } {
    const token = this.getToken();
    if (token.kind !== expectedKind) {
      this.raiseParseError(token, [ expectedKind ])
    }
    return token as Token & { kind: K };
  }

  private raiseParseError(actual: Token, expected: SyntaxKind[]): never {
    throw new ParseError(this.file, actual, expected);
  }

  private peekTokenAfterModifiers(): Token {
    let t0;
    for (let i = 1;;i++) {
      t0 = this.peekToken(i);
      if (t0.kind !== SyntaxKind.PubKeyword) {
        break;
      }
    }
    return t0;
  }

  public parseReferenceTypeExpression(): ReferenceTypeExpression {
    const name = this.expectToken(SyntaxKind.IdentifierAlt);
    return new ReferenceTypeExpression([], name);
  }

  public parsePrimitiveTypeExpression(): TypeExpression {
    const t0 = this.peekToken();
    switch (t0.kind) {
      case SyntaxKind.IdentifierAlt:
        return this.parseReferenceTypeExpression();
      default:
        this.raiseParseError(t0, [ SyntaxKind.IdentifierAlt ]);
    }
  }

  public parseTypeExpression(): TypeExpression {
    let returnType = this.parsePrimitiveTypeExpression();
    const paramTypes = [];
    for (;;) {
      const t1 = this.peekToken();
      if (t1.kind !== SyntaxKind.RArrow) {
        break;
      }
      this.getToken();
      paramTypes.push(returnType);
      returnType = this.parsePrimitiveTypeExpression();
    }
    if (paramTypes.length === 0) {
      return returnType;
    }
    return new ArrowTypeExpression(paramTypes, returnType);
  }

  public parseConstantExpression(): ConstantExpression {
    const token = this.getToken()
    if (token.kind !== SyntaxKind.StringLiteral
      && token.kind !== SyntaxKind.Integer) {
      this.raiseParseError(token, [ SyntaxKind.StringLiteral, SyntaxKind.Integer ])
    }
    return new ConstantExpression(token);
  }

  public parseQualifiedName(): QualifiedName {
    const modulePath: Array<[IdentifierAlt, Dot]> = [];
    for (;;) {
      const t0 = this.peekToken(1);
      const t1 = this.peekToken(2);
      if (t0.kind !== SyntaxKind.IdentifierAlt || t1.kind !== SyntaxKind.Dot) {
        break;
      }
      modulePath.push([t0, t1]);
    }
    const name = this.expectToken(SyntaxKind.Identifier);
    return new QualifiedName(modulePath, name);
  }

  public parseReferenceExpression(): ReferenceExpression {
    return new ReferenceExpression(this.parseQualifiedName());
  }

  private parseExpressionWithParens(): Expression {
    const lparen = this.expectToken(SyntaxKind.LParen)
    const t1 = this.peekToken();
    // FIXME should be able to parse tuples
    if (t1.kind === SyntaxKind.RParen) {
      this.getToken();
      return new TupleExpression(lparen, [], t1);
    } else {
      const expression = this.parseExpression();
      const t2 = this.expectToken(SyntaxKind.RParen);
      return new NestedExpression(lparen, expression, t2);
    }
  }

  private parsePrimitiveExpression(): Expression {
    const t0 = this.peekToken();
    switch (t0.kind) {
      case SyntaxKind.LParen:
        return this.parseExpressionWithParens();
      case SyntaxKind.Identifier:
        return this.parseReferenceExpression();
      case SyntaxKind.IdentifierAlt:
      {
        this.getToken();
        const t1 = this.peekToken();
        if (t1.kind === SyntaxKind.LBrace) {
          this.getToken();
          const fields = [];
          let rbrace;
          for (;;) {
            const t2 = this.peekToken();
            if (t2.kind === SyntaxKind.RBrace) {
              this.getToken();
              rbrace = t2;
              break;
            }
            let field;
            const t3 = this.getToken();
            if (t3.kind === SyntaxKind.Identifier) {
              const t4 = this.peekToken();
              if (t4.kind === SyntaxKind.Equals) {
                this.getToken();
                const expression = this.parseExpression();
                field = new StructExpressionField(t3, t4, expression);
              } else {
                field = new PunnedStructExpressionField(t3);
              }
            } else {
              // TODO add spread fields
              this.raiseParseError(t3, [ SyntaxKind.Identifier ]);
            }
            fields.push(field);
            const t5 = this.peekToken();
            if (t5.kind === SyntaxKind.Comma) {
              this.getToken();
              continue;
            } else if (t5.kind === SyntaxKind.RBrace) {
              this.getToken();
              rbrace = t5;
              break;
            }
          }
          return new StructExpression(t0, t1, fields, rbrace);
        }
        const elements = [];
        for (;;) {
          const t2 = this.peekToken();
          if (t2.kind === SyntaxKind.LineFoldEnd
            || t2.kind === SyntaxKind.RParen
            || t2.kind === SyntaxKind.RBrace
            || t2.kind === SyntaxKind.RBracket
            || isBinaryOperatorLike(t2)
            || isPrefixOperatorLike(t2)) {
            break;
          }
          elements.push(this.parseExpression());
        }
        return new NamedTupleExpression(t0, elements);
      }
      case SyntaxKind.Integer:
      case SyntaxKind.StringLiteral:
        return this.parseConstantExpression();
      default:
        this.raiseParseError(t0, [
          SyntaxKind.NamedTupleExpression,
          SyntaxKind.TupleExpression,
          SyntaxKind.NestedExpression,
          SyntaxKind.ConstantExpression,
          SyntaxKind.ReferenceExpression
        ]);
    }
  }

  private tryParseMemberExpression(): Expression {
    const expression = this.parsePrimitiveExpression();
    const path: Array<[Dot, Identifier]> = [];
    for (;;) {
      const t1 = this.peekToken();
      if (t1.kind !== SyntaxKind.Dot) {
        break;
      }
      this.getToken();
      const name = this.expectToken(SyntaxKind.Identifier);
      path.push([t1, name]);
    }
    if (path.length === 0) {
      return expression;
    }
    return new MemberExpression(expression, path);
  }

  private tryParseCallExpression(): Expression {
    const func = this.tryParseMemberExpression();
    const args = [];
    for (;;) {
      const t1 = this.peekToken();
      if (t1.kind === SyntaxKind.LineFoldEnd
        || t1.kind === SyntaxKind.RBrace
        || t1.kind === SyntaxKind.RBracket
        || t1.kind === SyntaxKind.RParen
        || t1.kind === SyntaxKind.BlockStart
        || t1.kind === SyntaxKind.Comma
        || isBinaryOperatorLike(t1)
        || isPrefixOperatorLike(t1)) {
        break;
      }
      args.push(this.tryParseMemberExpression());
    }
    if (args.length === 0) {
      return func
    }
    return new CallExpression(func, args);
  }

  private parseUnaryExpression(): Expression {
    let result = this.tryParseCallExpression()
    const prefixes = [];
    for (;;) {
      const t0 = this.peekToken();
      if (!isPrefixOperatorLike(t0)) {
        break;
      }
      if (!this.prefixExprOperators.has(t0.text)) {
        break;
      }
      prefixes.push(t0);
      this.getToken()
    }
    for (let i = prefixes.length-1; i >= 0; i--) {
      const operator = prefixes[i];
      result = new PrefixExpression(operator, result);
    }
    return result;
  }

  private parseBinaryOperatorAfterExpr(lhs: Expression, minPrecedence: number) {
    for (;;) {
      const t0 = this.peekToken();
      if (!isBinaryOperatorLike(t0)) {
        break;
      }
      const info0 = this.binaryExprOperators.get(t0.text);
      if (info0 === undefined || info0.precedence < minPrecedence) {
        break;
      }
      this.getToken();
      let rhs = this.parseUnaryExpression();
      for (;;) {
        const t1 = this.peekToken();
        if (!isBinaryOperatorLike(t1)) {
          break;
        }
        const info1 = this.binaryExprOperators.get(t1.text);
        if (info1 === undefined
          || info1.precedence < info0.precedence
          || (info1.precedence === info0.precedence && (info1.mode & OperatorMode.InfixR) === 0)) {
          break;
        }
        rhs = this.parseBinaryOperatorAfterExpr(rhs, info0.precedence);
      }
      lhs = new InfixExpression(lhs, t0, rhs);
    }
    return lhs;
  }

  public parseExpression(): Expression {
    const lhs = this.parseUnaryExpression();
    return this.parseBinaryOperatorAfterExpr(lhs, 0);
  }

  public parseStructDeclaration(): StructDeclaration {
    const structKeyword = this.expectToken(SyntaxKind.StructKeyword);
    const name = this.expectToken(SyntaxKind.IdentifierAlt);
    const t2 = this.peekToken()
    let members = null;
    if (t2.kind === SyntaxKind.BlockStart) {
      this.getToken();
      members = [];
      for (;;) {
        const t3 = this.peekToken();
        if (t3.kind === SyntaxKind.BlockEnd) {
          this.getToken();
          break;
        }
        const name = this.expectToken(SyntaxKind.Identifier);
        const colon = this.expectToken(SyntaxKind.Colon);
        const typeExpr = this.parseTypeExpression();
        this.expectToken(SyntaxKind.LineFoldEnd);
        const member = new StructDeclarationField(name, colon, typeExpr);
        members.push(member);
      }
    }
    this.expectToken(SyntaxKind.LineFoldEnd);
    return new StructDeclaration(structKeyword, name, members);
  }

  private parsePatternStartingWithConstructor() {
    const name = this.expectToken(SyntaxKind.IdentifierAlt);
    const t2 = this.peekToken();
    if (t2.kind === SyntaxKind.LBrace) {
      this.getToken();
      const fields = [];
      let rbrace;
      for (;;) {
        const t3 = this.peekToken();
        if (t3.kind === SyntaxKind.RBrace) {
          this.getToken();
          rbrace = t3;
          break;
        } else if (t3.kind === SyntaxKind.Identifier) {
          this.getToken();
          const t4 = this.peekToken();
          if (t4.kind === SyntaxKind.Equals) {
            this.getToken();
            const pattern = this.parsePattern();
            fields.push(new StructPatternField(t3, t4, pattern));
          } else {
            fields.push(new PunnedStructPatternField(t3));
          }
        } else if (t3.kind === SyntaxKind.DotDot) {
          this.getToken();
          fields.push(new VariadicStructPatternElement(t3, null));
        } else {
          this.raiseParseError(t3, [ SyntaxKind.Identifier, SyntaxKind.DotDot ]);
        }
        const t5 = this.peekToken();
        if (t5.kind === SyntaxKind.Comma) {
          this.getToken();
        } else if (t5.kind === SyntaxKind.RBrace) {
          this.getToken();
          rbrace = t5;
          break;
        } else {
          this.raiseParseError(t5, [ SyntaxKind.Comma, SyntaxKind.RBrace ]);
        }
      }
      return new StructPattern(name, t2, fields, rbrace);
    } else {
      const patterns = [];
      for (;;) {
        const t3 = this.peekToken();
        if (t3.kind === SyntaxKind.RParen) {
          break;
        }
        patterns.push(this.parsePattern());
      }
      return new NamedTuplePattern(name, patterns);
    }
  }

  public parseTuplePattern(): TuplePattern {
    const lparen = this.expectToken(SyntaxKind.LParen);
    const elements = [];
    let rparen;
    for (;;) {
      const t1 = this.peekToken();
      if (t1.kind === SyntaxKind.RParen) {
        rparen = t1;
        break;
      }
      elements.push(this.parsePattern());
      const t2 = this.peekToken();
      if (t2.kind === SyntaxKind.Comma) {
        this.getToken();
      } else if (t2.kind === SyntaxKind.RParen) {
        rparen = t2;
        break;
      } else {
        this.raiseParseError(t2, [ SyntaxKind.Comma, SyntaxKind.RParen ]);
      }
    }
    this.getToken();
    return new TuplePattern(lparen, elements, rparen);
  }

  public parsePattern(): Pattern {
    const t0 = this.peekToken();
    switch (t0.kind) {
      case SyntaxKind.LParen:
      {
        const t1 = this.peekToken();
        if (t1.kind === SyntaxKind.IdentifierAlt) {
          this.getToken();
          return this.parsePatternStartingWithConstructor();
        } else {
          return this.parseTuplePattern();
        }
      }
      case SyntaxKind.IdentifierAlt:
        return this.parsePatternStartingWithConstructor();
      case SyntaxKind.Identifier:
        this.getToken();
        return new BindPattern(t0);
      default:
        this.raiseParseError(t0, [ SyntaxKind.Identifier ]);
    }
  }

  public parseParam(): Param {
    const pattern = this.parsePattern();
    return new Param(pattern);
  }

  public parseLetBodyElement(): LetBodyElement {
    const t0 = this.peekTokenAfterModifiers();
    switch (t0.kind) {
      case SyntaxKind.LetKeyword:
        return this.parseLetDeclaration();
      case SyntaxKind.ReturnKeyword:
        return this.parseReturnStatement();
      case SyntaxKind.IfKeyword:
        return this.parseIfStatement();
      default:
        // TODO convert parse errors to include LetKeyword and ReturnKeyword
        return this.parseExpressionStatement();
    }
  }

  public parseLetDeclaration(): LetDeclaration {
    let t0 = this.getToken();
    let pubKeyword = null;
    let mutKeyword = null;
    if (t0.kind === SyntaxKind.PubKeyword) {
      pubKeyword = t0;
      t0 = this.getToken();
    }
    if (t0.kind !== SyntaxKind.LetKeyword) {
      this.raiseParseError(t0, [ SyntaxKind.LetKeyword ]);
    }
    const t1 = this.peekToken();
    if (t1.kind === SyntaxKind.MutKeyword) {
      this.getToken();
      mutKeyword = t1;
    }
    const t2 = this.peekToken();
    const t3 = this.peekToken(2);
    const t4 = this.peekToken(3);
    let pattern;
    if (t2.kind === SyntaxKind.LParen && t3.kind === SyntaxKind.CustomOperator && t4.kind === SyntaxKind.RParen) {
      this.getToken()
      this.getToken();
      this.getToken();
      pattern = new WrappedOperator(t2, t3, t4);
    } else {
      pattern = this.parsePattern();
    }
    const params = [];
    for (;;) {
      const t2 = this.peekToken();
      if (t2.kind === SyntaxKind.Colon
        || t2.kind === SyntaxKind.BlockStart
        || t2.kind === SyntaxKind.Equals
        || t2.kind === SyntaxKind.LineFoldEnd) {
        break;
      }
      params.push(this.parseParam());
    }
    let typeAssert = null;
    let t5 = this.getToken();
    if (t5.kind === SyntaxKind.Colon) {
      const typeExpression = this.parseTypeExpression();
      typeAssert = new TypeAssert(t5, typeExpression);
      t5 = this.getToken();
    }
    let body = null;
    switch (t5.kind) {
      case SyntaxKind.BlockStart:
      {
        const elements = [];
        for (;;) {
          const t4 = this.peekToken();
          if (t4.kind === SyntaxKind.BlockEnd) {
            this.getToken();
            break;
          }
          elements.push(this.parseLetBodyElement());
        }
        body = new BlockBody(t5, elements);
        t5 = this.getToken();
        break;
      }
      case SyntaxKind.Equals:
      {
        const expression = this.parseExpression();
        body = new ExprBody(t5, expression);
        t5 = this.getToken();
        break;
      }
      case SyntaxKind.LineFoldEnd:
        break;
    }
    if (t5.kind !== SyntaxKind.LineFoldEnd) {
      this.raiseParseError(t5, [ SyntaxKind.LineFoldEnd ]);
    }
    return new LetDeclaration(
      pubKeyword,
      t0,
      mutKeyword,
      pattern,
      params,
      typeAssert,
      body
    );
  }

  public parseExpressionStatement(): ExpressionStatement {
    const expression = this.parseExpression();
    this.expectToken(SyntaxKind.LineFoldEnd)
    return new ExpressionStatement(expression);
  }

  public parseIfStatement(): IfStatement {
    const ifKeyword = this.expectToken(SyntaxKind.IfKeyword);
    const test = this.parseExpression();
    const blockStart = this.expectToken(SyntaxKind.BlockStart);
    const elements = [];
    for (;;) {
      const t1 = this.peekToken();
      if (t1.kind === SyntaxKind.BlockEnd) {
        this.getToken();
        break;
      }
      elements.push(this.parseLetBodyElement());
    }
    this.expectToken(SyntaxKind.LineFoldEnd);
    const cases = [];
    cases.push(new IfStatementCase(ifKeyword, test, blockStart, elements));
    for (;;) {
      const t2 = this.peekToken();
      if (t2.kind === SyntaxKind.ElseKeyword) {
        this.getToken();
        const blockStart = this.expectToken(SyntaxKind.BlockStart);
        const elements = [];
        for (;;) {
          const t3 = this.peekToken();
          if (t3.kind === SyntaxKind.BlockEnd) {
            this.getToken();
            break;
          }
          elements.push(this.parseLetBodyElement());
        }
        this.expectToken(SyntaxKind.LineFoldEnd);
        cases.push(new IfStatementCase(t2, null, blockStart, elements));
        break;
      } else if (t2.kind === SyntaxKind.ElifKeyword) {
        this.getToken();
        const test = this.parseExpression();
        const blockStart = this.expectToken(SyntaxKind.BlockStart);
        for (;;) {
          const t4 = this.peekToken();
          if (t4.kind === SyntaxKind.BlockEnd) {
            this.getToken();
            break;
          }
          elements.push(this.parseLetBodyElement());
        }
        this.expectToken(SyntaxKind.LineFoldEnd);
        cases.push(new IfStatementCase(t2, test, blockStart, elements));
      } else if (t2.kind === SyntaxKind.LineFoldEnd) {
        this.getToken();
        break;
      } else {
        this.raiseParseError(t2, [ SyntaxKind.ElifKeyword, SyntaxKind.ElseKeyword, SyntaxKind.LineFoldEnd ]); 
      }
    }
    return new IfStatement(cases);
  }

  public parseReturnStatement(): ReturnStatement {
    const returnKeyword = this.expectToken(SyntaxKind.ReturnKeyword);
    let expression = null;
    const t1 = this.peekToken();
    if (t1.kind !== SyntaxKind.LineFoldEnd) {
      expression = this.parseExpression();
    }
    this.expectToken(SyntaxKind.LineFoldEnd);
    return new ReturnStatement(returnKeyword, expression);
  }

  public parseImportDeclaration(): ImportDeclaration {
    const importKeyword = this.expectToken(SyntaxKind.ImportKeyword);
    const importSource = this.expectToken(SyntaxKind.StringLiteral);
    return new ImportDeclaration(importKeyword, importSource);
  }

  public parseSourceFileElement(): SourceFileElement {
    const t0 = this.peekTokenAfterModifiers();
    switch (t0.kind) {
      case SyntaxKind.LetKeyword:
        return this.parseLetDeclaration();
      case SyntaxKind.ImportKeyword:
        return this.parseImportDeclaration();
      case SyntaxKind.StructKeyword:
        return this.parseStructDeclaration();
      case SyntaxKind.IfKeyword:
        return this.parseIfStatement();
      default:
        return this.parseExpressionStatement();
    }
  }

  public parseSourceFile(): SourceFile {
    const elements = [];
    let eof;
    for (;;) {
      const t0 = this.peekToken();
      if (t0.kind === SyntaxKind.EndOfFile) {
        eof = t0;
        break;
      }
      const element = this.parseSourceFileElement();
      elements.push(element);
    }
    return new SourceFile(this.file, elements, eof);
  }

}

