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

### `%push-exception-handler!`
- **Form**: `(%push-exception-handler! <handler>)`
- **Semantics**: Pushes `<handler>` onto the active exception handler stack. Returns `undefined`.

### `%pop-exception-handler!`
- **Form**: `(%pop-exception-handler!)`
- **Semantics**: Pops the most recently installed exception handler from the stack. Returns `undefined`.

### `%raise`
- **Form**: `(%raise <obj>)`
- **Semantics**: Invokes the active exception handler with `<obj>` as a non-continuable exception. If the handler returns without invoking an escape continuation, an unhandled exception error is raised.

### `%raise-continuable`
- **Form**: `(%raise-continuable <obj>)`
- **Semantics**: Invokes the active exception handler with `<obj>`. If the handler returns, its return value resumes execution at the call site.

## Standard Library & Prelude Mappings

The standard library builds the public Scheme exception and dynamic-wind procedures on top of these `%` intrinsics:

- `call/cc` and `call-with-current-continuation`: Wraps `(%call/cc proc)`
- `dynamic-wind`: Wraps `(%dynamic-wind before thunk after)`
- `with-exception-handler`:
  ```scheme
  (define $with-exception-handler
      (lambda (handler thunk)
          (%push-exception-handler! handler)
          (let ((res (thunk)))
              (%pop-exception-handler!)
              res)))
  ```
- `raise`: Wraps `(%raise obj)`
- `raise-continuable`: Wraps `(%raise-continuable obj)`
- `try-catch`:
  ```scheme
  (define $try-catch
      (lambda (thunk catch-proc)
          (call/cc
              (lambda (k)
                  (with-exception-handler
                      (lambda (err) (k (catch-proc err)))
                      thunk)))))
  ```
- `guard`: Desugared into `call/cc` and `with-exception-handler` using uninterned symbols.
