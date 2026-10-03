# Anima Language

Anima is the custom (Scheme-inspired) language used in settings v2 in antiraid for dynamic branching + complex client-side validation etc.

## Migrating to the intrinsics API

The host API changed. Host functions now go through intrinsics only: there are no host callbacks anymore (`BuiltinFunction` is gone), and a JS function placed in scope is not a procedure Anima code can call.

- **Creating an instance**: `new Anima(implRvm)` is now `createScheme(implRvm)` (or `implRvmDebug` for exact error positions and tail calls in tracebacks). Code always runs compiled to JS: there is no interpreter and no `implRvmAot`. `new Anima(options)` still exists, but makes a bare instance with no language: no reader, builtins or prelude.
- **Registering host functions**: the global `registerHostIntrinsic(name, fn, options)` is now `anima.registerIntrinsic(name, fn, options)`. Each instance has its own intrinsics. Names start with `%`, and a name only works in code compiled after it is registered. `anima.freeze()` stops further registrations.
- **The function signature is `fn(regs, start, nargs)`**: the arguments are `regs[start]` to `regs[start + nargs - 1]`. `registerHostIntrinsic` functions took `(...args)` and need porting; `BuiltinFunction` callbacks already had this signature. Do not keep `regs` after the call returns.
- **Options**: `{ args: [min, max], leaf, inline, deps }`. The argument count is checked when code compiles. Set `leaf: true` for a function that only computes a value; it is cheaper to call and can have an inline template for AOT code.
- **Calling back into Anima**: an intrinsic that is not a leaf calls an Anima procedure by returning `hostTail(proc, ...args)` (or `hostTailFrom(proc, regs, from, count)`) instead of calling it itself. The call then runs in the VM, so the procedure can yield, capture continuations and raise.
- **Yielding from the host**: an intrinsic that is not a leaf yields the coroutine running it by returning `hostYield(...values)`; the values the coroutine is resumed with are the value of the call.
- **Calling host functions from Scheme**: Scheme code cannot name intrinsics: a `%` name in Scheme source is an ordinary identifier, so `(%clamp x 0 10)` no longer calls the intrinsic. Define a procedure for each in native-scheme (`compileNative`): `(define-intrinsic clamp %clamp)`, or one written out with intrinsic calls like `%[%clamp x lo hi]`, and call that from Scheme. Such a procedure is also how an intrinsic becomes a value.
- **Calling back into Anima, and continuing**: `hostCall(proc, args, then)` calls `proc` and goes on with `then(value)`, as often as an intrinsic needs (a sort with a comparator, say); the callback can yield, raise and capture continuations.
- **Serialized code is gone**: `dumpFull` / `readFull` no longer exist. Compile from source in each instance.

```ts
import { createScheme, compileNative, implRvm, hostTail } from "animalang";

const anima = createScheme(implRvm); // was: new Anima(implRvm)

// a leaf: computes a value from its arguments, never calls back into Anima
anima.registerIntrinsic("%clamp", (regs, start) => Math.min(Math.max(regs[start], regs[start + 1]), regs[start + 2]), { args: [3, 3], leaf: true });
// not a leaf: calls an Anima procedure by returning a tail request
anima.registerIntrinsic("%with-double", (regs, start) => hostTail(regs[start], regs[start + 1] * 2), { args: [2, 2] });

// Scheme reaches them through procedures defined in native-scheme
anima.evaluateRaw(compileNative(anima, `
  (define-intrinsic clamp %clamp)
  (define-intrinsic with-double %with-double)`));

anima.evaluateRaw(anima.compileRaw(`
  (list (map (lambda (x) (clamp x 0 10)) '(-5 5 50)) (with-double (lambda (y) (+ y 1)) 5))`)); // ((0 5 10) 11)
```

See `ts/magicvm/README.md` (intrinsics), `ts/scheme/README.md` (the Scheme front end) and `ts/native/README.md` (native-scheme) for the details.

## Specification

### Grammar

Anima uses a (simplified) Scheme-like grammar based on 's-expressions'

```
<program>   ::= <expr>* 
<expr>      ::= <primitive> | <list> | <table-lit> | <quoted>
<primitive> ::= <null> | <boolean> | <number> | <string> | <symbol>
<null>    ::= null
<boolean> ::= true | false
<number>  ::= [0-9]+ ("." [0-9]+)? 
<string>  ::= "[json/lisp escaped string]"
<special> ::= ( | ) | [ | ] | { | } | ; | " | '
<symbol>  ::= [character (excluding <special> and whitespace)]+
<list>    ::= (<expr>*) | [<expr>*]
<table-lit> ::= { (<expr> <expr>)* }
<quoted>  ::= '<expr>
```

Comments begin with ; and continue to the end of the line.

### Execution

- Strings and symbols are distinct data types. String literals (e.g., "hello") evaluate to themselves as string primitives
- Unquoted symbols (e.g. my-var) are evaluated as dynamic variable lookups in the lexical scope.
- A quoted expression like ``'<expr>`` should have the same effect as ``(quote <expr>)``. Quoting a symbol (e.g., ``'my-var``) returns an interned 
symbol rather than performing a variable lookup.
- Multiple top-level expressions should be evaluated sequentially with the result being the result of the last expression (one way
to achieve this is to parse multiple top-level expressions expr1 expr2... in a begin block like (begin expr1 expr2 ...))

### Other Rules

1. Like Scheme, Anima makes use of lexical scoping. Nested scopes inherit parent variables and can 'shadow' parent variables of the same name. Builtin procedures (`car`, `map`, `list`, ...) can be shadowed too, locally or by a top-level `define`; special forms (`if`, `lambda`, `cond`, ...) and `%` intrinsics cannot.
`define` strictly mutates or initializes within the local execution scope and never the parent scope and variables in the outermost scope 
cannot be reassigned or mutated whatsoever for sandboxing purposes.

2. Truthiness: false (`#f`) is falsy. All other values are truthy (including `#<void>`)

3. Tail-Call Optimization (TCO): The runtime must execute the final expression in begin, if, and, or, and custom procedure calls without allocating a new frame on the host call stack.

4. Anima does not support macros/custom syntax currently. Although compliant implementations *may* choose to additionally support this for future use, code written in Anima must *not* assume support for macros/custom syntax.

5. A top-level `define` of a builtin procedure's name redefines it from then on (see rule 1), and the name cannot be read before that definition has run. Special forms and `%` intrinsics cannot be redefined: compliant implementations of Anima should error if an attempt to do so is detected

6. Like Scheme, all procedures in Anima (including builtin procedures that are *not* special forms) must be first class. Furthermore, both builtin
and user-defined procedures must return `procedure` if type? is called on it.

### Special Forms

- ``(define varname value)``: Evaluates ``value`` and binds it to ``varname`` *globally*. A define inside a ``lambda`` (internal lambda) is hoisted/treated as a ``letrec``
- ``(define (varname [args]) exprs...)``: Shorthand for ``(define varname (lambda [args] exprs...))``
- ``(set! varname value)``: Evaluates ``value`` and binds it to ``varname`` in the current scope (mutates `varname` in the current scope)
- ``(quote expr)``: Returns the expression without evaluating it. Any raw identifiers within the quoted expression (or deeply nested 
within quoted lists) are converted into symbols
- ``(lambda [args] exprs...)``: Returns a closure capturing the current lexical scope. If multiple `exprs...` are provided, 
they are evaluated sequentially with the last result returned. ``[args]`` can either be of form ``(args...)`` (arity of `args...` length), `args` (variadic with all args to the lambda collapsed into a list and placed in `args`) or ``(args... . rem-params)`` (minimum arity of `args...` length with all variadic arguments collapsed into a list and placed in ``rem-params``)
- ``(if cond true-expr false-expr)``: Evaluates ``cond``. If truthy, evaluates to `trye-expr`, else ``false-expr``
- ``(cond clauses...)``: Each clause must be a list of exactly two elements: ``(condition expr)``. Each condition must be executed in 
order. Upon encountering the first truthy clause condition (or the exact symbol ``else``), expr is evaluated and returned. If there are no clauses or if no 
conditions match, returns `#<void>`. Throws an error if any clause is malformed.
- ``(and expr...)``: Short-circuits on the first falsy evaluation or returns the value of the last expression in ``expr...``. Returns true if 0 arguments.
- ``(or expr...)``: Short-circuits on the first truthy evaluation or returns the value of the last expression in ``expr...``. Returns false if 0 arguments.
- ``(begin expr...)``: Evaluates arguments sequentially. Returns the result of the last expression.
- ``let/let*/letrec``: Same as Scheme ``let/let*/letrec`` (TODO: Write docs here for this as well)

### Builtin procedures

#### List Operations
- list (expr...): Evaluates arguments and returns them as a native array. Arity: >= 0.
- cons (a d): Returns a new list with a as head and d as tail. Arity: 2
- car (list): Returns the first element of the list. Throws if the list is empty. Arity: 1.
- cdr (list): Returns a new list excluding the first element. Throws if the list is empty. Arity: 1.
- last (list): Returns the final element of the list. Throws if the list is empty. Arity: 1.
- length (list | string): Returns the integer length. Returns 0 if the argument is neither a list nor string. Arity: 1.
- contains (list, item): Returns a boolean indicating strict inclusion of item within list. Arity: 2.

#### Table Operations

Tables are first-class associative maps (a JavaScript `Map`) with freezing support for safe FFI boundaries. Keys compare as `Map` keys do: `1` and `1.0` are the same key, and so are `0` and `-0`. A table never holds `<#void>`: storing `<#void>` under a key removes it. Iteration visits keys in insertion order.

- `{key1 val1 key2 val2 ...}`: Literal syntax for tables. Desugars at read time to `(table key1 val1 key2 val2 ...)`. Empty table literal `{}` desugars to `(table)`. Keys and values evaluate dynamically at runtime.
- `(table? val)`: Returns `#t` if `val` is an instance of `Table`, `#f` otherwise. Arity: 1.
- `(table [k1 v1 k2 v2 ...])`: Constructs a new mutable `Table`. Accepts 0 or an even number of arguments (alternating keys and values). Arity: 0 or even.
- `(table-ref tbl key [default])`: Looks up `key` in `tbl`. If `key` is not found, returns `default` if provided; otherwise throws an error. Arity: 2 or 3.
- `(table-set! tbl key val)`: Associates `key` with `val` in `tbl`, or removes `key` when `val` is `<#void>`. Throws an error if `tbl` is frozen. Returns `#<void>`. Arity: 3.
- `(table-has? tbl key)`: Returns `#t` if `key` exists in `tbl`, `#f` otherwise. Arity: 2.
- `(table-delete! tbl key)`: Deletes `key` and its associated value from `tbl`. Throws an error if `tbl` is frozen. Returns `#t` if the key was present and removed, `#f` otherwise. Arity: 2.
- `(table-clear! tbl)`: Removes all entries from `tbl`. Throws an error if `tbl` is frozen. Returns `#<void>`. Arity: 1.
- `(table-size tbl)`: Returns the number of entries stored in `tbl`. Arity: 1.
- `(table-empty? tbl)`: Returns `#t` if `tbl` is empty (`size === 0`), `#f` otherwise. Arity: 1.
- `(empty? val)`: Generic empty predicate also returns `#t` for empty tables.
- `(table-keys tbl)`: Returns a vector (native JavaScript array) containing all keys in `tbl`. Arity: 1.
- `(table-values tbl)`: Returns a vector (native JavaScript array) containing all values in `tbl`. Arity: 1.
- `(table-copy tbl)`: Creates a new unfrozen shallow copy of `tbl`. Arity: 1.
- `(table-freeze! tbl)`: Freezes `tbl` in place to prevent any future mutations (`table-set!`, `table-delete!`, `table-clear!`), and returns `tbl`. Arity: 1.
- `(table-frozen? tbl)`: Returns `#t` if `tbl` is frozen, `#f` otherwise. Arity: 1.
- `(table-merge! target source)`: Copies all key-value pairs from `source` into `target`. Throws an error if `target` is frozen. Returns `target`. Arity: 2.
- `(equal? a b)`: Performs deep recursive equality comparison across tables, vectors, lists, and primitives.

##### JavaScript `Table` Class (FFI / Interop)

The `Table` class exported from `animalang` provides clean integration with host TypeScript / JavaScript environments:

- **Constructor**: `new Table(frozen = false)`
- **Methods**: `.get(key)` (`undefined` when missing), `.lookup(key, missing)`, `.set(key, val)` (`undefined` removes the key), `.has(key)`, `.delete(key)`, `.clear()`, `.clone()` (a shallow copy)
- **Properties**: `.size`, `.frozen` (`tbl.frozen = true`)
- **Iteration**: Implements `Iterable<[any, any]>` (`for (const [k, v] of tbl)`), `.entries()`, `.keys()`, `.values()`

`LuaTable` (also exported, from `ts/lua/table.ts`) is the Lua front end's table: keys `1..n` live densely in an array part and the rest in a hash part, `.border()` is Lua's `#t`, and keys cannot be `<#void>` or NaN. It has the same methods.

Global environments are a separate class, `Env` (`anima.scope`), with `.get`, `.set`, `.has` and `.lookup`; an `Env` chains to its parent environment (user globals over the builtins).

#### Logic & Type Checking
- =: Checks if `n` number expressions are equal. Errors if any expression is not a number. Arity: >= 2.
- eq? + eqv?: Similar to Scheme's eqv?. If number/string, checks equality of num/string even if in different memory locations, eqv? should be ``Object.is``-style
(like Scheme) but eq? can do just ``===``
otheriwse checks pointer equality. Arity: 2
- equal?: Similar to Scheme's equal? but does a deep recursive comparison for lists etc.
- not: Returns true if the expression is falsy, otherwise returns false
- <, >, <=, >= (expr1, expr2, ... exprN): Strict comparison between expr1 to exprN. Arity: >= 2.
- type? (expr): Returns one of the following strings: "list", "string", "number", "boolean", "null", "symbol", "procedure", "list", "error", "exposed-prop". Arity: 1.
- error? (expr): Returns if ``expr`` is an ``ErrorObject`` or not
- error-message (expr): Returns the underlying error caught within ``expr`` if ``expr`` is an ``ErrorObject``. Throws an error if ``expr`` is not a ``ErrorObject``

#### Mathematics
- +, -, *, / (expr...): Evaluates sequentially from left to right. Arity: >= 2.
- ``(modulo expr1 expr2)``: Returns the mathematical modulo of ``expr1`` with ``expr2``
- ``(remainder expr1 expr2)``: Returns the mathematical remainder of ``expr1`` with ``expr2``

#### Misc
- ``(apply proc args... rem-lst)``: Same as Scheme specification on apply. Calls ``proc`` with the packed ``args... rem-lst`` as arguments for ``proc`` 
- ``(try proc args... rem-lst)``: Calls ``proc`` with the packed ``args... rem-lst`` as arguments for ``proc``. If ``proc`` errors, ``try`` evaluates to an
``res`` of type ``ErrorObject`` (whose ``type? res`` is ``error``, ``error? res`` yielding ``#t`` and ``error-message res`` containing the error caught by ``try`` while evaluating ``proc``)
- map: Same as Scheme specification on map (TODO: Write docs here for this as well)

## Deviations from Scheme

### No first-class continuations

In order to keep Anima simple to implement (and debug!), Anima does not support full first-class continuations *yet* (such as ``call-with-current-continuation`` or ``call/cc``) (although support for this may be implemented later at some point in the future). This also enables for potential future optimizations.