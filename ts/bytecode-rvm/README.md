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
  - Emits `OpCode.APPLY` (with its tail flag set in tail position) with `nargs >= 1` indicating the width of the register window `[startReg, startReg + nargs)`.

### `%apply-multi`
- **Form**: `(%apply-multi <proc> <lst>)`
- **Semantics**:
  - Runtime-list variant of `%apply`: the elements of `<lst>` are the arguments, with the last element spliced in the same way (e.g. `$apply` passes its rest parameter here).
  - Compiles as `(%apply <proc> <flattened>)`, where the `apply-args` runtime operation (`CALLRT`) first splices the last element of `<lst>` into a flat argument list.

### Arithmetic intrinsics
- **Forms**: `(%+ <arg> ...)`, `%-`, `%*`, `%/`, `%modulo`, `%remainder`, `%=`, `%eq?`, `%<`, `%<=`, `%>`, `%>=`
- **Semantics**:
  - All compile to a `CALL` of the builtin with the same name (the `ARITHMETIC` table in `ts/ops.ts`) over the register window `[startReg, startReg + nargs)`, with the usual Scheme variadic behaviour (`(%- x)` negates, `(%/ x)` is `1/x`, comparisons chain).
  - Intrinsics are not values, so they cannot be passed to `%apply` / `%apply-multi`.

### List intrinsics
- **Forms**: `(%list <arg> ...)`, `(%cons a d)`
- **Semantics**: Each compiles to a `CALL` of the `list` / `cons` builtin over the register window `[startReg, startReg + nargs)`. `%list` builds a fresh proper list.

### `%handlers` / `%set-handlers!`
- **Forms**: `(%handlers)`, `(%set-handlers! <lst>)`
- **Semantics**: Read and replace the current execution context's exception handler stack. Each context, and so each coroutine, has its own stack. Used by the prelude's `raise`, `raise-continuable` and `with-exception-handler`.

### Coroutine intrinsics
- **Forms**: `(%coroutine-create <proc>)`, `(%coroutine-resume <co> <val> ...)`, `(%coroutine-yield <val> ...)`, `(%coroutine-status <co>)`, `(%coroutine-close <co>)`, plus `(%coroutine-resume-list <co> <lst>)` / `(%coroutine-yield-list <lst>)` which take the values as a runtime list (used by the prelude wrappers)
- **Semantics**:
  - Asymmetric, one-shot coroutines. Each coroutine owns its own execution context (frames, wind stack, handler stack), so it can be resumed from any later evaluation, including by the host via `Anima.coroutineResume(co, ...vals)`, which returns `{ done, value, values }` (`value` is the first of `values`).
  - Resume and yield switch coroutines inside the driver loop (every frame records its execution context), so nothing nests on the JS stack. `%coroutine-resume` in tail position is a proper tail call: the coroutine's yields and final value go straight to the caller's caller, so chains of tail resumes (schedulers, symmetric hand-offs) run in constant space. It compiles to `CORESUME` (tail flag set in tail position) with the values as a list register.
  - The first resume passes its values as the procedure's arguments. Later resumes make the pending `%coroutine-yield` return their values, and `%coroutine-resume` returns the yielded values, both as multiple values (see `values`).
  - Status is one of `suspended`, `running`, `normal` (it resumed another coroutine) or `dead`. Resuming a non-suspended coroutine is an error.
  - An error the coroutine does not handle marks it `dead` and is raised again in the resumer as-is.
  - `dynamic-wind` thunks do not run on yield/resume, so global state changed by a wind thunk stays changed while the coroutine is suspended. Coroutine-local dynamic state belongs in the execution context (as the handler stack does).
  - `(%coroutine-close <co>)` runs a suspended coroutine's pending `dynamic-wind` after-thunks (innermost first, inside the coroutine) and marks it `dead`. Closing a dead coroutine does nothing, closing a running one is an error, and yielding during close is an error. The host equivalent is `Anima.coroutineClose(co)`.
  - Yielding from inside a Scheme callback invoked by a host builtin is an error (the callback runs in a separate execution context).

### How intrinsics are compiled
- **Pure functions over a register window** (`%+`, `%car`, `%null?`, `%list`, ...) that are also public builtins compile to `CALL idx start nargs 0; MOVEACC dst`, where `idx - BUILTINS_START` indexes `IBUILTINS`. The AOT decoder fuses the pair into one inline builtin call (no block split), and inlines the common ones by name.
- **Runtime operations that only need the execution context** (`%coroutine-create`, `%coroutine-status`, `%coroutine-close`, `%handlers`, `%set-handlers!`, `%set-raise-proc`, the wind/unwind steps of `%dynamic-wind`, and internal helpers with no public builtin: `%values->list` and the list/apply conversions behind `%coroutine-yield-list` and `%apply-multi`) compile to `CALLRT idx dst start nargs`, where `idx` indexes the `RUNTIME` table in `exec.ts`.
- **Control flow that suspends or leaves the frame** keeps dedicated opcodes: `CALL`, `APPLY`, `CALLCC` and `CORESUME` (each with a trailing `isTail` operand; non-tail forms are followed by `MOVEACC`), `RETURN` and `COYIELD` (which takes one register holding the already-packed yield value).

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
- Single-argument predicates (`null? pair? list? number? integer? ... table-frozen?`, the `PREDICATES` table in `ts/ops.ts`): Direct calls are rewritten to `%` forms (e.g. `(null? x)` becomes `(%null? x)`), which compile to a `CALL` of the builtin with that name. Uses as a value get a builtin generated from the same table.
- `car`, `cdr`, `caar` ... `cddddr` (all compositions up to 4 levels) and `first second third`: Direct calls are rewritten to `%` forms (e.g. `(third x)` becomes `(%third x)`), which compile to a `CALL` of the builtin with that name (generated from `CXR_PATHS` in `ts/ops.ts`). Uses as a value get the builtin of the same name, which runs the same function, so errors name the procedure either way (e.g. `third: list is too short`).
- `coroutine-create coroutine-resume coroutine-yield coroutine-status coroutine-close`: Direct calls are rewritten to the matching `%` form. Uses as a value resolve to prelude wrappers around the intrinsics.
- `values call-with-values`: `(values a b)` is a `MultipleValues` object (`common.ts`), `(values x)` is just `x` and `(values)` is zero values. `values` is a builtin, `call-with-values` is a prelude procedure (built on the `%values->list` intrinsic, which compiles to `CALLRT` and turns zero, one or multiple values into a list), and `receive`, `let-values` (parallel binding) and `let*-values` are syntax transformer macros built on `call-with-values`. Multiple values reaching a single-value context stay a `MultipleValues` object and print as `(values a b)`.
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

# Runtime Architecture

This section describes how compiled code runs. The code lives in `exec.ts` (runtime, interpreter and AOT compiler), `vm.ts` (entry points) and `ts/ops.ts` (the primitive operations shared by the interpreter, the AOT compiler and the builtins).

## Pipeline

1. The syntax transformer (`syntransformer-v1`) expands macros and rewrites calls to builtins into `%` intrinsic forms.
2. `analysis.ts` works out which variables are captured or mutated (those live in `Box`es).
3. `compiler.ts` turns the expression into IR nodes (`ir.ts`) over numbered registers, and `IR.lower` turns those into a `ByteCode` (a `Uint32Array` of instructions plus a constant pool).
4. The bytecode runs either in the interpreter (`BytecodeInterpreter`) or, in `"aot"` mode, is compiled to JS functions (`AotCompiler`).

## Execution contexts

An `ExecutionContext` holds the state of one line of execution: the global scope (`Table`), the accumulator (`acc`), the dynamic-wind stack (`wind`), the exception handler stack (`handlers`), the continuation epoch and the direct-call depth. Every `evaluateRaw`/`evaluateClosure` call gets a new context, and so does every coroutine.

## Frames and the driver loop

A `Frame` is one activation of a closure on the heap: its registers, the instruction pointer to resume at (`ip`), its caller (`parent`) and the context it belongs to (`ctx`).

The driver loop (`BytecodeInterpreter.run` / `AotCompiler.run`) repeatedly takes a frame, runs it until it hands control to another frame, and continues with the frame it got back. Returning, calling a closure, invoking a continuation, resuming or yielding a coroutine all just produce "the next frame". A `null` frame ends the loop.

Calls return their value through the context's `acc`. The instruction after a non-tail call is `MOVEACC dst`, which is also where the caller's frame resumes, so every way back into a frame (normal return, continuation, coroutine switch) delivers the value the same way.

`call/cc` shares the current frame chain. Shared frames are copied on write: `share` bumps the context's epoch, and a frame whose `epoch` is older than its context's is copied (`thaw`) before it is modified.

## AOT: two entry points per function

Each compiled function gets two JS functions from the same AOT IR (`AotCompiler.buildAot`: bytecode decoded into blocks, each ending in one terminator):

- **Resume entry** (`resumeFn`): takes a heap `Frame` and continues at `frame.ip` using `switch (ip)`. Registers are JS locals; a liveness analysis decides which ones are loaded on entry and spilled to `frame.regs` before a call that may leave the function. The driver loop uses this entry.
- **Direct entry** (`directFn`, fixed arity or rest-list variants): takes the arguments as JS arguments and returns the result. It allocates no frame, and is emitted as structured JS (`if`/`else` from `IF`/`ELSE`/`ENDIF`, self tail calls as `continue`). Non-tail calls to compiled closures with a matching arity call their direct entry, up to a depth of `MAX_JS_DEPTH`.

Direct code has no heap frames, so when something needs them (`call/cc`, invoking a continuation, a call that cannot be made directly, a host error, the depth limit, a coroutine switch) it throws a `Suspend`. Each direct function it passes through rebuilds its own `Frame` from its locals at `rip` (the resume point of the call it was making; `rip = -1` marks a tail call, which adds no frame). The heap-mode caller that started the direct chain attaches its frame and performs the pending action (`executor.resumeSuspend`), after which execution continues in resume mode.

Global variable reads are cached per instruction site, keyed by the scope and `Table.globalsVersion`, which changes whenever a table used as a global scope is modified.

## Coroutines

Each coroutine owns an execution context. Resuming records `co.resumer = { ctx, frame }` and hands the coroutine's next frame to the driver loop; yielding or finishing hands control back to the resumer's frame. So resume and yield are frame switches inside one driver loop, and a resume in tail position records the caller's caller, which makes it a proper tail call.

A non-tail resume from direct code instead runs the coroutine in a nested driver loop (`coResumeNested`), because it is already on the JS stack; control returning to the throwaway "barrier" context ends the nested loop. Nesting is capped by `MAX_NESTED_RESUMES`, after which the in-loop path is used. The host resumes coroutines the same way.

## Errors

- A **host error** (a JS exception thrown by a builtin or by compiled code) is handled by `executor.handleHostException`, which calls the prelude's raise procedure so Scheme handlers (`with-exception-handler`, `try`) can catch it as an `ErrorObject`.
- `UnhandledSchemeError` is thrown by `raise` when no handler is installed. At the top level it becomes the JS error seen by the host. Inside a coroutine it kills the coroutine and is re-raised in the resumer.
- `ReRaise` carries an error that escaped a coroutine into its resumer, so the resumer's handlers receive the original raised value.
- `EscapedError` wraps an error that has already been through `handleHostException`, so enclosing compiled code does not handle it a second time. The driver loop unwraps it.
- `Suspend.error` is how an error inside direct code reaches the heap frame that can handle it.

## Bytecode serialization

`dumpFull`/`readFull` (`utils.ts`) prefix the serialized bytecode with a magic word and `BYTECODE_VERSION`. Bump the version whenever opcodes, builtin indices or the serialized layout change.
