# Compiler Syntax Specification

This document specifies the core language the compiler accepts, the compiler intrinsics, and how surface syntax and the standard prelude map onto them.

The compiler only understands `%` forms. Every special form users write (`if`, `lambda`, `let`, `cond`, `define`, ...) is surface syntax that the syntax transformer (`syntransformer-v1`) validates and lowers to the core forms below; anything else in the compiler's input is a variable reference, a literal or a call. Frontends such as transpilers can emit core forms directly. All surface and core form names are reserved and cannot be bound.

## Core Language

### Atoms and Literals

- **Symbols**: Evaluated as variable references resolved based on lexical scoping (local scope, enclosing function scope, or global scope).
- **Null**: The empty list (`'()`).
- **Primitives**: Numbers, strings, booleans, and undefined constants.

### Core Forms

| Core form | Surface syntax | Semantics |
|---|---|---|
| `(%begin <expr> ...)` | `begin` | Evaluates the expressions in order; the last one gives the value and keeps tail position. `(%begin)` is `undefined`. |
| `(%if <cond> <then> <else>)` | `if` (exactly 3 arguments) | Evaluates `<cond>`, then one branch; both branches keep tail position. |
| `(%quote <datum>)` | `quote`, `'datum` | Yields `<datum>` unevaluated. Quoted data is never transformed, so `''a` is the list `(quote a)`. |
| `(%lambda <params> <body> ...)` | `lambda` | Creates a closure. `<params>` is `(p ...)` or `(p ... . rest)`. Internal `define`s in the body are turned into a `letrec` first. |
| `(%let ((<symbol> <init>) ...) <body> ...)` | `let`, `let*` (nested), `letrec` (void inits then `%set!`), and any immediately applied lambda `((lambda (p ...) body) arg ...)` | Evaluates the inits in the enclosing scope, then binds them in a block of the current function (registers, no closure). Internal `define`s in the body become a `letrec`. |
| `(%let-values ((<formals> <expr>) ...) <body> ...)` | none (but can be useful?) | Like `%let`, binding each expr's multiple values to `<formals>` (`(a b)`, `(a b . rest)` or `rest`). Missing values are `<#void>`; extra values are dropped unless there is a rest variable. Compiles to `UNPACK`, with no closures. |
| `(%let-values/strict ((<formals> <expr>) ...) <body> ...)` | `receive`, `let-values`, `let*-values` (nested) | The same, but a wrong number of values is an error (Scheme semantics). The two differ only in a flag on `UNPACK`. |
| `(%set! <symbol> <expr>)` | `set!` | Updates the binding of `<symbol>` according to lexical scoping. |
| `(%define-global <symbol> <expr>)` | `define` at top level (after `(define (f ...) ...)` becomes a lambda) | Binds `<symbol>` in the global scope. |
| `(%block <name> <body> ...)` | none yet | Evaluates the body; its value is the last expression's, or the value of an `%escape` to `<name>`. Keeps tail position. |
| `(%escape <name> [<expr>])` | none yet | Leaves the innermost enclosing `%block` called `<name>` with `<expr>` (default `<#void>`), computed as that block's value (in its tail position if the block is in tail position). |
| `(%loop <body> ...)` | none yet | Repeats the body forever; only an `%escape` leaves it. |

Block names are labels, not variables. An `%escape` cannot leave a `%lambda` (a compile error); `%let`, and so every `let` form, is not a lambda, so escapes pass through it. `break` is an escape to a block around a loop, `continue` an escape to a block around its body, and an early return an escape to a block around a function body. These compile to jumps inside one function (`BLOCK end`, `LOOP end`, `ENDLOOP head`, `JUMP target`), which the AOT direct entry emits as labeled JS blocks, `for (;;)` loops and `break`s. Variables assigned in a loop stay plain registers unless they are read after a call in the loop (see the boxing rule below).

`let`, `let*`, `letrec`, named `let`, `cond`, `and`, `or`, `guard`, `receive`, `let-values` and `let*-values` are pure surface syntax built from these (for example `let` becomes `%let`, which binds variables in the current function instead of calling a lambda).

A named `let` whose name is only called in tail position of its body, with the right number of arguments, becomes a loop instead of a procedure: `(%let ((c init) ...) (%block done (%loop (%block next (%let ((v c) ...) (%escape done body'))))))`, where each tail self call in `body'` assigns the hidden carriers `c` and escapes to `next`. The carriers are assigned right before the jump and read right after, so the boxing analysis keeps them in registers, and the parameters are bound fresh every iteration as calls would bind them. The check runs on the expanded body; any other use of the name (as a value, a non-tail call, a call from a nested lambda, `set!`, a wrong argument count) keeps the procedure instead of applying this optimization.

### Procedure Calls

- **Builtin Calls**:
  - Form: `(<builtin-name> <arg> ...)`
  - Invokes a registered standard library builtin procedure directly.
- **General Calls**:
  - Form: `(<proc-expr> <arg> ...)`
  - Evaluates `<proc-expr>` and all arguments, executing a procedure call (or tail call if in tail position).

## Compiler Intrinsics (`%` Forms)

Besides the core forms, the compiler directly recognizes the following low-level `%` intrinsics:

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

### Table intrinsics
- **Forms**: `(%table-ref t k [default])`, `(%table-set! t k v)`, `(%table-has? t k)`, `(%table-border t)`
- **Semantics**: Direct calls to `table-ref`, `table-set!`, `table-has?` and `table-border` are rewritten to these. Each compiles to a `CALL` of the builtin with the same name; the AOT emitter inlines the 2-argument `table-ref` (one `lookup`), `table-set!` on an unfrozen table, `table-has?` and `table-border`, falling back to the builtin for errors, defaults and frozen tables.

### Vector intrinsics
- **Forms**: `(%vector-ref v k)`, `(%vector-set! v k val)`, `(%vector-length v)`
- **Semantics**: Direct calls to `vector-ref`, `vector-set!` and `vector-length` are rewritten to these. Each compiles to a `CALL` of the builtin with the same name; the AOT emitter inlines them as a guarded JS array access and falls back to the builtin (and its error messages) when the guard fails.

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

### `%at`
- **Form**: `(%at <file> <line> <col> <expr>)`
- **Semantics**: Evaluates `<expr>`, recording `file:line:col` as its source position. For frontends that generate Anima code (e.g. a transpiler) so errors and tracebacks point at the original source. It is removed by the syntax transformer before macros run, so macros never see it. Positions only attach to forms (lists); a wrapped atom keeps the enclosing form's position.

### `%first-value`
- **Form**: `(%first-value <expr>)`
- **Semantics**: The first of `<expr>`'s multiple values, `<expr>` itself if it is a single value, or `<#void>` if it has none. This is Lua's truncation of a call used as a single value (`g() + 1`, `f(g(), x)`); the AOT emitter inlines it as an `instanceof MultipleValues` check.

### `%debug-frames` / `%debug-traceback`
- **Forms**: `(%debug-frames <k> <args>)`, `(%debug-traceback <k> <args>)`, where `<k>` is a continuation and `<args>` is the list `([coroutine] [msg] [level])`
- **Semantics**: Walk the frames of `<k>` (or of a suspended coroutine) and return a list of `#(name file line col)` records, or a traceback string. Used by the prelude's `debug-frames` and `debug-traceback`.

### How intrinsics are compiled
- **Pure functions over a register window** (`%+`, `%car`, `%null?`, `%list`, ...) that are also public builtins compile to `CALL idx start nargs 0; MOVEACC dst`, where `idx - BUILTINS_START` indexes `IBUILTINS`. The AOT decoder fuses the pair into one inline builtin call (no block split), and inlines builtins that have an entry in `BUILTIN_INLINES` (`inline.ts`, the AOT-only table of `InlineFn`s by builtin name; `CALLRT` operations use `RUNTIME_INLINES` there the same way: arithmetic, `eq?`, every predicate, every `c[ad]+r`, `list`, `cons`, and the table and vector intrinsics), keeping a call to the builtin as the fallback so errors are unchanged. Builtins are never tail called: a builtin call in tail position compiles as a call followed by `RETURN`, since it cannot grow the Scheme stack.
- **Runtime operations that only need the execution context** (`%coroutine-create`, `%coroutine-status`, `%coroutine-close`, `%handlers`, `%set-handlers!`, `%set-raise-proc`, the wind/unwind steps of `%dynamic-wind`, and internal helpers with no public builtin: `%values->list`, `%first-value`, `%debug-frames`, `%debug-traceback` and the list/apply conversions behind `%coroutine-yield-list` and `%apply-multi`) compile to `CALLRT idx dst start nargs`, where `idx` indexes the `RUNTIME` table in `exec.ts`.
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
2. `analysis.ts` works out which variables live in `Box`es: those captured (used from inside a nested `%lambda`; a `%let` is not a boundary), and those assigned with `set!` that are live across a call, i.e. read after a call that may run Scheme code before being assigned again. A continuation captured during such a call restores the frame's registers when re-entered, so only then would a register copy differ from a shared location. A second, backward liveness pass over the core forms (with a fixed point for `%loop`, and `%escape` flowing to its block's continuation) finds them; calls of builtins and of runtime intrinsics that never run Scheme code do not count.
3. `compiler.ts` turns the expression into IR nodes (`ir.ts`) over numbered registers, and `IR.lower` turns those into a `ByteCode` (a `Uint32Array` of instructions plus a constant pool).
4. The bytecode runs either in the interpreter (`BytecodeInterpreter`) or, in `"aot"` mode, is compiled to JS functions (`AotCompiler`).

## Execution contexts

An `ExecutionContext` holds the state of one line of execution: the global environment (`Env`), the accumulator (`acc`), the dynamic-wind stack (`wind`), the exception handler stack (`handlers`) and the continuation epoch. Every `evaluateRaw`/`evaluateClosure` call gets a new context, and so does every coroutine.

## Frames and the driver loop

A `Frame` is one activation of a closure on the heap: its registers, the instruction pointer to resume at (`ip`), its caller (`parent`) and the context it belongs to (`ctx`).

The driver loop (`BytecodeInterpreter.run` / `AotCompiler.run`) repeatedly takes a frame, runs it until it hands control to another frame, and continues with the frame it got back. Returning, calling a closure, invoking a continuation, resuming or yielding a coroutine all just produce "the next frame". A `null` frame ends the loop.

Calls return their value through the context's `acc`. The instruction after a non-tail call is `MOVEACC dst`, which is also where the caller's frame resumes, so every way back into a frame (normal return, continuation, coroutine switch) delivers the value the same way.

`call/cc` shares the current frame chain. Shared frames are copied on write: `share` bumps the context's epoch, and a frame whose `epoch` is older than its context's is copied (`thaw`) before it is modified.

## AOT: two entry points per function

Each compiled function gets two JS functions from the same AOT IR (`AotCompiler.buildAot`: bytecode decoded into blocks, each ending in one terminator):

- **Resume entry** (`resumeFn`): takes a heap `Frame` and continues at `frame.ip` using `switch (ip)`. Registers are JS locals; a liveness analysis decides which ones are loaded on entry and spilled to `frame.regs` before a call that may leave the function. The driver loop uses this entry.
- **Direct entry** (`directFn`, fixed arity or rest-list variants): takes the arguments as JS arguments and returns the result. It allocates no frame, and is emitted as structured JS (`if`/`else` from `IF`/`ELSE`/`ENDIF`, self tail calls as `continue`). Non-tail calls to compiled closures with a matching arity call their direct entry, up to a depth of `MAX_JS_DEPTH`: every direct entry takes the current depth as an argument (`direct$(ctx, closure, executor, depth, ...args)`) and passes `depth + 1` on, and resume code starts at 1. A call to the function's own closure with its own arity (plain recursion) calls itself by name, skipping the closure and arity checks.

Direct code has no heap frames, so when something needs them (`call/cc`, invoking a continuation, a call that cannot be made directly, a host error, the depth limit, a coroutine switch) it throws a `Suspend`. Each direct function it passes through rebuilds its own `Frame` from its locals at `rip` (the resume point of the call it was making; `rip = -1` marks a tail call, which adds no frame). The heap-mode caller that started the direct chain attaches its frame and performs the pending action (`executor.resumeSuspend`), after which execution continues in resume mode. Rebuilding frames on every capture is expensive, so when direct calls of a function keep ending in a `Suspend` for `call/cc`, a continuation call or a yield (`DIRECT_SUSPEND_LIMIT` times, counted on the outermost direct function the `Suspend` passed through), that function's direct entry is switched off and calls to it use heap frames from then on, where capturing needs no rebuilding. Depth-limit suspends and errors do not count. Likewise, direct code resumes a coroutine in a nested driver loop only `DIRECT_SUSPEND_LIMIT` times per function; after that it suspends instead, since resuming from heap frames is a switch inside one driver loop.

Tail calls from heap code also use the callee's direct entry when it has one: the resume function returns the callee's value right after, so the JS stack does not grow, and a `Suspend` out of the callee rebuilds its frames on top of the tail caller's caller.

Global variable reads are cached per instruction site, keyed by the environment and `Env.globalsVersion`, which changes whenever an environment compiled code has read globals from is modified.

## Coroutines

Each coroutine owns an execution context. Resuming records `co.resumer = { ctx, frame }` and hands the coroutine's next frame to the driver loop; yielding or finishing hands control back to the resumer's frame. So resume and yield are frame switches inside one driver loop, and a resume in tail position records the caller's caller, which makes it a proper tail call.

A non-tail resume from direct code instead runs the coroutine in a nested driver loop (`coResumeNested`), because it is already on the JS stack; control returning to the throwaway "barrier" context ends the nested loop. Nesting is capped by `MAX_NESTED_RESUMES`, after which the in-loop path is used. The host resumes coroutines the same way.

## Errors

- A **host error** (a JS exception thrown by a builtin or by compiled code) is handled by `executor.handleHostException`, which calls the prelude's raise procedure so Scheme handlers (`with-exception-handler`, `try`) can catch it as an `ErrorObject`.
- `UnhandledSchemeError` is thrown by `raise` when no handler is installed. At the top level it becomes the JS error seen by the host. Inside a coroutine it kills the coroutine and is re-raised in the resumer.
- `ReRaise` carries an error that escaped a coroutine into its resumer, so the resumer's handlers receive the original raised value.
- `EscapedError` wraps an error that has already been through `handleHostException`, so enclosing compiled code does not handle it a second time. The driver loop unwraps it.
- `Suspend.error` is how an error inside direct code reaches the heap frame that can handle it.

## Debugging

- **Names**: a lambda is named after what it is bound to (`define`, `set!`, `let`), else `lambda@file:line`. Exported prelude procedures take their public name.
- **Source positions**: the reader records the position of every list form, and `%at` overrides it. The syntax transformer carries positions through macro expansion (an expansion inherits its macro call's position). The compiler emits `Pos` IR nodes, which lower into `ByteCode.lineTable` (`ip, file, line, col` entries); `positionAt(ip)` looks one up. Positions cost nothing at runtime.
- **Tracebacks**: `(debug-frames [co] [level])` and `(debug-traceback [co] [msg] [level])` capture the caller's continuation with a tail `call/cc` and walk its frames (direct AOT code rebuilds its frames for this, as it does for any `call/cc`). A frame's position is that of the call it is waiting on. Frames removed by tail calls do not appear. The host can get a suspended coroutine's traceback with `Anima.traceback(co)`.
- **Unhandled errors**: the prelude's `raise` builds a traceback before giving up, and it is attached to the JS error as `animaTraceback`. For an error that escaped a coroutine, the coroutine's traceback is kept.
- **Debug mode** (`implDebug` / `implAotDebug`, i.e. `new Compiler(true)`): the compiled `ByteCode` is flagged `debug`, and interpreter and AOT code for it
  - record every tail call in the execution context's `tailHistory` (the last 16 callees, repeats collapsed to `name xN`), shown by tracebacks as `recent tail calls`;
  - track the exact position of the last operation (`frame.posIp`, or `dip` in direct code), so errors inside inlined builtins report the right position.
  Debug and non-debug code can run side by side (the prelude is always compiled without debug, so it stays out of the tail history), but there is only one set of compiled AOT functions per `ByteCode`.

## Bytecode serialization

`dumpFull`/`readFull` (`utils.ts`) prefix the serialized bytecode with a magic word and `BYTECODE_VERSION`. Bump the version whenever opcodes, builtin indices or the serialized layout change.
