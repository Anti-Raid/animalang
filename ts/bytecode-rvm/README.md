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
  - Runtime-list variant of `%apply`: the elements of `<lst>` are the arguments, with the last element spliced in the same way (e.g. `$apply` passes its rest parameter here).
  - Emits `OpCode.APPLYLIST` (in non-tail position) or `OpCode.TAILAPPLYLIST` (in tail position) with the register holding `<lst>`.

### Arithmetic intrinsics
- **Forms**: `(%+ <arg> ...)`, `%-`, `%*`, `%/`, `%modulo`, `%remainder`, `%=`, `%eq?`, `%<`, `%<=`, `%>`, `%>=`
- **Semantics**:
  - All compile to one `ARITHMETIC` opcode over the register window `[startReg, startReg + nargs)`, indexing the `ARITHMETIC` table in `ts/ops.ts`, with the usual Scheme variadic behaviour (`(%- x)` negates, `(%/ x)` is `1/x`, comparisons chain).
  - Intrinsics are not values, so they cannot be passed to `%apply` / `%apply-multi`.

### List intrinsics
- **Forms**: `(%list <arg> ...)`, `(%cons a d)`
- **Semantics**: Each compiles to one opcode (`LIST`, `CONS`) over the register window `[startReg, startReg + nargs)`. `%list` builds a fresh proper list.

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
- `+ - * / modulo remainder = eq? < <= > >=`:
  - The syntax transformer rewrites direct calls into the matching intrinsic, e.g. `(+ a b c)` becomes `(%+ a b c)`.
  - Uses as a value (e.g. `(map + xs ys)`) get the builtin of the same name, whose callback is the same operation function the opcode runs (`ts/ops.ts`), so there is no duplicated logic.
- `cons`: Direct calls are rewritten to the matching `%` form. Uses as a value get the builtin of the same name, whose callback is the same function the opcode runs (`ts/ops.ts`).
- Single-argument predicates (`null? pair? list? number? integer? ... table-frozen?`, the `PREDICATES` table in `ts/ops.ts`): Direct calls are rewritten to `%` forms (e.g. `(null? x)` becomes `(%null? x)`), which all compile to one `PREDICATE` opcode indexing the table. Uses as a value get a builtin generated from the same table.
- `car`, `cdr`, `caar` ... `cddddr` (all compositions up to 4 levels) and `first second third`: Direct calls are rewritten to `%` forms (e.g. `(third x)` becomes `(%third x)`), which all compile to one `CXR` opcode indexing `CXR_PATHS` in `ts/ops.ts`. Uses as a value get the builtin of the same name, which runs the same function, so errors name the procedure either way (e.g. `third: list is too short`).
- `list`:
  - Direct calls `(list a b ...)` are rewritten to `(%list a b ...)`.
  - Uses as a value resolve to the prelude procedure `(define $list (lambda args args))`, since a rest parameter is already a fresh list.
- Builtins cannot be rebound.
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
