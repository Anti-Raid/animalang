// how native-scheme words the VM's and the compiler's messages (see Msg), and shows values in them, as its reader reads
// them: `(1 2)` an array, `#t`, `#null`, `#void`, `12n`
import { ErrorObject, IProcedure, Msg, formatPos, type Formatter, type SourcePos } from "../common";

export const showValue = (x: any, seen: Set<any> = new Set()): string => {
    if (x === true) return "#t";
    if (x === false) return "#f";
    if (x === null) return "#null";
    if (x === undefined) return "#void";
    if (typeof x === "string") return JSON.stringify(x);
    if (typeof x === "bigint") return `${x}n`;
    if (typeof x === "symbol") return x.description ?? "?";
    if (Array.isArray(x)) {
        if (seen.has(x)) return "#<cycle>";
        seen.add(x);
        const out = `(${x.map(y => showValue(y, seen)).join(" ")})`;
        seen.delete(x);
        return out;
    }
    if (x instanceof IProcedure) return `#<procedure ${x.debugName ?? "?"}>`;
    if (x instanceof ErrorObject) return `#<error ${x.error instanceof Error ? x.error.message : showValue(x.error, seen)}>`;
    return String(x);
};

const show = (fmt: Formatter, at: SourcePos | null, x: any): string => fmt(Msg.Value, [x], fmt, at);
const name = (x: any): string => typeof x === "symbol" ? x.description ?? String(x) : String(x);

export const nativeFormat: Formatter = (op, args, fmt, at) => {
    const a = args;
    switch (op) {
        case Msg.Value: return showValue(a[0]);
        case Msg.Unhandled: return a[0] instanceof Error ? a[0].message : show(fmt, at, a[0]);
        case Msg.TracebackHeader: return `${a[0] !== undefined ? String(a[0]) + "\n" : ""}stack traceback:`;
        case Msg.TracebackFrame: {
            const tails: { name: string, count: number }[] | null = a[2];
            const trail = tails === null || tails.length === 0 ? "" : ` (tail calls: ${tails.map(c => c.count > 1 ? `${c.name} x${c.count}` : c.name).reverse().join(" <- ")})`;
            return `  ${formatPos(a[1])} in ${a[0]}${trail}`;
        }
        case Msg.MissingVar: return `unbound variable ${name(a[0])}`;
        case Msg.NonProcedure: return `not a procedure: ${show(fmt, at, a[0])}`;
        case Msg.NonProcedureWind: return `%dynamic-wind: not a procedure: ${show(fmt, at, a[0])}`;
        case Msg.Arity: {
            const [who, min, max, nargs] = a;
            const expected = min === max ? `exactly ${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
            return `${who}: expected ${expected} args, got ${nargs}`;
        }
        case Msg.ExpectedArray: return `${a[0]}: expected an array but got ${show(fmt, at, a[1])}`;
        case Msg.ValuesCount: return `%let-values: expected ${a[1] ? "at least " : ""}${a[0]} value${a[0] === 1 ? "" : "s"} but got ${a[2]}`;
        case Msg.ContinuationBoundary: return "cannot call a continuation across a host call";
        case Msg.EscapeBoundary: return "cannot call an escape continuation across a host call";
        case Msg.ContinuationArgs: return `a continuation takes exactly 1 argument, got ${a[0]}`;
        case Msg.EscapeArgs: return `an escape continuation takes exactly 1 argument, got ${a[0]}`;
        case Msg.EscapeOutsideExtent: return "an escape continuation called outside its extent";
        case Msg.CatchOutsideExtent: return "%catch: called outside its extent";
        case Msg.HandlerReturned: return "a handler returned from a non-continuable raise";
        case Msg.BadContinuable: return `%raise: continuable must be ${show(fmt, at, true)} or ${show(fmt, at, false)}`;
        case Msg.BadStackSkip: return "%current-stack: expected a count of frames to skip";
        case Msg.ExpectedMarkSet: return `${a[0]}: expected a continuation mark set`;
        case Msg.ExpectedClosure: return `${a[0]}: expected a closure but got ${show(fmt, at, a[1])}`;
        case Msg.ExpectedFinally: return `${a[0]}: expected a finally procedure but got ${show(fmt, at, a[1])}`;
        case Msg.ExpectedCoroutine: return `${a[0]}: expected a coroutine but got ${show(fmt, at, a[1])}`;
        case Msg.CannotResume: return `${a[0]}: cannot resume a ${a[1]} coroutine`;
        case Msg.CannotClose: return `${a[0]}: cannot close a ${a[1]} coroutine`;
        case Msg.YieldOutside: return "%coroutine-yield: not inside a coroutine (or across a host call)";
        case Msg.YieldClosing: return "%coroutine-yield: cannot yield while a coroutine is closing";
        case Msg.EmptyForm: return "bad syntax: ()";
        case Msg.IfArgs: return `%if: needs a condition and a branch, got ${a[0]} arguments`;
        case Msg.QuoteArgs: return `%quote: needs one datum, got ${a[0]}`;
        case Msg.FormArgs: return `${a[0]} requires ${a[1]}, got ${a[2]}`;
        case Msg.LambdaForm: return "%lambda: each clause is (options (param ...) rest-or-#null body ...)";
        case Msg.SetTarget: return `%set!: ${name(a[0])} is not a name`;
        case Msg.EscapeNoBlock: return `%escape: no enclosing block named ${name(a[0])}`;
        case Msg.EscapeFromLambda: return `%escape: cannot escape to block ${name(a[0])} from inside a lambda`;
        case Msg.BadSyntax: return `${name(a[0])}: bad syntax`;
        case Msg.ParamNotSymbol: return `${a[0]}: a parameter must be a name, got ${name(a[1])}`;
        case Msg.DuplicateParam: return `${a[0]}: ${name(a[1])} is bound twice`;
        case Msg.CannotBindBuiltin: return `${a[0]}: cannot bind ${name(a[1])}, which the instance provides`;
        case Msg.CannotBindIntrinsic: return `${a[0]}: cannot bind ${name(a[1])}, which is an intrinsic`;
        case Msg.IntrinsicAsValue: return `${name(a[0])} is an intrinsic, not a value (call it with %intcall)`;
        case Msg.ErrorInHandler: return `error in error handling: ${a[0] instanceof ErrorObject ? a[0].error?.message ?? show(fmt, at, a[0]) : show(fmt, at, a[0])}`;
        case Msg.CatchGuard: return "%catch: guarded must be #t or #f";
        case Msg.NoPrompt: return `no continuation prompt tagged ${show(fmt, at, a[0])}`;
        case Msg.LambdaOption: return `%lambda: unknown clause option ${name(a[0])}`;
        case Msg.UnreachableClause: return "%lambda: a clause after a padded one would never run";
        case Msg.BarrierReentry: return "cannot re-enter a continuation barrier";
        case Msg.NoClause: return `${a[0]}: no clause takes ${a[1]} args`;
        case Msg.BareCall: return `bad syntax: ${name(a[0])} is not a core form (a call is (%call proc arg ...) or (%intcall %name arg ...))`;
        case Msg.UnknownIntrinsic: return `${a[0]}: ${name(a[1])} is not an intrinsic`;
        case Msg.ApplyNonLeaf: return `%intapply: ${a[0]} is not a leaf intrinsic, so it cannot be applied`;
        case Msg.Text: return a[0];
        default: {
            const unworded: never = op;
            return `message ${unworded}`;
        }
    }
};
