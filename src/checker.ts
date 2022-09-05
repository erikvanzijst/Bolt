import {
  Expression,
  Pattern,
  SourceFile,
  Syntax,
  SyntaxKind,
  TypeExpression
} from "./cst";
import { ArityMismatchDiagnostic, BindingNotFoudDiagnostic, describeType, Diagnostics, UnificationFailedDiagnostic } from "./diagnostics";
import { assert } from "./util";
import { DirectedHashGraph, Graph, strongconnect } from "yagl"

export enum TypeKind {
  Arrow,
  Var,
  Con,
  Any,
  Tuple,
}

abstract class TypeBase {

  public abstract readonly kind: TypeKind;

  public abstract getTypeVars(): Iterable<TVar>;

  public abstract substitute(sub: TVSub): Type;

  public hasTypeVar(tv: TVar): boolean {
    for (const other of this.getTypeVars()) {
      if (tv.id === other.id) {
        return true;
      }
    }
    return false;
  }

}

class TVar extends TypeBase {

  public readonly kind = TypeKind.Var;

  public constructor(
    public id: number,
  ) {
    super();
  }

  public *getTypeVars(): Iterable<TVar> {
    yield this;
  }

  public substitute(sub: TVSub): Type {
    const other = sub.get(this);
    return other === undefined
      ? this : other.substitute(sub);
  }

}

export class TArrow extends TypeBase {

  public readonly kind = TypeKind.Arrow;

  public constructor(
    public paramTypes: Type[],
    public returnType: Type,
  ) {
    super();
  }

  public *getTypeVars(): Iterable<TVar> {
    for (const paramType of this.paramTypes) {
      yield* paramType.getTypeVars();
    }
    yield* this.returnType.getTypeVars();
  }

  public substitute(sub: TVSub): Type {
    let changed = false;
    const newParamTypes = [];
    for (const paramType of this.paramTypes) {
      const newParamType = paramType.substitute(sub);
      if (newParamType !== paramType) {
        changed = true;
      }
      newParamTypes.push(newParamType);
    }
    const newReturnType = this.returnType.substitute(sub);
    if (newReturnType !== this.returnType) {
      changed = true;
    }
    return changed ? new TArrow(newParamTypes, newReturnType) : this;
  }

}

class TCon extends TypeBase {

  public readonly kind = TypeKind.Con;

  public constructor(
    public id: number,
    public argTypes: Type[],
    public displayName: string,
  ) {
    super();
  }

  public *getTypeVars(): Iterable<TVar> {
    for (const argType of this.argTypes) {
      yield* argType.getTypeVars();
    }
  }

  public substitute(sub: TVSub): Type {
    let changed = false;
    const newArgTypes = [];
    for (const argType of this.argTypes) {
      const newArgType = argType.substitute(sub);
      if (newArgType !== argType) {
        changed = true;
      }
      newArgTypes.push(newArgType);
    }
    return changed ? new TCon(this.id, newArgTypes, this.displayName) : this;
  }

}

class TAny extends TypeBase {

  public readonly kind = TypeKind.Any;

  public *getTypeVars(): Iterable<TVar> {
    
  }

  public substitute(sub: TVSub): Type {
    return this;
  }

}

class TTuple extends TypeBase {

  public readonly kind = TypeKind.Tuple;

  public constructor(
    public elementTypes: Type[],
  ) {
    super();
  }

  public *getTypeVars(): Iterable<TVar> {
    for (const elementType of this.elementTypes) {
      yield* elementType.getTypeVars();
    }
  }

  public substitute(sub: TVSub): Type {
    let changed = false;
    const newElementTypes = [];
    for (const elementType of this.elementTypes) {
      const newElementType = elementType.substitute(sub);
      if (newElementType !== elementType) {
        changed = true;
      }
      newElementTypes.push(newElementType);
    }
    return changed ? new TTuple(newElementTypes) : this;
  }

}

export type Type
  = TCon
  | TArrow
  | TVar
  | TAny
  | TTuple


class TVSet {

  private mapping = new Map<number, TVar>();

  public add(tv: TVar): void {
    this.mapping.set(tv.id, tv);
  }
  
  public has(tv: TVar): boolean {
    return this.mapping.has(tv.id);
  }

  public intersectsType(type: Type): boolean {
    for (const tv of type.getTypeVars()) {
      if (this.has(tv)) {
        return true; 
      }
    }
    return false;
  }

  public delete(tv: TVar): void {
    this.mapping.delete(tv.id);
  }

  public [Symbol.iterator](): Iterator<TVar> {
    return this.mapping.values();
  }

}

class TVSub {

  private mapping = new Map<number, Type>();

  public set(tv: TVar, type: Type): void {
    this.mapping.set(tv.id, type);
  }

  public get(tv: TVar): Type | undefined {
    return this.mapping.get(tv.id);
  }

  public has(tv: TVar): boolean {
    return this.mapping.has(tv.id);
  }

  public delete(tv: TVar): void {
    this.mapping.delete(tv.id);
  }

  public values(): Iterable<Type> {
    return this.mapping.values();
  }

}

const enum ConstraintKind {
  Equal,
  Many,
}

abstract class ConstraintBase {

  public abstract substitute(sub: TVSub): Constraint;

}

class CEqual extends ConstraintBase {

  public readonly kind = ConstraintKind.Equal;

  public constructor(
    public left: Type,
    public right: Type,
    public node: Syntax,
  ) {
    super();
  }

  public substitute(sub: TVSub): Constraint {
    return new CEqual(
      this.left.substitute(sub),
      this.right.substitute(sub),
      this.node,
    );
  }

  public dump(): void {
    console.error(`${describeType(this.left)} ~ ${describeType(this.right)}`);
  }

}

class CMany extends ConstraintBase {

  public readonly kind = ConstraintKind.Many;

  public constructor(
    public elements: Constraint[]
  ) {
    super();
  }

  public substitute(sub: TVSub): Constraint {
    const newElements = [];
    for (const element of this.elements) {
      newElements.push(element.substitute(sub));
    }
    return new CMany(newElements);
  }

}

type Constraint
  = CEqual
  | CMany

class ConstraintSet extends Array<Constraint> {
}

abstract class SchemeBase {
}

class Forall extends SchemeBase {

  public constructor(
    public tvs: TVar[],
    public constraints: Constraint[],
    public type: Type,
  ) {
    super();
  }

}

type Scheme
  = Forall

class TypeEnv extends Map<string, Scheme> {
}

export interface InferContext {
  typeVars: TVSet;
  env: TypeEnv;
  constraints: ConstraintSet;
  returnType: Type | null;
}

export class Checker {

  private nextTypeVarId = 0;
  private nextConTypeId = 0;

  //private graph?: Graph<Syntax>;
  //private currentCycle?: Map<Syntax, Type>;

  private stringType = new TCon(this.nextConTypeId++, [], 'String');
  private intType = new TCon(this.nextConTypeId++, [], 'Int');
  private boolType = new TCon(this.nextConTypeId++, [], 'Bool');

  private contexts: InferContext[] = [];

  private solution = new TVSub();

  public constructor(
    private diagnostics: Diagnostics
  ) {

  }

  public getIntType(): Type {
    return this.intType;
  }

  public getStringType(): Type {
    return this.stringType;
  }

  public getBoolType(): Type {
    return this.boolType;
  }

  private createTypeVar(): TVar {
    const typeVar = new TVar(this.nextTypeVarId++);
    const context = this.contexts[this.contexts.length-1];
    context.typeVars.add(typeVar);
    return typeVar;
  }

  private addConstraint(constraint: Constraint): void {
    switch (constraint.kind) {
      case ConstraintKind.Many:
      {
        for (const element of constraint.elements) {
          this.addConstraint(element);
        }
        return;
      }
      case ConstraintKind.Equal:
      {
        const count = this.contexts.length;
        let i;
        for (i = count-1; i > 0; i--) {
          const typeVars = this.contexts[i].typeVars;
          if (typeVars.intersectsType(constraint.left) || typeVars.intersectsType(constraint.right)) {
            break;
          }
        }
        this.contexts[i].constraints.push(constraint);
        break;
      }
    }
  }

  private pushContext(context: InferContext) {
    this.contexts.push(context);
  }

  private popContext(context: InferContext) {
    assert(this.contexts[this.contexts.length-1] === context);
    this.contexts.pop();
  }

  private lookup(name: string): Scheme | null {
    for (let i = this.contexts.length-1; i >= 0; i--) {
      const typeEnv = this.contexts[i].env;
      const scheme = typeEnv.get(name);
      if (scheme !== undefined) {
        return scheme;
      }
    }
    return null;
  }

  private getReturnType(): Type {
    const context = this.contexts[this.contexts.length-1];
    assert(context && context.returnType !== null);
    return context.returnType;
  }

  private instantiate(scheme: Scheme): Type {
    const sub = new TVSub();
    for (const tv of scheme.tvs) {
      sub.set(tv, this.createTypeVar());
    }
    for (const constraint of scheme.constraints) {
      this.addConstraint(constraint.substitute(sub));
      // TODO keep record of a 'chain' of instantiations so that the diagnostics tool can output it on type error
    }
    return scheme.type.substitute(sub);
  }

  private addBinding(name: string, scheme: Scheme): void {
    const context = this.contexts[this.contexts.length-1];
    context.env.set(name, scheme);
  }

  private forwardDeclare(node: Syntax): void {

    switch (node.kind) {

      case SyntaxKind.SourceFile:
      {
        for (const element of node.elements) {
          this.forwardDeclare(element);
        }
        break;
      }

      case SyntaxKind.ExpressionStatement:
      case SyntaxKind.ReturnStatement:
      {
        // TODO This should be updated if block-scoped expressions are allowed.
        break;
      }

      case SyntaxKind.LetDeclaration:
        break;

    }
  }

  public infer(node: Syntax): void {

    switch (node.kind) {

      case SyntaxKind.SourceFile:
      {
        for (const element of node.elements) {
          this.infer(element);
        }
        break;
      }

      case SyntaxKind.ExpressionStatement:
      {
        this.inferExpression(node.expression);
        break;
      }

      case SyntaxKind.IfStatement:
      {
        for (const cs of node.cases) {
          if (cs.test !== null) {
            this.addConstraint(
              new CEqual(
                this.inferExpression(cs.test),
                this.getBoolType(),
                cs.test
              )
            );
          }
          for (const element of cs.elements) {
            this.infer(element);
          }
        }
        break;
      }

      case SyntaxKind.ReturnStatement:
      {
        let type;
        if (node.expression === null) {
          type = new TTuple([]);
        } else {
          type = this.inferExpression(node.expression);
        }
        this.addConstraint(
          new CEqual(
            this.getReturnType(),
            type,
            node
          )
        );
        break;
      }

      case SyntaxKind.LetDeclaration:
        break;

      default:
        throw new Error(`Unexpected ${node}`);

    }

  }

  public inferExpression(node: Expression): Type {

    switch (node.kind) {

      case SyntaxKind.NestedExpression:
        return this.inferExpression(node.expression);

      case SyntaxKind.ReferenceExpression:
      {
        assert(node.name.modulePath.length === 0);
        const scope = node.getScope();
        const target = scope.lookup(node.name.name.text);
        if (target !== null && target.type !== undefined) {
          return target.type;
        }
        const scheme = this.lookup(node.name.name.text);
        if (scheme === null) {
          this.diagnostics.add(new BindingNotFoudDiagnostic(node.name.name.text, node.name.name));
          return new TAny();
        }
        return this.instantiate(scheme);
      }

      case SyntaxKind.CallExpression:
      {
        const opType = this.inferExpression(node.func);
        const retType = this.createTypeVar();
        const paramTypes = [];
        for (const arg of node.args) {
          paramTypes.push(this.inferExpression(arg));
        }
        this.addConstraint(
          new CEqual(
            opType,
            new TArrow(paramTypes, retType),
            node
          )
        );
        return retType;
      }

      case SyntaxKind.ConstantExpression:
      {
        let ty;
        switch (node.token.kind) {
          case SyntaxKind.StringLiteral:
            ty = this.getStringType();
            break;
          case SyntaxKind.Integer:
            ty = this.getIntType();
            break;
        }
        return ty;
      }

      case SyntaxKind.NamedTupleExpression:
      {
        const scheme = this.lookup(node.name.text);
        if (scheme === null) {
          this.diagnostics.add(new BindingNotFoudDiagnostic(node.name.text, node.name));
          return new TAny();
        }
        const type = this.instantiate(scheme);
        assert(type.kind === TypeKind.Con);
        const argTypes = [];
        for (const element of node.elements) {
          argTypes.push(this.inferExpression(element));
        }
        return new TCon(type.id, argTypes, type.displayName);
      }

      case SyntaxKind.InfixExpression:
      {
        const scheme = this.lookup(node.operator.text);
        if (scheme === null) {
          this.diagnostics.add(new BindingNotFoudDiagnostic(node.operator.text, node.operator));
          return new TAny();
        }
        const opType = this.instantiate(scheme);
        const retType = this.createTypeVar();
        const leftType = this.inferExpression(node.left);
        const rightType = this.inferExpression(node.right);
        this.addConstraint(
          new CEqual(
            new TArrow([ leftType, rightType ], retType),
            opType,
            node,
          ),
        );
        return retType;
      }

      default:
        throw new Error(`Unexpected ${node.constructor.name}`);

    }

  }

  public inferTypeExpression(node: TypeExpression): Type {

    switch (node.kind) {

      case SyntaxKind.ReferenceTypeExpression:
      {
        const scheme = this.lookup(node.name.text);
        if (scheme === null) {
          this.diagnostics.add(new BindingNotFoudDiagnostic(node.name.text, node.name));
          return new TAny();
        }
        return this.instantiate(scheme);
      }

      default:
        throw new Error(`Unrecognised ${node}`);

    }

  }

  public inferBindings(pattern: Pattern, type: Type, tvs: TVar[], constraints: Constraint[]): void {

    switch (pattern.kind) {

      case SyntaxKind.BindPattern:
      {
        this.addBinding(pattern.name.text, new Forall(tvs, constraints, type));
        break;
      }

    }

  }

  private computeReferenceGraph(node: SourceFile): Graph<Syntax> {
    const graph = new DirectedHashGraph<Syntax>();
    const visit = (node: Syntax, source: Syntax | null) => {
      switch (node.kind) {
        case SyntaxKind.ConstantExpression:
          break;
        case SyntaxKind.SourceFile:
        {
          for (const element of node.elements) {
            visit(element, source);
          }
          break;
        }
        case SyntaxKind.ReferenceExpression:
        {
          // TODO only add references to nodes on the same level
          assert(node.name.modulePath.length === 0);
          let target = node.getScope().lookup(node.name.name.text);
          if (target !== null && target.kind === SyntaxKind.Param) {
            target = target.parent!;
            if (source !== null) {
              graph.addEdge(target, source);
            }
          }
          if (source !== null && target !== null && target.kind === SyntaxKind.LetDeclaration) {
            graph.addEdge(source, target);
          }
          break;
        }
        case SyntaxKind.NamedTupleExpression:
        {
          for (const arg of node.elements) {
            visit(arg, source);
          }
          break;
        }
        case SyntaxKind.NestedExpression:
        {
          visit(node.expression, source);
          break;
        }
        case SyntaxKind.InfixExpression:
        {
          visit(node.left, source);
          visit(node.right, source);
          break;
        }
        case SyntaxKind.CallExpression:
        {
          visit(node.func, source);
          for (const arg of node.args) {
            visit(arg, source);
          }
          break;
        }
        case SyntaxKind.IfStatement:
        {
          for (const cs of node.cases) {
            if (cs.test !== null) {
              visit(cs.test, source);
            }
            for (const element of cs.elements) {
              visit(element, source);
            }
          }
          break;
        }
        case SyntaxKind.ExpressionStatement:
        {
          visit(node.expression, source);
          break;
        }
        case SyntaxKind.ReturnStatement:
        {
          if (node.expression !== null) {
            visit(node.expression, source);
          }
          break;
        }
        case SyntaxKind.LetDeclaration:
        {
          graph.addVertex(node);
          if (node.body !== null) {
            switch (node.body.kind) {
              case SyntaxKind.ExprBody:
              {
                visit(node.body.expression, node);
                break;
              }
              case SyntaxKind.BlockBody:
              {
                for (const element of node.body.elements) {
                  visit(element, node);
                }
                break;
              }
            }
          }
          break;
        }
        default:
          throw new Error(`Unexpected ${node.constructor.name}`);
      }
    }
    visit(node, null);
    return graph;
  }

  public check(node: SourceFile): void {

    const typeVars = new TVSet();
    const constraints = new ConstraintSet();
    const env = new TypeEnv();
    const context: InferContext = { typeVars, constraints, env, returnType: null };

    this.pushContext(context);

    const a = this.createTypeVar();

    env.set('String', new Forall([], [], this.stringType));
    env.set('Int', new Forall([], [], this.intType));
    env.set('True', new Forall([], [], this.boolType));
    env.set('False', new Forall([], [], this.boolType));
    env.set('+', new Forall([], [], new TArrow([ this.intType, this.intType ], this.intType)));
    env.set('-', new Forall([], [], new TArrow([ this.intType, this.intType ], this.intType)));
    env.set('*', new Forall([], [], new TArrow([ this.intType, this.intType ], this.intType)));
    env.set('/', new Forall([], [], new TArrow([ this.intType, this.intType ], this.intType)));
    env.set('==', new Forall([ a ], [], new TArrow([ a, a ], this.boolType)));
    env.set('not', new Forall([], [], new TArrow([ this.boolType ], this.boolType)));

    const graph = this.computeReferenceGraph(node);

    for (const nodes of strongconnect(graph)) {

      const typeVars = new TVSet();
      const constraints = new ConstraintSet();

      for (const node of nodes) {

        assert(node.kind === SyntaxKind.LetDeclaration);

        const env = new TypeEnv();
        const context: InferContext = {
          typeVars,
          constraints,
          env,
          returnType: null,
        };
        node.context = context;

        this.contexts.push(context);

        const returnType = this.createTypeVar();
        context.returnType = returnType;

        const paramTypes = [];
        for (const param of node.params) {
          const paramType = this.createTypeVar()
          this.inferBindings(param.pattern, paramType, [], []);
          paramTypes.push(paramType);
        }

        let type = new TArrow(paramTypes, returnType);
        if (node.typeAssert !== null) {
          this.addConstraint(
            new CEqual(
              this.inferTypeExpression(node.typeAssert.typeExpression),
              type,
              node.typeAssert
            )
          );
        }
        node.type = type;

        this.contexts.pop();

        this.inferBindings(node.pattern, type, typeVars, constraints);
      }

      for (const node of nodes) {

        assert(node.kind === SyntaxKind.LetDeclaration);

        const context = node.context!;
        const returnType = context.returnType!;
        this.contexts.push(context);

        if (node.body !== null) {
          switch (node.body.kind) {
            case SyntaxKind.ExprBody:
            {
              this.addConstraint(
                new CEqual(
                  this.inferExpression(node.body.expression),
                  returnType,
                  node.body.expression
                )
              );
              break;
            }
            case SyntaxKind.BlockBody:
            {
              for (const element of node.body.elements) {
                this.infer(element);
              }
              break;
            }
          }
        }

        this.contexts.pop();
      }

      for (const node of nodes) {
        assert(node.kind === SyntaxKind.LetDeclaration);
        delete node.type;
      }

    }

    for (const element of node.elements) {
      if (element.kind !== SyntaxKind.LetDeclaration) {
        this.infer(element);
      }
    }

    //this.forwardDeclare(node);
    //this.infer(node);

    this.popContext(context);

    this.solve(new CMany(constraints), this.solution);
  }

  private solve(constraint: Constraint, solution: TVSub): void {

    const queue = [ constraint ];

    while (queue.length > 0) {

      const constraint = queue.pop()!;

      switch (constraint.kind) {

        case ConstraintKind.Many:
        {
          for (const element of constraint.elements) {
            queue.push(element);
          }
          break;
        }

        case ConstraintKind.Equal:
        {
          if (!this.unify(constraint.left, constraint.right, solution)) {
            this.diagnostics.add(
              new UnificationFailedDiagnostic(
                constraint.left.substitute(solution),
                constraint.right.substitute(solution),
                constraint.node
              )
            );
          }
          break;
        }
      }

    }

  }

  private unify(left: Type, right: Type, solution: TVSub): boolean {

    if (left.kind === TypeKind.Var && solution.has(left)) {
      left = solution.get(left)!;
    }
    if (right.kind === TypeKind.Var && solution.has(right)) {
      right = solution.get(right)!;
    }

    if (left.kind === TypeKind.Var) {
      if (right.hasTypeVar(left)) {
        // TODO occurs check diagnostic
        return false;
      }
      solution.set(left, right);
      return true;
    }

    if (right.kind === TypeKind.Var) {
      return this.unify(right, left, solution);
    }

    if (left.kind === TypeKind.Any || right.kind === TypeKind.Any) {
      return true;
    }

    if (left.kind === TypeKind.Arrow && right.kind === TypeKind.Arrow) {
      if (left.paramTypes.length !== right.paramTypes.length) {
        this.diagnostics.add(new ArityMismatchDiagnostic(left, right));
        return false;
      }
      let success = true;
      const count = left.paramTypes.length;
      for (let i = 0; i < count; i++) {
        if (!this.unify(left.paramTypes[i], right.paramTypes[i], solution)) {
          success = false;
        }
      }
      if (!this.unify(left.returnType, right.returnType, solution)) {
        success = false;
      }
      return success;
    }

    if (left.kind === TypeKind.Arrow && left.paramTypes.length === 0) {
      return this.unify(left.returnType, right, solution);
    }

    if (right.kind === TypeKind.Arrow) {
      return this.unify(right, left, solution);
    }

    if (left.kind === TypeKind.Con && right.kind === TypeKind.Con) {
      if (left.id !== right.id) {
        return false;
      }
      assert(left.argTypes.length === right.argTypes.length);
      const count = left.argTypes.length;
      for (let i = 0; i < count; i++) {
        if (!this.unify(left.argTypes[i], right.argTypes[i], solution)) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

}

