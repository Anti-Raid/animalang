import { ErrorObject, Msg, formatPos, type Formatter, type SourcePos } from "../common";
import { ASTStringifier } from "./printer";

const PRINTER = new ASTStringifier();

const show = (fmt: Formatter, at: SourcePos | null, x: any): string => fmt(Msg.Value, [x], fmt, at);
const name = (x: any): string => typeof x === "symbol" ? x.description ?? String(x) : String(x);

// how Scheme words the VM's and the compiler's messages (see Msg), and shows values in them
export const schemeFormat: Formatter = (op, args, fmt, at) => {
    const a = args;
    switch (op) {
        case Msg.Value: return PRINTER.stringify(a[0]);
        case Msg.Unhandled: return a[0] instanceof Error ? a[0].message : show(fmt, at, a[0]);
        case Msg.TracebackHeader: return `${a[0] !== undefined ? String(a[0]) + "\n" : ""}stack traceback:`;
        case Msg.TracebackFrame: {
            const tails: { name: string, count: number }[] | null = a[2];
            const trail = tails === null || tails.length === 0 ? "" : ` (tail calls: ${tails.map(c => c.count > 1 ? `${c.name} x${c.count}` : c.name).reverse().join(" <- ")})`;
            return `  ${formatPos(a[1])} in ${a[0]}${trail}`;
        }
        case Msg.MissingVar: return `Variable '${name(a[0])}' is not defined in the current scope.`;
        case Msg.NonProcedure: return `Attempted to call a non-procedure: ${show(fmt, at, a[0])}`;
        case Msg.NonProcedureWind: return `Attempted to call a non-procedure in dynamic-wind: ${show(fmt, at, a[0])}`;
        case Msg.Arity: {
            const [name, min, max, nargs] = a;
            const expected = min === max ? `exactly ${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
            return `${name}: expected ${expected} args, got ${nargs}`;
        }
        case Msg.ExpectedArray: return `${a[0]}: expected an array but got ${show(fmt, at, a[1])}`;
        case Msg.ValuesCount: return `let-values: expected ${a[1] ? "at least " : ""}${a[0]} value${a[0] === 1 ? "" : "s"} but got ${a[2]}`;
        case Msg.ContinuationBoundary: return "Cannot invoke a continuation across execution/FFI boundary";
        case Msg.EscapeBoundary: return "Cannot invoke an escape continuation across execution/FFI boundary";
        case Msg.ContinuationArgs: return `continuation expected exactly 1 argument, but received ${a[0]}`;
        case Msg.EscapeArgs: return `escape continuation expected exactly 1 argument, but received ${a[0]}`;
        case Msg.EscapeOutsideExtent: return "escape continuation invoked outside of its dynamic extent";
        case Msg.CatchOutsideExtent: return "catch invoked outside of its dynamic extent";
        case Msg.HandlerReturned: return "handler returned on non-continuable exception";
        case Msg.BadContinuable: return `%raise: continuable must be ${show(fmt, at, true)} or ${show(fmt, at, false)}`;
        case Msg.BadStackSkip: return "%current-stack: expected a count of frames to skip";
        case Msg.ExpectedMarkSet: return `${a[0]}: expected a continuation mark set`;
        case Msg.ExpectedClosure: return `${a[0]}: expected a closure but got ${show(fmt, at, a[1])}`;
        case Msg.ExpectedFinally: return `${a[0]}: expected a finally procedure but got ${show(fmt, at, a[1])}`;
        case Msg.ExpectedCoroutine: return `${a[0]}: expected a coroutine but got ${show(fmt, at, a[1])}`;
        case Msg.CannotResume: return `${a[0]}: cannot resume a ${a[1]} coroutine`;
        case Msg.CannotClose: return `${a[0]}: cannot close a ${a[1]} coroutine`;
        case Msg.YieldOutside: return "coroutine-yield: not inside a coroutine (or across a host call boundary)";
        case Msg.YieldClosing: return "coroutine-yield: cannot yield while a coroutine is closing";
        case Msg.EmptyForm: return "bad syntax: an empty form";
        case Msg.IfArgs: return `%if requires at least a condition and a branch: (%if c1 e1 c2 e2 ... [else]), but got ${a[0]} arguments`;
        case Msg.QuoteArgs: return `quote must be in format ["quote", expr] but have ${a[0]} arguments`;
        case Msg.FormArgs: return `${a[0]} requires ${a[1]}, got ${a[2]}`;
        case Msg.LambdaForm: return "%lambda must be of form [%lambda, [options, [param ...], rest-or-null, body ...] ...]";
        case Msg.SetTarget: return `set!: ${name(a[0])} is not a symbol`;
        case Msg.EscapeNoBlock: return `%escape: no enclosing block named ${String(a[0].description)}`;
        case Msg.EscapeFromLambda: return `%escape: cannot escape to block ${String(a[0].description)} from inside a lambda`;
        case Msg.BadSyntax: return `${name(a[0])}: bad syntax`;
        case Msg.ParamNotSymbol: return `${a[0]} parameter must be a symbol, but received ${typeof a[1]}: ${name(a[1])}`;
        case Msg.DuplicateParam: return `${a[0]} parameter is a duplicate parameter name: ${name(a[1])}`;
        case Msg.CannotBindBuiltin: return `${a[0]}: cannot bind builtin ${Symbol.keyFor(a[1])}`;
        case Msg.CannotBindIntrinsic: return `${a[0]}: cannot bind ${String(a[1].description)}, which is an intrinsic`;
        case Msg.IntrinsicAsValue: return `${String(a[0].description)} is an intrinsic and cannot be used as a procedure value`;
        case Msg.ErrorInHandler: return `error in error handling: ${a[0] instanceof ErrorObject ? a[0].error?.message ?? show(fmt, at, a[0]) : show(fmt, at, a[0])}`;
        case Msg.CatchGuard: return "%catch: guarded must be #t or #f";
        case Msg.NoPrompt: return `no continuation prompt tagged ${show(fmt, at, a[0])}`;
        case Msg.LambdaOption: return `%lambda: unknown clause option ${name(a[0])}`;
        case Msg.UnreachableClause: return "%lambda: a clause after a padded one would never run";
        case Msg.BarrierReentry: return "cannot re-enter a continuation barrier";
        case Msg.NoClause: return `${a[0]}: no clause takes ${a[1]} args`;
        case Msg.BareCall: return `bad syntax: ${name(a[0])} is not a core form (a call is (%call proc arg ...) or (%intcall %name arg ...))`;
        case Msg.UnknownIntrinsic: return `${a[0]}: ${name(a[1])} is not an intrinsic`;
        case Msg.ApplyNonLeaf: return `%apply: ${a[0]} is not a leaf intrinsic, so it cannot be applied`;
        case Msg.Text: return a[0];
        case Msg.NotReentrant: return `cannot re-enter a continuation through ${a[0]}: its code was compiled as not re-entrant`;
        default: {
            const unworded: never = op;
            return `message ${unworded}`;
        }
    }
};
