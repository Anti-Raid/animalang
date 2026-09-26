// Scheme's surface syntax: the transformer lowers these to the core forms

export const OP_DEFINE = Symbol.for("define");
export const OP_SET    = Symbol.for("set!")
export const OP_BEGIN     = Symbol.for("begin");
export const OP_LAMBDA = Symbol.for("lambda");
export const OP_LET    = Symbol.for("let");
export const OP_LETSTAR = Symbol.for("let*")
export const OP_LETREC = Symbol.for("letrec")
export const OP_IF     = Symbol.for("if");
export const OP_COND   = Symbol.for("cond");
export const OP_ELSE   = Symbol.for("else"); // part of cond but not a special form
export const OP_QUOTE  = Symbol.for("quote");
export const OP_AND      = Symbol.for("and");
export const OP_OR       = Symbol.for("or");
export const OP_AT = Symbol.for("%at");

// keywords code cannot bind
export const SCHEME_SPECIAL_FORMS: readonly symbol[] = [
    OP_DEFINE,
    OP_SET,
    OP_BEGIN,
    OP_LAMBDA,
    OP_LET,
    OP_LETSTAR,
    OP_LETREC,
    OP_IF,
    OP_COND,
    OP_ELSE,
    OP_QUOTE,
    OP_AND,
    OP_OR,
    Symbol.for("receive"),
    Symbol.for("let-values"),
    Symbol.for("let*-values"),
    OP_AT,
];

// procedures code cannot bind besides the builtins and the prelude's exports (the transformer rewrites their calls)
export const SCHEME_RESERVED: readonly symbol[] = ["apply", "call/cc", "call-with-current-continuation", "dynamic-wind"].map(name => Symbol.for(name));
