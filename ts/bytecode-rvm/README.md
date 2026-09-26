# Compiler Syntax Specification

This document specifies the core language the compiler accepts, the compiler intrinsics and host intrinsics, and how compiled code runs.

The compiler only understands `%` forms: a language's front end (its reader and syntax transformer) lowers its surface syntax to the core forms below, and transpilers can emit core forms directly. Anything else in the compiler's input is a variable reference, a literal or a call. Core form and intrinsic names cannot be bound, nor can the names a front end reserves (`Intrinsics.reserved`).

## Core Language

### Atoms and Literals

- **Symbols**: Evaluated as variable references resolved based on lexical scoping (local scope, enclosing function scope, or global scope).
- **Null**: The empty list (`'()`).
- **Primitives**: Numbers, strings, booleans, and undefined constants.

### Core Forms

A core form binds variables or does not evaluate its operands the usual way. Primitives that evaluate their operands normally, even ones that transfer control or read implicit state (`%call/cc`, `%raise`, `%current-marks`), are intrinsics.

| Core form | Semantics |
|---|---|
| `(%begin <expr> ...)` | Evaluates the expressions in order; the last one gives the value and keeps tail position. `(%begin)` is `undefined`. |
| `(%if <c1> <e1> <c2> <e2> ... [<else>])` | Evaluates the conditions in order and gives the branch of the first true one, else `<else>` (`<#void>` without one); the branches keep tail position. However many clauses, it compiles to one flat chain, `IF c1; e1; ELSE end; <c2>; ELSEIF c2; e2; ELSE end; ...; <else>; ENDIF`: a condition that is false costs one jump, and the AOT direct entry emits the chain as a labeled block of `if`s that `break` out of it, never nesting per clause. |
| `(%quote <datum>)` | Yields `<datum>` unevaluated. Quoted data is never transformed, so `''a` is the list `(quote a)`. |
| `(%lambda <params> <body> ...)` | Creates a closure. `<params>` is `(p ...)` or `(p ... . rest)`. |
| `(%let ((<symbol> <init>) ...) <body> ...)` | Evaluates the inits in the enclosing scope, then binds them in a block of the current function (registers, no closure). |
| `(%let-values ((<formals> <expr>) ...) <body> ...)` | Like `%let`, binding each expr's multiple values to `<formals>` (`(a b)`, `(a b . rest)` or `rest`). Missing values are `<#void>`; extra values are dropped unless there is a rest variable. Compiles to `UNPACK`, with no closures. |
| `(%let-values/strict ((<formals> <expr>) ...) <body> ...)` | The same, but a wrong number of values is an error. The two differ only in a flag on `UNPACK`. |
| `(%set! <symbol> <expr>)` | Updates the binding of `<symbol>` according to lexical scoping. |
| `(%with-mark <key> <value> <body>)` | Evaluates `<body>` with the continuation mark `<key>` = `<value>`. In tail position the mark goes on the current frame, replacing its value for `<key>` (so a tail-recursive loop keeps one mark); otherwise `<body>` runs as a new frame and the mark is gone once it returns (or escapes). |
| `(%catch <thunk> <handler> [<pre>])` | The value(s) of `(<thunk>)`; if an error reaches it, `(<pre> err)` runs first if given (still inside the raise, with the outer handlers), then everything unwinds to the `%catch` (running `dynamic-wind` after thunks), and `<handler>` is evaluated and called with `pre`'s result, or else the error, in tail position if the `%catch` is. `<handler>` is evaluated only when an error is caught, so a literal lambda costs nothing otherwise; `<pre>` is evaluated before `<thunk>` is called. |
| `(%define-global <symbol> <expr>)` | Binds `<symbol>` in the global scope. |
| `(%block <name> <body> ...)` | Evaluates the body; its value is the last expression's, or the value of an `%escape` to `<name>`. Keeps tail position. |
| `(%escape <name> [<expr>])` | Leaves the innermost enclosing `%block` called `<name>` with `<expr>` (default `<#void>`), computed as that block's value (in its tail position if the block is in tail position). |
| `(%loop <body> ...)` | Repeats the body forever; only an `%escape` leaves it. |

Block names are labels, not variables. An `%escape` cannot leave a `%lambda` (a compile error); `%let` is not a lambda, so escapes pass through it. `break` is an escape to a block around a loop, `continue` an escape to a block around its body, and an early return an escape to a block around a function body. These compile to jumps inside one function (`BLOCK end`, `LOOP end`, `ENDLOOP head`, `JUMP target`), which the AOT direct entry emits as labeled JS blocks, `for (;;)` loops and `break`s. Variables assigned in a loop stay plain registers unless they are read after a call in the loop (see the boxing rule below).

### Procedure Calls

- **Intrinsic Calls**:
  - Form: `(<intrinsic> <arg> ...)`, where `<intrinsic>` is a compiler intrinsic or one registered on the instance (see host intrinsics).
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
- **Form**: `(%call/cc <proc>)`, a control operation (see below)
- **Semantics**:
  - In non-tail position: Captures the current continuation and passes it as a single argument to `<proc>`.
  - In tail position: Replaces the current frame with the caller's continuation and tail-calls `<proc>`.

### `%call/ec`
- **Form**: `(%call/ec <proc>)`
- **Semantics**: Calls `<proc>` with an escape continuation `k`. Calling `(k v)` while `<proc>` is still running makes the `%call/ec` return `v`, running `dynamic-wind` after thunks on the way out; marks are restored as with any return. Calling `k` after the `%call/ec` has returned or been escaped past is an error, as is calling it from another coroutine; an extent re-entered through a full continuation is live again. Always compiled as a non-tail call (`CALLEC`, then `%end-escape` deactivates `k`).
- Cheaper than `%call/cc` because it never needs heap frames: in direct code the call runs inside a JS `try/catch`, and an escape that has no `dynamic-wind` to unwind is caught right there. Escapes that do unwind, or that come from heap code, rebuild the frames and jump like a continuation, to the nearest frame on the caller chain that still holds `k` in the `%call/ec`'s register (the register is cleared when it returns, so a `k` whose extent has ended finds no frame; copies of the frame made by `call/cc` hold `k` too, so escapes out of a re-entered extent work). JS exceptions are slow (hundreds of ns), so a function whose `%call/ec` keeps being escaped from switches to heap frames after `DIRECT_SUSPEND_LIMIT` escapes, where the receiver gets a heap frame and escapes are plain jumps.

### `%raise`
- **Form**: `(%raise <obj> [<continuable>])`, from `raise`, `raise-continuable`, `error` and Luau's `error()`; a control operation (see below)
- **Semantics**: Delivers `<obj>` to the innermost exception handler (see the exception model below). `<continuable>` is `#t` or `#f` (default `#f`); anything else is an error.

### `%current-stack`
- **Form**: `(%current-stack [<skip>])`, where `<skip>` is a count (default 0); a control operation (see below)
- **Semantics**: A snapshot of the current stack (each frame's name, position and tail-call trail), taken when it runs, without its innermost `<skip>` frames. Heap code reads its frames directly; direct code suspends to rebuild them, capturing no continuation. That rebuild counts toward the heap-mode switch, so code that keeps taking snapshots moves to heap frames, where they are cheap.

### `%current-marks`
- **Form**: `(%current-marks)`, from `current-continuation-marks`
- **Semantics**: The current continuation's marks, as a continuation mark set.

### `%apply`
- **Form**: `(%apply <proc> <arg> ... <lst>)`
- **Semantics**:
  - Unpacks the trailing `<lst>` argument and splices its elements after any preceding `<arg> ...` expressions before calling `<proc>`.
  - `<proc>` may be a registered leaf intrinsic (`(%apply %name args)`), which compiles to `APPLYINT` (see below).
  - Otherwise it is a call of the control operation `%apply-list` over `[proc, arg ..., lst]` (a tail call in tail position), which returns a call request (`HostTail`) of `<proc>` with the spliced arguments.
  - **Rest forwarding**: when `<lst>` is a lambda's rest parameter that is never used any other way (not read as a value, assigned, or captured), the closure is marked `restArray`. Its rest arguments are then bound as a plain array instead of a list, and the `%apply` spreads that array (`APPLYINTR` for an intrinsic, `%apply-array` for a procedure, which checks it is given an array). So a wrapper like `(lambda args (%apply %+ args))` builds no list, and applying an intrinsic this way passes the array itself as the argument window. The array is only ever seen by these instructions.

### `%apply-multi`
- **Form**: `(%apply-multi <proc> <lst>)`
- **Semantics**:
  - Runtime-list variant of `%apply`: the elements of `<lst>` are the arguments, with the last element spliced in the same way (e.g. a variadic `apply` procedure passes its rest parameter here).
  - Compiles as `(%apply <proc> <flattened>)`, where the `%apply-args` core operation first splices the last element of `<lst>` into a flat argument list. A forwarded rest parameter (see `%apply`) skips that: `%apply-array-multi` splices the array's last element directly.

### The exception model
- **One handler list.** The handlers in effect are a continuation mark under the key `(%handler-key)` returns: a list, innermost first, whose entries are handler procedures (from `with-exception-handler`, which is just that mark) and catch tokens (from `%catch`). It follows frames, so escapes, continuations and re-entry restore it without `dynamic-wind`; a coroutine starts with none, and an error escaping it is raised again in its resumer, with the marks of the code that resumed it.
- **Delivery** (the VM's `executor.raise`, for `%raise` and for host errors alike) looks at the head of the list:
  1. empty: unhandled; the VM builds the traceback from its frames and throws to the host;
  2. a catch token: its `pre` runs if it has one, then the VM escapes to its `%catch` with the value wrapped in a `Caught`;
  3. a handler procedure: called with the rest of the list installed. If it returns, that is the value of a continuable raise; otherwise "handler returned on non-continuable exception" is delivered to the rest of the list.
- **Host errors** (an intrinsic throwing a JS `Error`) become error objects and are delivered as if raised where they happened, with the marks of a tail call that left no frame.
- **Helper frames.** Two tiny bytecode functions built into the VM (`raiseHelpers` in `exec.ts`) sit under a handler it calls: one raises the secondary error when a non-continuable raise's handler returns, one escapes to a catch token with what its `pre` returned. Their marks hold the outer handlers.
- **Fast paths.** `%catch` compiles to `CALLCATCH proc tok pre`; in direct code, an escape to its token, or an error whose innermost handler is its token (and which has no `pre` and no `dynamic-wind` to unwind), is caught right at the site by a JS `try/catch`. `%raise` is a control operation; from direct code, raising to a plain catch token is such an escape.
### Coroutine intrinsics
- **Forms**: `(%coroutine-create <proc>)`, `(%coroutine-resume <co> <val> ...)`, `(%coroutine-yield <val> ...)`, `(%coroutine-status <co>)`, `(%coroutine-close <co>)`, plus `(%coroutine-resume-list <co> <lst>)` / `(%coroutine-yield-list <lst>)` which take the values as a runtime list (for procedures that take the values as a list)
- **Semantics**:
  - Asymmetric, one-shot coroutines. Each coroutine owns its own execution context (frames, wind stack, handler stack), so it can be resumed from any later evaluation, including by the host via `Anima.coroutineResume(co, ...vals)`, which returns `{ done, value, values }` (`value` is the first of `values`).
  - Resume and yield switch coroutines inside the driver loop (every frame records its execution context), so nothing nests on the JS stack. `%coroutine-resume` in tail position is a proper tail call: the coroutine's yields and final value go straight to the caller's caller, so chains of tail resumes (schedulers, symmetric hand-offs) run in constant space. They are control operations (see below); the variadic forms take their values over the argument window.
  - The first resume passes its values as the procedure's arguments. Later resumes make the pending `%coroutine-yield` return their values, and `%coroutine-resume` returns the yielded values, both as multiple values (see `values`).
  - Status is one of `suspended`, `running`, `normal` (it resumed another coroutine) or `dead`. Resuming a non-suspended coroutine is an error.
  - An error the coroutine does not handle marks it `dead` and is raised again in the resumer as-is.
  - `dynamic-wind` thunks do not run on yield/resume, so global state changed by a wind thunk stays changed while the coroutine is suspended. Coroutine-local dynamic state belongs in the execution context (as the handler stack does).
  - `(%coroutine-close <co>)` runs a suspended coroutine's pending `dynamic-wind` after-thunks (innermost first, inside the coroutine) and marks it `dead`. Closing a dead coroutine does nothing, closing a running one is an error, and yielding during close is an error. The host equivalent is `Anima.coroutineClose(co)`.
  - Yielding from inside code a host function runs itself (rather than through a tail request) is an error: that code runs in a separate execution context.

### `%first-value`
- **Form**: `(%first-value <expr>)`
- **Semantics**: The first of `<expr>`'s multiple values, `<expr>` itself if it is a single value, or `<#void>` if it has none. This is Lua's truncation of a call used as a single value (`g() + 1`, `f(g(), x)`); the AOT emitter inlines it as an `instanceof MultipleValues` check.

### `%debug-frames` / `%debug-traceback`
- **Forms**: `(%debug-frames <stack> <args>)`, `(%debug-traceback <stack> <args>)`, where `<stack>` is a stack snapshot from `%current-stack` and `<args>` is the list `([coroutine] [msg] [level])`
- **Semantics**: Describe the frames of `<stack>` (or of a suspended coroutine) as a list of `#(name file line col)` records, or a traceback string.
### Core operations
The VM's own operations. They are intrinsics like any other (see host intrinsics), registered in `CORE_INTRINSICS` (`exec.ts`), which every table starts from (`newIntrinsics` in `core.ts`; the compiler refuses a table that does not). So each is at the same position in every table: the compiler emits several of them itself when lowering other forms (by `corePos(name)`), and every one can also be written directly. They compile like any intrinsic (`CALLINT`, or `CALLHOST` for `%coroutine-close`), with AOT templates for the small ones. Those that need the running context are registered with `context` and get `ctx` and `executor` as extra arguments:

| Form | Arguments | Leaf | What it does |
|---|---|---|---|
| `%coroutine-create`, `%coroutine-status` | 1 | yes | make a coroutine from a procedure / its status |
| `%coroutine-close` | 1 | no | close a coroutine, running its pending dynamic-wind after-thunks |
| `%wind`, `%end-wind` | 2 (before, after), 0 | yes | push / pop a wind point: the steps `%dynamic-wind` lowers to. They must be balanced |
| `%end-escape` | 1 | yes | ends the extent of an escape continuation or catch token (`%call/ec`, `%catch`) |
| `%caught?`, `%caught-value`, `%make-caught` | 1 | yes | test / unwrap / make the value a `%catch` produces when its thunk raised |
| `%handler-key` | 0 | yes | the continuation-mark key the exception handlers live under |
| `%list`, `%values` | any | yes | a list / multiple values of the arguments (what `%coroutine-resume` and `%coroutine-yield` pack their arguments into) |
| `%values-cons` | 2 | yes | prepend a value to multiple values |
| `%values->list`, `%list->values` | 1 | yes | convert between multiple values and a list |
| `%apply-args` | 1 or more | yes | the arguments of an apply: the leading ones, then the elements of the last (a list) |
| `%first-value` | 1 | yes | see above |
| `%marks-first`, `%marks->list` | 3, 2 | yes | `continuation-mark-set-first` / `continuation-mark-set->list` |
| `%debug-frames`, `%debug-traceback` | 2 | yes | see above |

### Control operations
Core operations that transfer control, so they are not leaves: `%call/cc`, `%raise`, `%current-stack`, `%coroutine-yield`, `%coroutine-yield-list`, `%coroutine-resume`, `%coroutine-resume-list`, and `%apply-list`, `%apply-array` and `%apply-array-multi` (what `%apply` and `%apply-multi` of a procedure compile to). Each returns a `ControlRequest` describing the transfer, which the VM carries out at the call (`CALLHOST`), exactly as a host intrinsic's `HostTail` is (see below): heap code with the calling frame (`run`), direct code by suspending to heap frames, or for a nested resume by running the coroutine in place (`direct`). So they need no opcodes of their own, and the interpreter handles them all in one place. The AOT compiler writes out what each one's request does at the call (`CONTROL_AOT` in `exec.ts`: a template for heap code and one for direct code), so compiled code makes no request object and does not dispatch on one, which shows in tight coroutine and `call/cc` loops; the argument checks are helpers shared with the intrinsics. In debug code, a request made in tail position records its procedure (or coroutine) as the tail call. `%raise`, `%current-stack` and the yields are registered with `tail: false`: their value is that of the call itself, so they are never compiled as tail calls.

### Host intrinsics
- **Registering**: `anima.registerIntrinsic(name, fn, { args, leaf, inline, deps })` makes `(name arg ...)` an intrinsic of that instance: its compiler, VM and front end share one `Intrinsics` table, and nothing about it is global. `name` must start with `%`, and cannot be a core form, a core operation or an intrinsic already registered. A name only means the intrinsic in code compiled after it is registered. `anima.freeze()` stops further registrations; compiling and loading are unaffected.
- **Calling convention**: `fn(regs, start, nargs)` reads its arguments from `regs[start .. start+nargs)`. It must not write to `regs` or keep it: in the interpreter it is the caller's live register file. `args` is `[min, max]`, checked at compile time. `context: true` (for the core operations) also passes the running `ExecutionContext` and `VMExecutor`: `fn(regs, start, nargs, ctx, executor)`.
- **Inlining**: `inline(args, slow, tmp, d)` is an AOT template: given the argument expressions (plain variables, so they may be repeated), the direct call `slow`, a scratch variable `tmp` and `d`, it returns a JS expression, or null to make the direct call. `deps` names the values the template needs (`deps: { Table }`); the template refers to them as `${d.Table}`, which generated code reads from a local set up once per function. Using a name that is not in `deps` is an error when the code is generated.
- **Tail requests**: unless it is a `leaf`, an intrinsic may return `hostTail(proc, arg ...)` (or `new HostTail(proc, args)`) instead of a value; the value is then `(proc arg ...)`, made as an ordinary call (a tail call if the intrinsic was in tail position), so it can yield, capture continuations and raise. This is how host libraries (userdata, Luau tables and their metamethods) call back into the VM. Such intrinsics compile to `CALLHOST pos start nargs tail` and count as calls for the boxing analysis. To pass on the rest of the window, copy it with a loop: `regs.slice` with a spread costs about twice as much on windows this small.
- **Leaves** (`leaf: true`) never call back into the VM: they compile to `CALLINT pos dst start nargs` and are not calls for the boxing analysis. "Leaf" does not mean pure: a leaf may have side effects.
- Errors an intrinsic throws are host errors (see the exception model); `hostError` in `errors.ts` makes one without the cost of a JS stack trace.

### How intrinsics are compiled
- **Core operations** (see above) are intrinsics at fixed positions (below `CORE_COUNT`) in every table, so they compile as below.
- **Applying a registered leaf intrinsic** (`(%apply %name arg ... lst)`, e.g. in a first-class wrapper `(lambda args (%apply %name args))`) compiles to `APPLYINT pos dst start nargs`: the last argument is spread as by `%apply`, and since the count is only known at run time, it is checked against the intrinsic's `args` there. Only leaves can be applied.
- **Registered intrinsics** compile to `CALLINT pos dst start nargs` (leaves) or `CALLHOST pos start nargs tail`, where `pos` is the intrinsic's position in the table the code is compiled against. The interpreter calls `code.table.fns[pos](regs, start, nargs)`; AOT code inlines the intrinsic's template when it has one; a call that is the fast path goes through a local the function is read into once (which V8 can inline), while a template's fallback goes through `RT[pos]`, so V8 does not inline the function into a cold path, which measurably slows the hot one.
- **Control flow**: `CALL` and `CALLHOST` take a trailing `tail` operand (bit 0 set in tail position; non-tail forms are followed by `MOVEACC`), and `RETURN` leaves the function. The control operations are `CALLHOST`s of core intrinsics (see above); only `%call/ec` and `%catch` keep opcodes (`CALLEC`, `CALLCATCH`), because their continuation lives in a register of the calling frame.

# Runtime Architecture

This section describes how compiled code runs. The code lives in `exec.ts` (runtime, interpreter and AOT compiler), `vm.ts` (entry points), `opcodes.ts` (the instruction set), `arity.ts` (argument counts and binding) and `lists.ts` (the list and multiple-value helpers the runtime operations share).

## Instruction set
`opcodes.ts` describes every opcode once, in `OPCODES`: its operands, each with a kind (a register, a constant, an immediate, an upvar, a jump target, an intrinsic position, a runtime index, a `tail` operand or flags, with the names of their bits), and whether the instruction after it starts a basic block (always, or unless it is a tail call; jump targets always do). Everything that walks instructions without running them is derived from it: instruction lengths, remapping intrinsic operands when code is bound to another table, the AOT compiler's basic blocks, and the disassembler (`stringifyInst` in `utils.ts`, which prints `NAME operand=value, ...`). `IR.lower` checks each instruction it emits against the spec. A new opcode needs its spec entry, and its cases in the interpreter and the AOT decoder, which are exhaustive switches.

## Argument binding
A procedure's argument count is an `Arity` (`arity.ts`): `min`, `max`, and for a closure, what its rest parameter holds (`none`, a `list`, or an `array` when the rest parameter is forwarded; see `%apply`). Intrinsics use the same `min`/`max`. Every way into a closure binds arguments with `bindArgs`: a new frame, a self tail call (which binds over its own registers, so the rest value is built first and positionals move down), and a direct entry's rest parameter (`restValue`); AOT code for self tail calls inlines the same steps. A wrong count is always reported as `name: expected exactly 2 args, got 1` (or `at least n`, or `n to m`), whether the callee is a closure or an intrinsic.

## Pipeline

1. A front end reads the source and lowers it to core forms (a call of a builtin becoming a call of its intrinsic).
2. `analysis.ts` works out which variables live in `Box`es: those captured (used from inside a nested `%lambda`; a `%let` is not a boundary), and those assigned with `set!` that are live across a call, i.e. read after a call that is not a leaf (may call back into the VM) before being assigned again. A continuation captured during such a call restores the frame's registers when re-entered, so only then would a register copy differ from a shared location. A second, backward liveness pass over the core forms (with a fixed point for `%loop`, and `%escape` flowing to its block's continuation) finds them; calls of leaf intrinsics do not count. It also finds the rest parameters that are only ever the list of an `%apply` / `%apply-multi`, which are forwarded as arrays (see `%apply`).
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
- **Direct entry** (`directFn`, fixed arity or rest-list variants): takes the arguments as JS arguments and returns the result. It allocates no frame, and is emitted as structured JS (`if`/`else` from `IF`/`ELSE`/`ENDIF`, an `ELSEIF` chain as a labeled block of `if`s that `break` out of it, self tail calls as `continue`). Non-tail calls to compiled closures with a matching arity call their direct entry, up to a depth of `MAX_JS_DEPTH`: every direct entry takes the current depth as an argument (`direct$(ctx, closure, executor, depth, ...args)`) and passes `depth + 1` on, and resume code starts at 1. A call to the function's own closure with its own arity (plain recursion) calls itself by name, skipping the closure and arity checks.

Direct code has no heap frames, so when something needs them (`call/cc`, invoking a continuation, a call that cannot be made directly, a host error, the depth limit, a coroutine switch) it throws a `Suspend`. Each direct function it passes through rebuilds its own `Frame` from its locals at `rip` (the resume point of the call it was making; `rip = -1` marks a tail call, which adds no frame). The heap-mode caller that started the direct chain attaches its frame and performs the pending action (`executor.resumeSuspend`), after which execution continues in resume mode. Rebuilding frames on every capture is expensive, so when direct calls of a function keep ending in a `Suspend` for `call/cc`, a continuation call or a yield (`DIRECT_SUSPEND_LIMIT` times, counted on the outermost direct function the `Suspend` passed through), that function's direct entry is switched off and calls to it use heap frames from then on, where capturing needs no rebuilding. Errors count too, since each direct function an error passes through catches and rethrows it (a JS throw costs about 200ns), while heap code handles it with a single throw; depth-limit suspends do not count. Intrinsics also raise errors without a JS stack trace (`hostError` in `errors.ts`), since Anima builds its own tracebacks and V8's stack capture was most of the cost of a handled error. Likewise, direct code resumes a coroutine in a nested driver loop only `DIRECT_SUSPEND_LIMIT` times per function; after that it suspends instead, since resuming from heap frames is a switch inside one driver loop.

Tail calls from heap code also use the callee's direct entry when it has one: the resume function returns the callee's value right after, so the JS stack does not grow, and a `Suspend` out of the callee rebuilds its frames on top of the tail caller's caller. A long chain of tail calls that way would reach the depth limit and unwind a thousand JS frames every time, so once a function's heap tail calls have come back as a `Suspend` `DIRECT_SUSPEND_LIMIT` times, its tail calls use heap frames instead, which run such chains in constant space.

Top-level code starts through its direct entry too (it is a zero-argument function), falling back to heap frames the same way on a `Suspend`. A function that nests structured control flow more than `MAX_STRUCTURED_NESTING` levels deep (e.g. a `cond` with hundreds of clauses) gets a `switch`-based direct entry instead, since V8 fails to compile JS nested thousands of levels deep.

Code shared between instances (e.g. a front end's prelude, compiled once) runs as a copy per instance (`ByteCode.fresh`: shared instructions, its own templates and adaptive counters, bound to the instance's intrinsics), so one program's heap-mode switches never reach another instance. The JS of copied code is generated and compiled (`new Function`) once, cached by instruction array and by what the intrinsics it calls generate (positions, templates, deps), so instances whose intrinsics were registered the same way share it; each copy only calls the compiled factory for its own functions. A constant closure (no upvars) is shared by the copies outright when its intrinsics resolve to the same functions in the instance's table (`ByteCode.runsWith`), as they do for tables copied from the same base (`new Anima(impl, maxSteps, base)`).

Global variable reads are cached per instruction site, keyed by the environment and `Env.globalsVersion`, which changes whenever an environment compiled code has read globals from is modified.

## Coroutines

Each coroutine owns an execution context. Resuming records `co.resumer = { ctx, frame }` and hands the coroutine's next frame to the driver loop; yielding or finishing hands control back to the resumer's frame. So resume and yield are frame switches inside one driver loop, and a resume in tail position records the caller's caller, which makes it a proper tail call.

A non-tail resume from direct code instead runs the coroutine in a nested driver loop (`coResumeNested`), because it is already on the JS stack (except inside a coroutine: a coroutine resuming another suspends to heap frames, so they can be traced while it waits); control returning to the throwaway "barrier" context ends the nested loop. Nesting is capped by `MAX_NESTED_RESUMES`, after which the in-loop path is used. The host resumes coroutines the same way.

## Errors

- A **host error** (a JS exception thrown by an intrinsic or by compiled code) is handled by `executor.handleHostException`, which delivers it as an `ErrorObject` through the exception model (see above), so handlers and `%catch` see it like any raised value.
- `UnhandledError` is thrown by `raise` when no handler is installed. At the top level it becomes the JS error seen by the host. Inside a coroutine it kills the coroutine and is re-raised in the resumer.
- `ReRaise` carries an error that escaped a coroutine into its resumer, so the resumer's handlers receive the original raised value.
- `EscapedError` wraps an error that has already been through `handleHostException`, so enclosing compiled code does not handle it a second time. The driver loop unwraps it.
- `Suspend.error` is how an error inside direct code reaches the heap frame that can handle it.

## Debugging

- **Names**: a lambda is named after what it is bound to (`define`, `set!`, `let`), else `lambda@file:line`. A front end can rename the procedures it exports.
- **Source positions**: the reader records the position of every list form, and `%at` overrides it. The syntax transformer carries positions through macro expansion (an expansion inherits its macro call's position). The compiler emits `Pos` IR nodes, which lower into `ByteCode.lineTable` (`ip, file, line, col` entries); `positionAt(ip)` looks one up. Positions cost nothing at runtime.
- **Tracebacks**: `(debug-frames [co] [level])` and `(debug-traceback [co] [msg] [level])` take a snapshot of the stack in the calling function: the syntax transformer rewrites a direct call to `(%debug-traceback (%current-stack) (list args ...))` (see `%debug-frames` / `%debug-traceback`), so the caller itself is its first frame. A frame's position is that of the call it is waiting on. Frames removed by tail calls do not appear. `(debug-traceback co)` traces another coroutine: a suspended one from where it yielded, a normal one (waiting on a coroutine it resumed) from where it resumed it, and an unstarted or dead one as empty. The host can get a coroutine's traceback with `Anima.traceback(co)`.
- **Unhandled errors**: the VM builds a traceback from the raising frame before giving up, and it is attached to the JS error as `animaTraceback`. For an error that escaped a coroutine, the coroutine's traceback is kept.
- **Debug mode** (`implDebug` / `implAotDebug`, i.e. `new Compiler(true)`): the compiled `ByteCode` is flagged `debug`, and interpreter and AOT code for it
  - record every tail call in a continuation mark on the frame it replaces (the last 16 callees, repeats collapsed to `name xN`), which tracebacks show on that frame as `(tail calls: ...)`; as a mark it travels with continuations and coroutines;
  - track the exact position of the last operation (`frame.posIp`, or `dip` in direct code), so errors inside inlined intrinsics report the right position.
  Debug and non-debug code can run side by side (code compiled without debug, such as a prelude, stays out of the tail history), but there is only one set of compiled AOT functions per `ByteCode`.

## Continuation marks

Marks are an immutable list, newest first, of `(key, value, frame)` entries, where `frame` numbers the logical frame the mark belongs to. Direct functions take the list and their logical frame as arguments (`direct$(ctx, closure, executor, depth, marks, mframe, ...args)`): a non-tail call passes `mframe + 1`, a tail call passes `mframe` unchanged, so the callee continues its caller's frame, as in Racket. Heap frames keep them in `frame.marks` / `frame.mframe`, so `call/cc` and coroutines capture them with the frames. `%with-mark` in tail position replaces the current frame's entry for its key; otherwise the compiler saves the marks in registers (`MARKSAVE`), starts a new logical frame and puts them back after the body (`MARKRESTORE`), also on an `%escape` out of it. Setting a mark allocates one list node; code that uses no marks only pays for passing the two arguments (about 5% on call-bound code such as fib).

The library follows Racket: `with-continuation-mark`, `current-continuation-marks`, `continuation-mark-set-first` (`#f` means the current continuation; direct calls are rewritten to `%marks-first`), `continuation-mark-set->list` and `continuation-mark-set?`.

## Bytecode serialization

`dumpFull`/`readFull` (`utils.ts`) prefix the serialized bytecode with a magic word and `BYTECODE_VERSION`. Bump the version whenever opcodes, core operation positions or the serialized layout change. Code that only uses core operations loads without a table (it is bound to `CORE_INTRINSICS`).

Each `ByteCode` refers to the `Intrinsics` table it was compiled against (`table`, null when it uses no intrinsics), and records the intrinsics it uses in its metadata (`intrinsics`: position, name, and whether it was compiled as a leaf). `CALLINT`/`CALLHOST` operands are positions in that table, so code always calls the intrinsics it was compiled with, whichever instance runs it.

Binding (`ByteCode.bind`) moves code to another table by name: `readFull(buf, anima.intrinsics)` binds everything it loads, and `fresh(copies, intrinsics)` binds a copy. It is an error if an intrinsic is not registered in the new table, or is registered as a leaf when the code was compiled for a non-leaf, or the other way round (the boxing analysis depends on it). Instructions are rewritten (copied first if other code shares them) only when a position differs. Loading code that uses intrinsics without a table is an error. The disassembler shows intrinsics by name.
