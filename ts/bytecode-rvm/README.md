# Compiler Syntax Specification

This document details the exact syntax forms and special forms handled directly by the compiler, as well as the exposed compiler intrinsics and their standard prelude mappings.

## Syntax Forms

### Atoms and Literals

- **Symbols**: Evaluated as variable references resolved based on lexical scoping (local scope, enclosing function scope, or global scope).
- **Null**: The empty list (`'()`).
- **Primitives**: Numbers, strings, booleans, and undefined constants.

### Special Forms

- **`begin`**
  - Form: `(begin <expr> ...)`
  - Sequentially evaluates all child expressions. Only the final child yields the value of the `begin` expression and preserves tail position. Empty `(begin)` evaluates to `undefined`.

- **`if`**
  - Form: `(if <condition> <then-expr> <else-expr>)`
  - Evaluates `<condition>`. If truthy, evaluates `<then-expr>`; otherwise evaluates `<else-expr>`. Both branches inherit the tail position of the enclosing expression.

- **`quote`**
  - Form: `(quote <datum>)`
  - Yields `<datum>` as a literal data structure without evaluating it.

- **`define`**
  - Form: `(define <symbol> <val-expr>)`
  - Evaluates `<val-expr>` and binds `<symbol>` in the global scope.

- **`set!`**
  - Form: `(set! <symbol> <val-expr>)`
  - Evaluates `<val-expr>` and updates the binding of `<symbol>` according to lexical scoping.

- **`lambda`**
  - Form: `(lambda (<param> ...) <body>)` or `(lambda (<param> ... . <rest-param>) <body>)`
  - Creates a closure capturing its lexical environment, with either fixed arity or variadic parameters.

### Procedure Calls

- **Builtin Calls**:
  - Form: `(<builtin-name> <arg> ...)`
  - Invokes a registered standard library builtin procedure directly.
- **General Calls**:
  - Form: `(<proc-expr> <arg> ...)`
  - Evaluates `<proc-expr>` and all arguments, executing a procedure call (or tail call if in tail position).

## Compiler Intrinsics (`%` Forms)

The compiler directly recognizes the following low-level `%` intrinsics:

### `%dynamic-wind`
- **Form**: `(%dynamic-wind <before> <thunk> <after>)`
- **Semantics**:
  1. Calls `<before>` with 0 arguments.
  2. Enters dynamic wind extent with `<before>` and `<after>`.
  3. Calls `<thunk>` with 0 arguments and records its result.
  4. Exits dynamic wind extent.
  5. Calls `<after>` with 0 arguments.
  6. Returns the result of `<thunk>`.
  When a continuation crosses this dynamic extent, transitions automatically run the appropriate `<before>` and `<after>` thunks.

### `%call/cc`
- **Form**: `(%call/cc <proc>)`
- **Semantics**:
  - In non-tail position: Captures the current continuation and passes it as a single argument to `<proc>`.
  - In tail position: Replaces the current frame with the caller's continuation and tail-calls `<proc>`.

### `%set-raise-proc`
- **Form**: `(%set-raise-proc <proc>)`
- **Semantics**: Registers `<proc>` as the runtime exception raising procedure on the execution context. When host exceptions or runtime errors occur, the VM delegates to this procedure to trigger Scheme-level exception handling.

### `%define-global`
- **Form**: `(%define-global <symbol> <val-expr>)`
- **Semantics**: Evaluates `<val-expr>` and binds `<symbol>` directly in the global scope (an alias of `define` for prelude use).

### `%apply`
- **Form**: `(%apply <proc> <arg> ... <lst>)`
- **Semantics**:
  - Unpacks the trailing `<lst>` argument and splices its elements after any preceding `<arg> ...` expressions before calling `<proc>`.
  - Resolves `<proc>` with compile-time builtin optimization (`#resolveProcReg`): if `<proc>` is an unshadowed reference to a standard library builtin, references the builtin directly via its intrinsic index (`BUILTINS_START + idx`), avoiding temporary register allocation and `LoadGlobal`.
  - Emits `OpCode.APPLY` (in non-tail position) or `OpCode.TAILAPPLY` (in tail position) with `nargs >= 1` indicating the width of the register window `[startReg, startReg + nargs)`.

### `%apply-multi`
- **Form**: `(%apply-multi <proc> <lst>)`
- **Semantics**:
  - Dynamic runtime-list variant of `apply` where all arguments are provided in a Scheme list `<lst>` (e.g. from variadic rest parameters).
  - Emits `OpCode.APPLY` or `OpCode.TAILAPPLY` with `nargs = -1`, directing the interpreter and JIT compiler to unpack `<lst>` dynamically at runtime.

## Standard Library & Prelude Mappings

The standard library builds the public Scheme procedures on top of these `%` intrinsics:

- `apply`:
  - Syntactic applications `(apply proc arg ... lst)` are transformed by the syntax transformer directly into `(%apply proc arg ... lst)`.
  - Higher-order / aliased references `apply` resolve to the standard prelude procedure:
    ```scheme
    (define $apply
        (lambda (proc . lst)
            (%apply-multi proc lst)))
    ```
- `call/cc` and `call-with-current-continuation`: Wraps `(%call/cc proc)`
- `dynamic-wind`: Wraps `(%dynamic-wind before thunk after)`
- `with-exception-handler`:
  Implemented on top of `%dynamic-wind` to manage the active handler stack across continuation captures and invocations:
  ```scheme
  (define $with-exception-handler
      (lambda (handler thunk)
          (let ((prev current-handlers))
              (%dynamic-wind
                  (lambda () (set! current-handlers (cons handler current-handlers)))
                  thunk
                  (lambda () (set! current-handlers prev))))))
  ```
- `raise`: Invokes the topmost handler from `current-handlers` after popping it from the chain. If the handler returns without escaping, raises a non-continuable error.
- `raise-continuable`: Temporarily pops the current handler using `%dynamic-wind`, invokes the handler, and resumes with its return value.
- `try` and `try-catch`:
  ```scheme
  (define $try-catch
      (lambda (thunk catch-proc)
          (%call/cc
              (lambda (k)
                  (with-exception-handler
                      (lambda (err) (k (catch-proc err)))
                      thunk)))))
  ```
- `guard`: Desugared into `call/cc` and `with-exception-handler` using uninterned symbols.
