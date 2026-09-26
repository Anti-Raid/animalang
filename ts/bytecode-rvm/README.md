# Compiler Syntax Specification

This document specifies the core language the compiler accepts, the compiler intrinsics, and how surface syntax and the standard prelude map onto them.

The compiler only understands `%` forms. Every special form users write (`if`, `lambda`, `let`, `cond`, `define`, ...) is surface syntax that the syntax transformer (`scheme/transformer`) validates and lowers to the core forms below; anything else in the compiler's input is a variable reference, a literal or a call. Frontends such as transpilers can emit core forms directly. All surface and core form names are reserved and cannot be bound.

## Core Language

### Atoms and Literals

- **Symbols**: Evaluated as variable references resolved based on lexical scoping (local scope, enclosing function scope, or global scope).
- **Null**: The empty list (`'()`).
- **Primitives**: Numbers, strings, booleans, and undefined constants.

### Core Forms

A core form binds variables or does not evaluate its operands the usual way. Primitives that evaluate their operands normally, even ones that transfer control or read implicit state (`%call/cc`, `%raise`, `%current-marks`), are intrinsics.

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
| `(%with-mark <key> <value> <body>)` | `with-continuation-mark` | Evaluates `<body>` with the continuation mark `<key>` = `<value>`. In tail position the mark goes on the current frame, replacing its value for `<key>` (so a tail-recursive loop keeps one mark); otherwise `<body>` runs as a new frame and the mark is gone once it returns (or escapes). |
| `(%catch <thunk> <handler> [<pre>])` | `try`, `try-catch`, `pcall`, Luau `pcall`/`xpcall` | The value(s) of `(<thunk>)`; if an error reaches it, `(<pre> err)` runs first if given (still inside the raise, with the outer handlers), then everything unwinds to the `%catch` (running `dynamic-wind` after thunks), and `<handler>` is evaluated and called with `pre`'s result, or else the error, in tail position if the `%catch` is. `<handler>` is evaluated only when an error is caught, so a literal lambda costs nothing otherwise; `<pre>` is evaluated before `<thunk>` is called. |
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

### `%call/ec`
- **Form**: `(%call/ec <proc>)`
- **Semantics**: Calls `<proc>` with an escape continuation `k`. Calling `(k v)` while `<proc>` is still running makes the `%call/ec` return `v`, running `dynamic-wind` after thunks on the way out; marks are restored as with any return. Calling `k` after the `%call/ec` has returned or been escaped past is an error, as is calling it from another coroutine; an extent re-entered through a full continuation is live again. Always compiled as a non-tail call (`CALLEC`, then `%end-escape` deactivates `k`).
- Cheaper than `%call/cc` because it never needs heap frames: in direct code the call runs inside a JS `try/catch`, and an escape that has no `dynamic-wind` to unwind is caught right there. Escapes that do unwind, or that come from heap code, rebuild the frames and jump like a continuation, to the nearest frame on the caller chain that still holds `k` in the `%call/ec`'s register (the register is cleared when it returns, so a `k` whose extent has ended finds no frame; copies of the frame made by `call/cc` hold `k` too, so escapes out of a re-entered extent work). JS exceptions are slow (hundreds of ns), so a function whose `%call/ec` keeps being escaped from switches to heap frames after `DIRECT_SUSPEND_LIMIT` escapes, where the receiver gets a heap frame and escapes are plain jumps.

### `%raise`
- **Form**: `(%raise <obj> [<continuable>])`, from `raise`, `raise-continuable`, `error` and Luau's `error()`
- **Semantics**: Delivers `<obj>` to the innermost exception handler (see the exception model below). `<continuable>` is a literal `#t` or `#f` (default `#f`).

### `%current-stack`
- **Form**: `(%current-stack [<skip>])`, where `<skip>` is a literal count (default 0)
- **Semantics**: A snapshot of the current stack (each frame's name, position and tail-call trail), taken when it runs, without its innermost `<skip>` frames. Heap code reads its frames directly (`CURSTACK`); direct code suspends to rebuild them, capturing no continuation. That rebuild counts toward the heap-mode switch, so code that keeps taking snapshots moves to heap frames, where they are cheap.

### `%current-marks`
- **Form**: `(%current-marks)`, from `current-continuation-marks`
- **Semantics**: The current continuation's marks, as a continuation mark set.

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
  - Compiles as `(%apply <proc> <flattened>)`, where the `%apply-args` runtime operation (`CALLRT`) first splices the last element of `<lst>` into a flat argument list.

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

### The exception model
- **One handler list.** The handlers in effect are a continuation mark under the key `(%handler-key)` returns: a list, innermost first, whose entries are handler procedures (from `with-exception-handler`, which is just that mark) and catch tokens (from `%catch`). It follows frames, so escapes, continuations and re-entry restore it without `dynamic-wind`; a coroutine starts with none, and an error escaping it is raised again in its resumer, with the marks of the code that resumed it.
- **Delivery** (the VM's `executor.raise`, for `%raise` and for host errors alike) looks at the head of the list:
  1. empty: unhandled; the VM builds the traceback from its frames and throws to the host;
  2. a catch token: its `pre` runs if it has one, then the VM escapes to its `%catch` with the value wrapped in a `Caught`;
  3. a handler procedure: called with the rest of the list installed. If it returns, that is the value of a continuable raise; otherwise "handler returned on non-continuable exception" is delivered to the rest of the list.
- **Host errors** (a builtin throwing a JS `Error`) become error objects and are delivered as if raised where they happened, with the marks of a tail call that left no frame.
- **Helper frames.** Two tiny bytecode functions built into the VM (`raiseHelpers` in `exec.ts`) sit under a handler it calls: one raises the secondary error when a non-continuable raise's handler returns, one escapes to a catch token with what its `pre` returned. Their marks hold the outer handlers.
- **Fast paths.** `%catch` compiles to `CALLCATCH proc tok pre`; in direct code, an escape to its token, or an error whose innermost handler is its token (and which has no `pre` and no `dynamic-wind` to unwind), is caught right at the site by a JS `try/catch`. `%raise` compiles to `RAISE obj continuable`; from direct code, raising to a plain catch token is such an escape.
- **Surface.** `raise` / `raise-continuable` are `%raise` (direct calls are rewritten); the prelude keeps procedures of those names for use as values. `try` / `try-catch` are `%catch`, with the catch procedure running after unwinding like Racket's `with-handlers`. `(pcall f arg ...)` evaluates `f` and the arguments, then returns `(values #t result ...)` or `(values #f err)` (`%values-cons` prepends to the result values). `guard` escapes with `%call/ec` and re-raises with `raise-continuable` through a full continuation when no clause matches. Luau's `xpcall(f, h)` is `%catch` with `h` as `pre`.

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
- **Forms**: `(%debug-frames <stack> <args>)`, `(%debug-traceback <stack> <args>)`, where `<stack>` is a stack snapshot from `%current-stack` and `<args>` is the list `([coroutine] [msg] [level])`
- **Semantics**: Describe the frames of `<stack>` (or of a suspended coroutine) as a list of `#(name file line col)` records, or a traceback string.
- **How the surface procedures reach them**:
  - A direct call is rewritten by the syntax transformer, at compile time, so the prelude procedure is never called and the snapshot is taken in the calling function itself (its first frame):
    ```scheme
    (debug-traceback "here" 2)   ; what you write
    (%debug-traceback (%current-stack) (list "here" 2))   ; what the compiler receives
    ```
    `debug-frames` is rewritten the same way.
  - A use as a value (e.g. `(define tb debug-traceback)`, then `(tb "here")`) has no call site to rewrite, so it calls the prelude procedure, which takes the snapshot in its own frame and skips it:
    ```scheme
    (define $debug-traceback (lambda args (%debug-traceback (%current-stack 1) args)))
    ```

### Runtime operations
Compiler intrinsics that compile to `CALLRT` (a fixed index into `RUNTIME` in `exec.ts`). The compiler emits several of them itself when lowering other forms, but every one can also be written directly; each has a fixed argument count and a `leaf` flag (see host intrinsics):

| Form | Arguments | Leaf | What it does |
|---|---|---|---|
| `%coroutine-create`, `%coroutine-status` | 1 | yes | make a coroutine from a procedure / its status |
| `%coroutine-close` | 1 | no | close a coroutine, running its pending dynamic-wind after-thunks |
| `%wind`, `%end-wind` | 2 (before, after), 0 | yes | push / pop a wind point: the steps `%dynamic-wind` lowers to. They must be balanced |
| `%end-escape` | 1 | yes | ends the extent of an escape continuation or catch token (`%call/ec`, `%catch`) |
| `%caught?`, `%caught-value`, `%make-caught` | 1 | yes | test / unwrap / make the value a `%catch` produces when its thunk raised |
| `%handler-key` | 0 | yes | the continuation-mark key the exception handlers live under |
| `%values-cons` | 2 | yes | prepend a value to multiple values |
| `%values->list`, `%list->values` | 1 | yes | convert between multiple values and a list |
| `%apply-args` | 1 or more | yes | the arguments of an apply: the leading ones, then the elements of the last (a list) |
| `%first-value` | 1 | yes | see above |
| `%marks-first`, `%marks->list` | 3, 2 | yes | `continuation-mark-set-first` / `continuation-mark-set->list` |
| `%debug-frames`, `%debug-traceback` | 2 | yes | see above |

### Host intrinsics
- **Registering**: `anima.registerIntrinsic(name, fn, { args, leaf, inline, deps })` makes `(name arg ...)` an intrinsic of that instance: its compiler, VM and macro expander share one `Intrinsics` table, and nothing about it is global. `name` must start with `%`, and cannot be a compiler intrinsic, a builtin or an intrinsic already registered. A name only means the intrinsic in code compiled after it is registered. `anima.freeze()` stops further registrations; compiling and loading are unaffected.
- **Calling convention**: `fn(regs, start, nargs)` reads its arguments from `regs[start .. start+nargs)`. It must not write to `regs` or keep it: in the interpreter it is the caller's live register file. `args` is `[min, max]`, checked at compile time.
- **Inlining**: `inline(args, slow, tmp, d)` is an AOT template: given the argument expressions (plain variables, so they may be repeated), the direct call `slow`, a scratch variable `tmp` and `d`, it returns a JS expression, or null to make the direct call. `deps` names the values the template needs (`deps: { Table }`); the template refers to them as `${d.Table}`, which generated code reads from a local set up once per function. Using a name that is not in `deps` is an error when the code is generated.
- **Tail requests**: unless it is a `leaf`, an intrinsic may return `hostTail(proc, arg ...)` (or `new HostTail(proc, args)`) instead of a value; the value is then `(proc arg ...)`, made as an ordinary call (a tail call if the intrinsic was in tail position), so it can yield, capture continuations and raise. This is how host libraries (userdata, Luau tables and their metamethods) call back into the VM. Such intrinsics compile to `CALLHOST pos start nargs tail` and count as calls for the boxing analysis. To pass on the rest of the window, copy it with a loop: `regs.slice` with a spread costs about twice as much on windows this small.
- **Leaves** (`leaf: true`) never call back into the VM: they compile to `CALLINT pos dst start nargs` and are not calls for the boxing analysis. "Leaf" does not mean pure: a leaf may have side effects.
- Errors an intrinsic throws are host errors (see the exception model); `hostError` in `errors.ts` makes one without the cost of a JS stack trace.

### How intrinsics are compiled
- **Pure functions over a register window** (`%+`, `%car`, `%null?`, `%list`, ...) that are also public builtins compile to `CALL idx start nargs 0; MOVEACC dst`, where `idx - BUILTINS_START` indexes `IBUILTINS`. The AOT decoder fuses the pair into one inline builtin call (no block split), and inlines builtins that have an entry in `BUILTIN_INLINES` (`inline.ts`, the AOT-only table of `InlineFn`s by builtin name; `CALLRT` operations use `RUNTIME_INLINES` there the same way: arithmetic, `eq?`, every predicate, every `c[ad]+r`, `list`, `cons`, and the table and vector intrinsics), keeping a call to the builtin as the fallback so errors are unchanged. Builtins are never tail called: a builtin call in tail position compiles as a call followed by `RETURN`, since it cannot grow the Scheme stack.
- **Runtime operations** (see above) compile to `CALLRT idx dst start nargs`, where `idx` is a fixed index into the `RUNTIME` table in `exec.ts`.
- **Registered intrinsics** compile to `CALLINT pos dst start nargs` (leaves) or `CALLHOST pos start nargs tail`, where `pos` is the intrinsic's position in the table the code is compiled against. The interpreter calls `code.table.fns[pos](regs, start, nargs)`; AOT code reads each function it uses into a local once, and calls it over the register window or inlines its template.
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
- `call/ec`, `call-with-escape-continuation` and `(let/ec k body ...)`: Wrap `(%call/ec proc)`. `guard` uses it; `try` and `pcall` use `%catch`, which is built the same way.
- `+ - * / modulo remainder = eq? < <= > >=`:
  - The syntax transformer rewrites direct calls into the matching intrinsic, e.g. `(+ a b c)` becomes `(%+ a b c)`.
  - Uses as a value (e.g. `(map + xs ys)`) get the builtin of the same name, whose callback is the same operation function the opcode runs (`ts/ops.ts`), so there is no duplicated logic.
- `cons`: Direct calls are rewritten to the matching `%` form. Uses as a value get the builtin of the same name, whose callback is the same function the opcode runs (`ts/ops.ts`).
- Single-argument predicates (`null? pair? list? number? integer? ... table-frozen?`, the `PREDICATES` table in `ts/ops.ts`): Direct calls are rewritten to `%` forms (e.g. `(null? x)` becomes `(%null? x)`), which compile to a `CALL` of the builtin with that name. Uses as a value get a builtin generated from the same table.
- `car`, `cdr`, `caar` ... `cddddr` (all compositions up to 4 levels) and `first second third`: Direct calls are rewritten to `%` forms (e.g. `(third x)` becomes `(%third x)`), which compile to a `CALL` of the builtin with that name (generated from `CXR_PATHS` in `ts/ops.ts`). Uses as a value get the builtin of the same name, which runs the same function, so errors name the procedure either way (e.g. `third: list is too short`).
- `coroutine-create coroutine-resume coroutine-yield coroutine-status coroutine-close`: Direct calls are rewritten to the matching `%` form. Uses as a value resolve to prelude wrappers around the intrinsics.
- `values call-with-values`: `(values a b)` is a `MultipleValues` object (`common.ts`), `(values x)` is just `x` and `(values)` is zero values. `values` is a builtin, `call-with-values` is a prelude procedure (built on the `%values->list` intrinsic, which compiles to `CALLRT` and turns zero, one or multiple values into a list), except that a direct call whose producer and consumer are literal lambdas is rewritten to `receive`, binding the values without a list, and `receive`, `let-values` (parallel binding) and `let*-values` are syntax transformer macros built on `call-with-values`. Multiple values reaching a single-value context stay a `MultipleValues` object and print as `(values a b)`.
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

1. The syntax transformer (`scheme/transformer`) expands macros and rewrites calls to builtins into `%` intrinsic forms.
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

Direct code has no heap frames, so when something needs them (`call/cc`, invoking a continuation, a call that cannot be made directly, a host error, the depth limit, a coroutine switch) it throws a `Suspend`. Each direct function it passes through rebuilds its own `Frame` from its locals at `rip` (the resume point of the call it was making; `rip = -1` marks a tail call, which adds no frame). The heap-mode caller that started the direct chain attaches its frame and performs the pending action (`executor.resumeSuspend`), after which execution continues in resume mode. Rebuilding frames on every capture is expensive, so when direct calls of a function keep ending in a `Suspend` for `call/cc`, a continuation call or a yield (`DIRECT_SUSPEND_LIMIT` times, counted on the outermost direct function the `Suspend` passed through), that function's direct entry is switched off and calls to it use heap frames from then on, where capturing needs no rebuilding. Errors count too, since each direct function an error passes through catches and rethrows it (a JS throw costs about 200ns), while heap code handles it with a single throw; depth-limit suspends do not count. Builtins also raise errors without a JS stack trace (`hostError` in `errors.ts`), since Anima builds its own tracebacks and V8's stack capture was most of the cost of a handled error. Likewise, direct code resumes a coroutine in a nested driver loop only `DIRECT_SUSPEND_LIMIT` times per function; after that it suspends instead, since resuming from heap frames is a switch inside one driver loop.

Tail calls from heap code also use the callee's direct entry when it has one: the resume function returns the callee's value right after, so the JS stack does not grow, and a `Suspend` out of the callee rebuilds its frames on top of the tail caller's caller. A long chain of tail calls that way would reach the depth limit and unwind a thousand JS frames every time, so once a function's heap tail calls have come back as a `Suspend` `DIRECT_SUSPEND_LIMIT` times, its tail calls use heap frames instead, which run such chains in constant space.

Top-level code starts through its direct entry too (it is a zero-argument function), falling back to heap frames the same way on a `Suspend`. A function that nests structured control flow more than `MAX_STRUCTURED_NESTING` levels deep (e.g. a `cond` with hundreds of clauses) gets a `switch`-based direct entry instead, since V8 fails to compile JS nested thousands of levels deep.

The prelude is compiled once per implementation, and each `Anima` instance runs its own copy (`ByteCode.fresh`: shared instructions, its own templates and adaptive counters), so one program's heap-mode switches never reach another instance. The JS source of copied code is generated once and cached by instruction array; each copy only builds its own functions from it (about 0.2ms per instance).

Global variable reads are cached per instruction site, keyed by the environment and `Env.globalsVersion`, which changes whenever an environment compiled code has read globals from is modified.

## Coroutines

Each coroutine owns an execution context. Resuming records `co.resumer = { ctx, frame }` and hands the coroutine's next frame to the driver loop; yielding or finishing hands control back to the resumer's frame. So resume and yield are frame switches inside one driver loop, and a resume in tail position records the caller's caller, which makes it a proper tail call.

A non-tail resume from direct code instead runs the coroutine in a nested driver loop (`coResumeNested`), because it is already on the JS stack (except inside a coroutine: a coroutine resuming another suspends to heap frames, so they can be traced while it waits); control returning to the throwaway "barrier" context ends the nested loop. Nesting is capped by `MAX_NESTED_RESUMES`, after which the in-loop path is used. The host resumes coroutines the same way.

## Errors

- A **host error** (a JS exception thrown by a builtin or by compiled code) is handled by `executor.handleHostException`, which delivers it as an `ErrorObject` through the exception model (see above), so handlers and `%catch` see it like any raised value.
- `UnhandledSchemeError` is thrown by `raise` when no handler is installed. At the top level it becomes the JS error seen by the host. Inside a coroutine it kills the coroutine and is re-raised in the resumer.
- `ReRaise` carries an error that escaped a coroutine into its resumer, so the resumer's handlers receive the original raised value.
- `EscapedError` wraps an error that has already been through `handleHostException`, so enclosing compiled code does not handle it a second time. The driver loop unwraps it.
- `Suspend.error` is how an error inside direct code reaches the heap frame that can handle it.

## Debugging

- **Names**: a lambda is named after what it is bound to (`define`, `set!`, `let`), else `lambda@file:line`. Exported prelude procedures take their public name.
- **Source positions**: the reader records the position of every list form, and `%at` overrides it. The syntax transformer carries positions through macro expansion (an expansion inherits its macro call's position). The compiler emits `Pos` IR nodes, which lower into `ByteCode.lineTable` (`ip, file, line, col` entries); `positionAt(ip)` looks one up. Positions cost nothing at runtime.
- **Tracebacks**: `(debug-frames [co] [level])` and `(debug-traceback [co] [msg] [level])` take a snapshot of the stack in the calling function: the syntax transformer rewrites a direct call to `(%debug-traceback (%current-stack) (list args ...))` (see `%debug-frames` / `%debug-traceback`), so the caller itself is its first frame. A frame's position is that of the call it is waiting on. Frames removed by tail calls do not appear. `(debug-traceback co)` traces another coroutine: a suspended one from where it yielded, a normal one (waiting on a coroutine it resumed) from where it resumed it, and an unstarted or dead one as empty. The host can get a coroutine's traceback with `Anima.traceback(co)`.
- **Unhandled errors**: the VM builds a traceback from the raising frame before giving up, and it is attached to the JS error as `animaTraceback`. For an error that escaped a coroutine, the coroutine's traceback is kept.
- **Debug mode** (`implDebug` / `implAotDebug`, i.e. `new Compiler(true)`): the compiled `ByteCode` is flagged `debug`, and interpreter and AOT code for it
  - record every tail call in a continuation mark on the frame it replaces (the last 16 callees, repeats collapsed to `name xN`), which tracebacks show on that frame as `(tail calls: ...)`; as a mark it travels with continuations and coroutines;
  - track the exact position of the last operation (`frame.posIp`, or `dip` in direct code), so errors inside inlined builtins report the right position.
  Debug and non-debug code can run side by side (the prelude is always compiled without debug, so it stays out of the tail history), but there is only one set of compiled AOT functions per `ByteCode`.

## Continuation marks

Marks are an immutable list, newest first, of `(key, value, frame)` entries, where `frame` numbers the logical frame the mark belongs to. Direct functions take the list and their logical frame as arguments (`direct$(ctx, closure, executor, depth, marks, mframe, ...args)`): a non-tail call passes `mframe + 1`, a tail call passes `mframe` unchanged, so the callee continues its caller's frame, as in Racket. Heap frames keep them in `frame.marks` / `frame.mframe`, so `call/cc` and coroutines capture them with the frames. `%with-mark` in tail position replaces the current frame's entry for its key; otherwise the compiler saves the marks in registers (`MARKSAVE`), starts a new logical frame and puts them back after the body (`MARKRESTORE`), also on an `%escape` out of it. Setting a mark allocates one list node; code that uses no marks only pays for passing the two arguments (about 5% on call-bound code such as fib).

The library follows Racket: `with-continuation-mark`, `current-continuation-marks`, `continuation-mark-set-first` (`#f` means the current continuation; direct calls are rewritten to `%marks-first`), `continuation-mark-set->list` and `continuation-mark-set?`.

## Bytecode serialization

`dumpFull`/`readFull` (`utils.ts`) prefix the serialized bytecode with a magic word and `BYTECODE_VERSION`. Bump the version whenever opcodes, builtin indices or the serialized layout change.

Each `ByteCode` refers to the `Intrinsics` table it was compiled against (`table`, null when it uses no intrinsics), and records the intrinsics it uses in its metadata (`intrinsics`: position, name, and whether it was compiled as a leaf). `CALLINT`/`CALLHOST` operands are positions in that table, so code always calls the intrinsics it was compiled with, whichever instance runs it.

Binding (`ByteCode.bind`) moves code to another table by name: `readFull(buf, anima.intrinsics)` binds everything it loads, and `fresh(copies, intrinsics)` binds a copy. It is an error if an intrinsic is not registered in the new table, or is registered as a leaf when the code was compiled for a non-leaf, or the other way round (the boxing analysis depends on it). Instructions are rewritten (copied first if other code shares them) only when a position differs. Loading code that uses intrinsics without a table is an error. The disassembler shows intrinsics by name.
