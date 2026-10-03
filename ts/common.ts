import { Env } from "./env";

export { Env };

export const isDeepEqual = (a: any, b: any): boolean => {
    // If simple eqv? logic works, return true as no more work needed
    if (Object.is(a, b)) return true;

    // Vectors
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!isDeepEqual(a[i], b[i])) return false;
        }
        return true;
    }

    if (isDatum(a)) return a.equals(b, isDeepEqual);

    // Closures/other types
    return false;
}

// What the VM and the compiler report, by op (Msg[op] names it), with its arguments. The VM words none of them: the front
// end (or the host embedding the VM) does, through its table's formatter (Intrinsics.setFormatter); `fmt` is the
// installed formatter (so a message shows values through its Msg.Value), and `at` where it happened, when known
export enum Msg {
    Value, Unhandled, TracebackHeader, TracebackFrame,
    MissingVar, NonProcedure, NonProcedureWind, Arity, ExpectedArray, ValuesCount,
    ContinuationBoundary, EscapeBoundary, ContinuationArgs, EscapeArgs, EscapeOutsideExtent, CatchOutsideExtent,
    HandlerReturned, BadContinuable, BadStackSkip, ExpectedMarkSet,
    ExpectedClosure, ExpectedFinally, ExpectedCoroutine, CannotResume, CannotClose, YieldOutside, YieldClosing,
    EmptyForm, IfArgs, QuoteArgs, FormArgs, LambdaForm, SetTarget, EscapeNoBlock, EscapeFromLambda,
    BadSyntax, ParamNotSymbol, DuplicateParam, CannotBindBuiltin, CannotBindIntrinsic, IntrinsicAsValue, ApplyNonLeaf,
    NoClause, LambdaOption, UnreachableClause, BarrierReentry, NoPrompt, ErrorInHandler, CatchGuard,
    BareCall, UnknownIntrinsic,
}

export type Formatter = (op: Msg, args: readonly any[], fmt: Formatter, at: SourcePos | null) => string;

// what a message is without a formatter: the op's name alone (a front end or host embedding the VM sets its own)
export const opName: Formatter = op => Msg[op];

// An error the VM or compiler reports: its message is worded when it is delivered (Anima code catching it, or the host
// getting it), by the formatter of the table the code runs with
export class VMError extends Error {
    at: SourcePos | null = null;
    #text: string | undefined;

    constructor(readonly op: Msg, readonly args: readonly any[]) {
        super();
    }

    // @ts-ignore: an accessor over Error's own message
    get message(): string {
        return this.#text ??= opName(this.op, this.args, opName, this.at);
    }

    set message(text: string) {
        this.#text = text;
    }

    #formatter: Formatter | null = null;

    // words the message with `fmt`, once
    format(fmt: Formatter): this {
        if (this.#formatter === fmt) return this;
        this.#formatter = fmt;
        this.#text = fmt(this.op, this.args, fmt, this.at);
        return this;
    }
}

// a VMError without a JS stack trace (see hostError)
export const vmError = (op: Msg, ...args: any[]): VMError => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        return new VMError(op, args);
    } finally {
        Error.stackTraceLimit = limit;
    }
};

export class MissingVarError extends VMError {
    constructor(sym: symbol) {
        super(Msg.MissingVar, [sym]);
        this.name = 'MissingVarError';
    }
}

export class ErrorObject {
    constructor(public error: any) {}
}

export class UnhandledError extends Error {
    constructor(public readonly error: any, public readonly traceback?: string, fmt: Formatter = opName) {
        super(fmt(Msg.Unhandled, [error], fmt, null));
    }
}

// Special Forms

// the core language: the only special forms the compiler accepts (besides the other % intrinsics);
// the syntax transformer lowers all surface syntax to these
export const CORE_IF = Symbol.for("%if");
export const CORE_LAMBDA = Symbol.for("%lambda");
export const CORE_QUOTE = Symbol.for("%quote");
export const CORE_BEGIN = Symbol.for("%begin");
export const CORE_SET = Symbol.for("%set!");
// (%call proc arg ...), (%intcall %name arg ...), (%intapply %name arg ... seq): every call is one of these
export const CORE_CALL = Symbol.for("%call");
export const CORE_INTCALL = Symbol.for("%intcall");
export const CORE_INTAPPLY = Symbol.for("%intapply");
// structured control flow within one function: (%block name body ...), (%escape name [expr]), (%loop body ...)
export const CORE_BLOCK = Symbol.for("%block");
export const CORE_ESCAPE = Symbol.for("%escape");
export const CORE_LOOP = Symbol.for("%loop");
// (%let ((x init) ...) body ...): lexical bindings without a lambda
export const CORE_LET = Symbol.for("%let");
// (%let-values ((formals expr) ...) body ...) binds each expr's multiple values: missing values are <#void> and extra
// ones are dropped unless formals has a rest variable (Lua); %let-values/strict raises an error instead
export const CORE_LET_VALUES = Symbol.for("%let-values");
export const CORE_LET_VALUES_STRICT = Symbol.for("%let-values/strict");
export const CORE_LETREC = Symbol.for("%letrec");
export const CORE_LET_STAR = Symbol.for("%let*");
// (%with-mark key value body): body runs with a continuation mark; (%current-marks): the current continuation's marks
export const CORE_WITH_MARK = Symbol.for("%with-mark");
export const CORE_CATCH = Symbol.for("%catch");
export const OP_CURRENT_MARKS = Symbol.for("%current-marks");
// core operations (intrinsics, not forms) front ends lower to
export const OP_RAISE = Symbol.for("%raise");
export const OP_CURRENT_STACK = Symbol.for("%current-stack");
export const OP_DEFINE_GLOBAL = Symbol.for("%define-global");

export type SourcePos = { file: string, line: number, col: number };

// Where forms come from: the positions of a program's forms (core-form arrays, or a front end's own data), which the
// reader or transpiler that makes the forms fills in and hands to the compiler with them. One map per program
export class Positions {
    readonly #of = new WeakMap<object, SourcePos>();

    get(form: any): SourcePos | undefined {
        return typeof form === "object" && form !== null ? this.#of.get(form) : undefined;
    }

    has(form: any): boolean {
        return this.get(form) !== undefined;
    }

    set(form: object, pos: SourcePos): void {
        this.#of.set(form, pos);
    }

    // the positions `from` has of `form` and the forms inside it, as this map's too
    adopt(form: any, from: Positions): void {
        if (!Array.isArray(form) || from === this) return;
        const pos = from.get(form);
        if (pos !== undefined) this.#of.set(form, pos);
        for (const x of form) this.adopt(x, from);
    }

    // `to`, at `from`'s position if it has one
    readonly keep = <T>(to: T, from: any): T => {
        const pos = this.get(from);
        if (pos !== undefined && typeof to === "object" && to !== null) this.#of.set(to, pos);
        return to;
    };
}

export const formatPos = (pos: SourcePos | null | undefined) => pos ? `${pos.file}:${pos.line}:${pos.col}` : "?";

// the core forms: they cannot be bound (a front end reserves its own keywords through its intrinsics table)
export const SPECIAL_FORMS = new Set([
    CORE_IF,
    CORE_LAMBDA,
    CORE_QUOTE,
    CORE_BEGIN,
    CORE_SET,
    CORE_CALL,
    CORE_INTCALL,
    CORE_INTAPPLY,
    CORE_BLOCK,
    CORE_ESCAPE,
    CORE_LOOP,
    CORE_LET,
    CORE_LET_VALUES,
    CORE_LET_VALUES_STRICT,
    CORE_LETREC,
    CORE_LET_STAR,
    CORE_WITH_MARK,
    CORE_CATCH,
    OP_CURRENT_MARKS,
    OP_DEFINE_GLOBAL,
])

// Marker class that all procs should extend from
export class MultipleValues {
    constructor(public readonly values: any[]) {}
}

export const packValues = (vals: any[]): any => vals.length === 1 ? vals[0] : new MultipleValues(vals);

export const unpackValues = (val: any): any[] => val instanceof MultipleValues ? val.values : [val];

export const DATUM = Symbol("datum");

// a front end's own kind of data (e.g. a list type): how it is compared, printed and copied. Marked by a property rather
// than a base class, as V8 does not inline a derived class's constructor
export interface Datum {
    readonly [DATUM]: true;
    equals(other: any, equal: (a: any, b: any) => boolean): boolean;
    stringify(stringify: (v: any) => string): string;
    copy(copy: (v: any) => any): any;
}

export const isDatum = (v: any): v is Datum => typeof v === "object" && v !== null && v[DATUM] === true;

// A value that is not a procedure but can be called (Lua's __call): `value[TRY_CALL]`, a field or a getter, is the
// procedure to call instead, with the value before the arguments, or <#void> when it cannot be called
export const TRY_CALL = Symbol("try-call");

export interface TryCall {
    readonly [TRY_CALL]: any;
}

export abstract class OpaqueValue {
    abstract get typeName(): string;
}

export class IProcedure {
    constructor(public debugName?: string) {}
}

// Normalizes an expression
export const normalizeExpr = (expr: any): any =>{
    if (isDatum(expr)) return expr.copy(normalizeExpr);
    if (Array.isArray(expr)) {
        return expr.map(normalizeExpr);
    }
    return expr;
}

export const ensureCanBind = (param: any, seen: Set<symbol> | undefined, syntaxCtx: string) => {
    if (typeof param !== "symbol") throw new VMError(Msg.ParamNotSymbol, [syntaxCtx, param]);
    if (seen) {
        if (seen.has(param)) throw new VMError(Msg.DuplicateParam, [syntaxCtx, param]);
        seen.add(param)
    }
    if (SPECIAL_FORMS.has(param)) throw new VMError(Msg.BadSyntax, [param]);
}

/** A simple structure for registering constants */
export class ConstPool {
    #known: Map<unknown, number>;
    public constants: any[]
    constructor() {
        this.constants = []
        this.#known = new Map()

        // pre-reserve constants
        this.push(false)
        this.push(true)
        this.push(null)
        this.push(undefined)
    }

    // Register a object with the constant pool
    push(s: unknown) {
        // Try to deduplicate anything
        if (s === null || typeof s !== "object") {
            const idx = this.#known.get(s)
            if(idx !== undefined) {
                return idx
            } else {
                const idx = this.constants.push(s) - 1
                this.#known.set(s, idx)
                return idx
            }
        }

        // TODO: Deduplicate stuff later
        return this.constants.push(this.#freezeObj(s)) - 1
    }

    mutPush(s: unknown) {
        return this.constants.push(s) - 1
    }

    #freezeObj(obj: any) {
        if (typeof obj !== "object" || obj === null || isDatum(obj)) return obj;
        Object.keys(obj).forEach(prop => {
            if (typeof obj[prop] === 'object' && !Object.isFrozen(obj[prop])) {
                this.#freezeObj(obj[prop]);
            }
        });
        return Object.freeze(obj);
    }
}

let n = 0
export const symGen = (base: string) => {
    return Symbol(`${base}${n++}`)
}
