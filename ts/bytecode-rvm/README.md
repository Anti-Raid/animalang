# Compiler Syntax Specification

This document specifies the core language the compiler accepts, the compiler intrinsics and host intrinsics, and how compiled code runs.

The compiler only understands `%` forms: a language's front end (its reader and syntax transformer) lowers its surface syntax to the core forms below, and transpilers can emit core forms directly. Anything else in the compiler's input is a variable reference, a literal or a call. Core form and intrinsic names cannot be bound, nor can the names a front end reserves (`Intrinsics.reserved`).

### Representation

The compiler's input is JS data, not a language's syntax tree: a form is an array `[op, operand ...]` whose first element is a core form's or intrinsic's symbol (or, for a call, the procedure expression); a symbol is a variable reference; anything else that is not an array is a literal. The forms with binders or labels have fixed shapes:

| Form | Shape |
|---|---|
| `%quote` | `[%quote, datum]` (the datum is data, any value, arrays included) |
| `%lambda` | `[%lambda, clause ...]`, each clause `[options, [param ...], rest, body ...]`: `options` a list of symbols (`[]`, or `[pad]`), `rest` a symbol or `null` (helpers in `lambda.ts`) |
| `%let`, `%let*`, `%letrec` | `[op, [[name, init] ...], body ...]` |
| `%let-values`, `%let-values/strict` | `[op, [[[param ...], rest, init] ...], body ...]` |
| `%set!`, `%define-global` | `[op, name, expr]` |
| `%block`, `%escape` | `[op, label, expr ...]` |

An array value (e.g. a vector literal) must be quoted, since an array is a form. Positions are attached to forms through `SOURCE_POS`. A front end converts its expanded code to this, leaving the data it quotes in its own representation.

## Core Language

### Atoms and Literals

- **Symbols**: Evaluated as variable references resolved based on lexical scoping (local scope, enclosing function scope, or global scope).
- **Null**: `null` (a front end may use it, e.g. as its empty list).
- **Primitives**: Numbers, strings, booleans, and undefined constants.

### Core Forms

A core form binds variables or does not evaluate its operands the usual way. Primitives that evaluate their operands normally, even ones that transfer control or read implicit state (`%call/cc`, `%raise`, `%current-marks`), are intrinsics.

| Core form | Semantics |
|---|---|
| `(%begin <expr> ...)` | Evaluates the expressions in order; the last one gives the value and keeps tail position. `(%begin)` is `undefined`. |
| `(%if <c1> <e1> <c2> <e2> ... [<else>])` | Evaluates the conditions in order and gives the branch of the first true one, else `<else>` (`<#void>` without one); the branches keep tail position. However many clauses, it compiles to one flat chain, `IF c1; e1; ELSE end; <c2>; ELSEIF c2; e2; ELSE end; ...; <else>; ENDIF`: a condition that is false costs one jump, and the AOT direct entry emits the chain as a labeled block of `if`s that `break` out of it, never nesting per clause. |
| `(%quote <datum>)` | Yields `<datum>` unevaluated. Quoted data is never transformed. |
| `(%lambda clause ...)` | A procedure. With one clause, a closure; with several, a procedure (`CaseLambda`) that runs the first clause whose arity fits the call: each clause is an ordinary closure, made in a block, then wrapped by `%make-case-lambda`, and a call selects the clause (`CaseLambda.select`) and calls it as usual, so each keeps its direct AOT entry (call sites only look for a `CaseLambda` on the path they take when the callee is not a directly callable closure). No clause for the count is `Msg.NoClause`; bound locally (see the lifting step of the pipeline), its calls go to their clauses directly. A clause with the `pad` option (Lua's calls) takes any count: missing parameters are `<#void>` and extra arguments are dropped, or go to its rest parameter. A clause after a padded one would never run, so it is an error (`Msg.UnreachableClause`), as is an unknown option (`Msg.LambdaOption`). |
| `(%let ((<symbol> <init>) ...) <body> ...)` | Evaluates the inits in the enclosing scope, then binds them in a block of the current function (registers, no closure). |
| `(%let* ((<symbol> <init>) ...) <body> ...)` | Like nested `%let`s, one per binding, without the nesting: each init sees the names bound before it, and a name bound twice is two variables. The passes over it loop over the bindings, so a long `%let*` (e.g. a function with thousands of locals) compiles in time proportional to its length, with no depth limit. |
| `(%letrec ((<symbol> <init>) ...) <body> ...)` | Binds the names in a block, like `%let`, but visible in the inits, so they can refer to each other (`letrec*`). The lambda inits are made first, all at once; the other inits then run in textual order. A name that is never assigned holds its value directly, and the closures that captured it before it existed have it filled in once it does (`FIXUPVAR`), so no box is needed. A name that is assigned is a box, as with `%set!`, and so is a value a closure may copy before its init has run: one mentioned by a lambda in an earlier (or its own) init, or any value once an init may have run the `%letrec`'s lambdas (it mentions one, or a value whose init did). |
| `(%let-values ((<formals> <expr>) ...) <body> ...)` | Like `%let`, binding each expr's multiple values to `<formals>` (`(a b)`, `(a b . rest)` or `rest`). Missing values are `<#void>`; extra values are dropped unless there is a rest variable. Compiles to `UNPACK`, with no closures. |
| `(%let-values/strict ((<formals> <expr>) ...) <body> ...)` | The same, but a wrong number of values is an error. The two differ only in a flag on `UNPACK`. |
| `(%set! <symbol> <expr>)` | Updates the binding of `<symbol>` according to lexical scoping. |
| `(%with-mark <key> <value> <body>)` | Evaluates `<body>` with the continuation mark `<key>` = `<value>`. In tail position the mark goes on the current frame, replacing its value for `<key>` (so a tail-recursive loop keeps one mark); otherwise `<body>` runs as a new frame and the mark is gone once it returns (or escapes). |
| `(%catch <thunk> <handler> [<pre> [<guarded>]])` | The value(s) of `(<thunk>)`; if an error reaches it, `(<pre> err)` runs first if given (still inside the raise, with the outer handlers), then everything unwinds to the `%catch` (running `dynamic-wind` after thunks), and `<handler>` is evaluated and called with `pre`'s result, or else the error, in tail position if the `%catch` is. `<handler>` is evaluated only when an error is caught, so a literal lambda costs nothing otherwise; `<pre>` is evaluated before `<thunk>` is called. `<guarded>` is a literal `#t` or `#f` (passed on to `%call-catching`): when `#t`, an error raised while `<pre>` runs (and not handled inside it) comes to this `%catch` too, as an error object worded by `Msg.ErrorInHandler`, as Lua's `xpcall` does with an error in its message handler; unguarded, it goes to the outer handlers. |
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
- **Semantics**: Calls `<proc>` with an escape continuation `k`. Calling `(k v)` while `<proc>` is still running makes the `%call/ec` return `v`, running `dynamic-wind` after thunks on the way out; marks are restored as with any return. Calling `k` after the `%call/ec` has returned or been escaped past is an error, as is calling it from another coroutine; an extent re-entered through a full continuation is live again. A core control operation (see below), registered with `tail: false`.
- Cheaper than `%call/cc` because it never needs heap frames: in direct code the call runs inside a JS `try/catch`, and an escape that has no `dynamic-wind` to unwind is caught right there. Escapes that do unwind, or that come from heap code, rebuild the frames and jump like a continuation, to the nearest frame on the caller chain holding `k` as the token of its pending call (`Frame.escape`: set by heap code at the call, and by direct code on the frame it rebuilds, `executor.pushEscape`). A frame has one pending call at a time, and the driver clears the field whenever it resumes the frame, so once the `%call/ec` returns, no frame holds `k` and calling it is an error; copies of the frame made by `call/cc` hold `k` too, so escapes out of a re-entered extent work. JS exceptions are slow (hundreds of ns), so a function whose `%call/ec` keeps being escaped from switches to heap frames after `DIRECT_SUSPEND_LIMIT` escapes, where the receiver gets a heap frame and escapes are plain jumps.

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
- **Form**: `(%apply <proc> <arg> ... <array>)`
- **Semantics**:
  - Calls `<proc>` with the `<arg>`s followed by the elements of `<array>`.
  - `<proc>` may be a registered leaf intrinsic (`(%apply %name args)`), which compiles to `APPLYINT` (see below).
  - Otherwise it is a call of the control operation `%apply-array` over `[proc, arg ..., array]` (a tail call in tail position), which returns a call request (`HostTail`) of `<proc>` with the spliced arguments. When `<array>` is the only one and comes from an intrinsic registered `fresh` (or the table's spread, or an `%apply` of one), it is `%apply-fresh`, which calls with the array itself instead of a copy.
  - **Rest forwarding**: a front end with its own sequences (see sequences below) writes `(%apply proc arg ... (spread x))`. When `x` is a lambda's rest parameter that is never used any other way (not read as a value, assigned, or captured), the closure's rest arguments are bound as the plain array (`rest: "array"`) instead of being packed, and `(spread x)` compiles to `x`. So a wrapper like `(lambda args (%apply %+ (spread args)))` packs nothing, and applying an intrinsic this way passes the array itself as the argument window.

### Sequences
Rest parameters and `%apply` use arrays unless the table has its own sequences: an intrinsic registered with `sequence: "pack"` makes one of an argument window, and one with `sequence: "spread"` makes the array `%apply` takes of one. A rest parameter (and a `%let-values` rest variable) is then packed: the closure's `rest` is `"packed"`, and its code records the pack intrinsic's position (`ByteCode.restPos`), which binding a call uses (`bindArgs`) and AOT code for a self tail call inlines.

### The exception model
- **One handler list.** The handlers in effect are a continuation mark under the key `(%handler-key)` returns: a `Handlers` list (`%push-handler`), innermost first, whose entries are handler procedures (which a front end installs by setting that mark) and catch tokens (from `%catch`). It follows frames, so escapes, continuations and re-entry restore it without `dynamic-wind`; a coroutine starts with none, and an error escaping it is raised again in its resumer, with the marks of the code that resumed it.
- **Delivery** (the VM's `executor.raise`, for `%raise` and for host errors alike) looks at the head of the list:
  1. empty: unhandled; the VM builds the traceback from its frames and throws to the host;
  2. a catch token: its `pre` runs if it has one, then the VM escapes to its `%catch` with the value wrapped in a `Caught`;
  3. a handler procedure: called with the rest of the list installed. If it returns, that is the value of a continuable raise; otherwise "handler returned on non-continuable exception" is delivered to the rest of the list.
- **Host errors** (an intrinsic throwing a JS `Error`) become error objects and are delivered as if raised where they happened, with the marks of a tail call that left no frame.
- **Helper frames.** Two tiny bytecode functions built into the VM (`raiseHelpers` in `executor.ts`) sit under a handler it calls: one raises the secondary error when a non-continuable raise's handler returns, one escapes to a catch token with what its `pre` returned. Their marks hold the outer handlers.
- **Fast paths.** `%catch` compiles to a call of the core control operation `(%call-catching <thunk> [<pre> [<guarded>]])`, which gives the thunk's value or a `Caught`, its frame holding its token as with `%call/ec`; in direct code, an escape to its token, or an error whose innermost handler is its token (and which has no `pre` and no `dynamic-wind` to unwind), is caught right at the site by a JS `try/catch`. `%raise` is a control operation; from direct code, raising to a plain catch token is such an escape.
### Delimited continuations
- **Forms**: `(%call-with-prompt <tag> <thunk> <handler>)`, `(%call/comp <proc> <tag>)`, `(%abort <tag> <array>)`. Tags are any values, compared by identity.
- **Prompts.** `%call-with-prompt` calls `(<thunk>)` under a prompt: an internal helper frame (`raiseHelpers().prompt`) holding the tag, the handler and the wind it was installed in. The thunk's value goes to `%prompt-finish` in the helper frame, which returns it.
- **Aborts.** `%abort` finds the nearest prompt with the tag among the calling frames and jumps to its helper frame (running `dynamic-wind` after-thunks down to the prompt's wind) with an `Aborted` of the values; `%prompt-finish` then calls the handler with them, in tail position. No prompt with the tag is `Msg.NoPrompt`.
- **Composable continuations.** `%call/comp` calls `<proc>` with a `ComposableContinuation`: the heap frames up to the nearest prompt with the tag (not including it), the wind points entered since the prompt, and the logical frame the frames start at. The frames are shared from then on, as `call/cc` shares them, so they stay as captured. Calling it with values runs copies of the frames on top of the caller's continuation (returning to the caller, or to its caller for a tail call), multi-shot:
  - their marks inside the prompt are moved onto the caller's (logical frame numbers shifted, entries below the prompt replaced by the caller's marks), so parameterizations and handlers inside come along and those outside come from the call site;
  - the wind points entered since the prompt are entered again, as copies on top of the current wind (their before-thunks run); each copied frame maps the originals to the copies (`Frame.winds`, `mapWind`), so its `%catch` tokens and escape continuations unwind to the copies;
  - a continuation barrier inside it cannot be composed (`Msg.BarrierReentry`).
- **Cost.** They are control operations (see below): from direct code, installing a prompt, capturing or aborting suspends to heap frames, like `%call/cc`. `%call/cc` is unchanged: it captures the whole continuation, whatever prompts there are.

### Coroutine intrinsics
- **Forms**: `(%coroutine-create <proc> [<finally>])`, `(%coroutine-resume <co> <val> ...)`, `(%coroutine-yield <val> ...)`, `(%coroutine-status <co>)`, `(%coroutine-close <co>)`, `(%coroutine-raise <co> <obj>)`, plus `(%coroutine-resume-array <co> <array>)`, which takes the values as an array
- **Semantics**:
  - Asymmetric, one-shot coroutines. Each coroutine owns its own execution context (frames, wind stack, handler stack), so it can be resumed from any later evaluation, including by the host via `Anima.coroutineResume(co, ...vals)`, which returns `{ done, value, values }` (`value` is the first of `values`).
  - Resume and yield switch coroutines inside the driver loop (every frame records its execution context), so nothing nests on the JS stack. `%coroutine-resume` in tail position is a proper tail call: the coroutine's yields and final value go straight to the caller's caller, so chains of tail resumes (schedulers, symmetric hand-offs) run in constant space. They are control operations (see below); the variadic forms take their values over the argument window.
  - The first resume passes its values as the procedure's arguments. Later resumes make the pending `%coroutine-yield` return their values, and `%coroutine-resume` returns the yielded values, both as multiple values (see `values`).
  - Status is one of `suspended`, `running`, `normal` (it resumed another coroutine) or `dead`. Resuming a non-suspended coroutine is an error.
  - `(%current-coroutine <missing>)` is the coroutine running now, or `<missing>` outside any. A host intrinsic can ask the same with `Anima.currentCoroutine()` (the executor tracks it as coroutines switch), and whether that code could yield (`%coroutine-yieldable?`, `ctx.coroutineYieldable`) with `Anima.coroutineYieldable()`; code the host runs, and the host itself between runs, are outside any coroutine until they resume one.
  - An error the coroutine does not handle marks it `dead` and is raised again in the resumer as-is, after the coroutine's pending `dynamic-wind` after-thunks run (innermost first, inside the coroutine, as `%coroutine-close` runs them); an error in an after-thunk replaces it.
  - `<finally>`, a thunk, runs once a coroutine that started is left for good: it returns (after the thunk, its values are the resume's), dies with an error, or is closed; not on a yield. The procedure runs as the body of a `dynamic-wind` whose after-thunk is `<finally>`, entered when it starts, so an error or a close runs it as they run any pending after-thunk, and it cannot yield. The procedure returns through a frame of the VM's that calls it, which tracebacks leave out.
  - `(%coroutine-raise <co> <obj>)` resumes `<co>` with its pending `%coroutine-yield` raising `<obj>` (non-continuably) instead of returning, so the coroutine's own handlers see it; if they handle it, the coroutine goes on, and the resume returns what it next yields or returns. A coroutine that never ran dies with the error without running. The host equivalent is `Anima.coroutineRaise(co, obj)`, which returns as `coroutineResume` does.
  - `dynamic-wind` thunks do not run on yield/resume, so global state changed by a wind thunk stays changed while the coroutine is suspended. Coroutine-local dynamic state belongs in the execution context (as the handler stack does).
  - `(%coroutine-close <co>)` runs a suspended coroutine's pending `dynamic-wind` after-thunks (innermost first, inside the coroutine) and marks it `dead`. Closing a dead coroutine does nothing, closing a running one is an error, and yielding during close is an error. The host equivalent is `Anima.coroutineClose(co)`.
  - Yielding from inside code a host function runs itself (rather than through a tail request) is an error: that code runs in a separate execution context.

### `%first-value`
- **Form**: `(%first-value <expr> <missing>)`
- **Semantics**: The first of `<expr>`'s multiple values, `<expr>` itself if it is a single value, or `<missing>` if it has none (Lua passes `nil`, `<#void>`). This is Lua's truncation of a call used as a single value (`g() + 1`, `f(g(), x)`); the AOT emitter inlines it as an `instanceof MultipleValues` check.

### `%debug-frames` / `%debug-traceback`
- **Forms**: `(%debug-frames <stack> <args> <missing>)`, `(%debug-traceback <stack> <args>)`, where `<stack>` is a stack snapshot from `%current-stack` and `<args>` is the array `#([coroutine] [msg] [level])`
- **Semantics**: Describe the frames of `<stack>` (or of a suspended coroutine) as an array of `#(name file line col)` records (`<missing>` for a position it does not know), or a traceback string.
### Core operations
The VM's own operations. They are intrinsics like any other (see host intrinsics), registered in `CORE_INTRINSICS` (`coreops.ts`), which every table starts from (`newIntrinsics` in `core.ts`; the compiler refuses a table that does not). So each is at the same position in every table: the compiler emits several of them itself when lowering other forms (by `corePos(name)`), and every one can also be written directly. They compile like any intrinsic (`CALLINT`, or `CALLHOST` for `%coroutine-close`), with AOT templates for the small ones. Those that can come up empty take the value to give then as a last `<missing>` argument, so each front end supplies its own (`#f`, say, or Lua's `nil`, which is `<#void>`), and those that need the running context are registered with `context` and get `ctx` and `executor` as extra arguments:

| Form | Arguments | Leaf | What it does |
|---|---|---|---|
| `%coroutine-create` | 1-2 | yes | make a coroutine from a procedure, with an optional finally thunk |
| `%coroutine-status` | 1 | yes | a coroutine's status |
| `%coroutine-yieldable?` | 0 | yes | whether `%coroutine-yield` would work here: inside a coroutine that is not being closed |
| `%current-coroutine` | 1 | yes | the coroutine running now, or the argument outside any |
| `%coroutine-close` | 1 | no | close a coroutine, running its pending dynamic-wind after-thunks |
| `%wind`, `%end-wind` | 2 (before, after), 0 | yes | push / pop a wind point: the steps `%dynamic-wind` lowers to. They must be balanced |
| `%caught?`, `%caught-value`, `%make-caught` | 1 | yes | test / unwrap / make the value a `%catch` produces when its thunk raised |
| `%handler-key` | 0 | yes | the continuation-mark key the exception handlers live under |
| `%barrier-key` | 0 | yes | the continuation-mark key of continuation barriers: a mark under it with a new object as its value guards its extent, so a full continuation captured inside cannot be called from outside it (`Msg.BarrierReentry`, checked when a continuation is called: every barrier value in its marks must be in the caller's); escaping out is allowed |
| `%push-handler` | 2 | yes | the handlers mark with a handler procedure innermost |
| `%values` | any | yes | multiple values of the arguments |
| `%make-case-lambda` | 1 or more | yes | the procedure of a `%lambda` of several clauses, from their closures |
| `%values-cons` | 2 | yes | prepend a value to multiple values |
| `%values->array` | 1 | yes | an array of multiple values |
| `%first-value` | 2 | yes | see above |
| `%marks-first`, `%marks->array` | 3, 2 | yes | `continuation-mark-set-first` / the values of a key, innermost first |
| `%debug-frames`, `%debug-traceback` | 3, 2 | yes | see above |

### Control operations
Core operations that transfer control, so they are not leaves: `%call/cc`, `%call/ec`, `%call-catching`, `%raise`, `%current-stack`, `%coroutine-yield`, `%coroutine-resume`, `%coroutine-resume-array`, `%coroutine-raise`, `%call-with-prompt`, `%call/comp`, `%abort`, `%prompt-finish` (what a prompt's helper frame returns through: not a request, it returns the value or a `HostTail` of the handler), and `%apply-array` and `%apply-fresh` (what `%apply` of a procedure compiles to). Each returns a control request (see below), so they need no opcodes of their own. `%call/ec`, `%call-catching`, `%raise`, `%current-stack` and the yields are registered with `tail: false`: their value is that of the call itself, so they are never compiled as tail calls.

### Host intrinsics
- **Registering**: `anima.registerIntrinsic(name, fn, { args, leaf, inline, deps })` makes `(name arg ...)` an intrinsic of that instance: its compiler, VM and front end share one `Intrinsics` table, and nothing about it is global. `name` must start with `%`, and cannot be a core form, a core operation or an intrinsic already registered. A name only means the intrinsic in code compiled after it is registered. `anima.freeze()` stops further registrations; compiling and loading are unaffected.
- **Calling convention**: `fn(regs, start, nargs)` reads its arguments from `regs[start .. start+nargs)`. It must not write to `regs` or keep it: in the interpreter it is the caller's live register file. `args` is `[min, max]`, checked at compile time. `context: true` (for the core operations) also passes the running `ExecutionContext` and `VMExecutor`: `fn(regs, start, nargs, ctx, executor)`.
- **Inlining**: `inline(args, slow, tmp, d)` is an AOT template: given the argument expressions (plain variables, so they may be repeated), the direct call `slow`, a scratch variable `tmp` and `d`, it returns a JS expression, or null to make the direct call. `deps` names the values the template needs (`deps: { Vec3 }`); the template refers to them as `${d.Vec3}`, which generated code reads from a local set up once per function. Using a name that is not in `deps` is an error when the code is generated.
- **Kinds**: `returns` declares what an intrinsic returns, as a kind or a rule giving one from what is known of its arguments' kinds (`(kinds) => kind | undefined`), and `wants` the kind its fast path wants its arguments to be (see type facts). The template's fifth argument, `known`, gives each argument's kind when certain. A slow path whose result's kind is known is wrapped so V8 sees it (`!!slow` for booleans, the type system's `coerce` otherwise).
- **Control requests**: unless it is a `leaf`, an intrinsic may return a control request instead of a value, to call back into the VM or yield (see below). Such intrinsics compile to `CALLHOST pos start nargs tail` and count as calls for the boxing analysis.
- **Leaves** (`leaf: true`) never call back into the VM: they compile to `CALLINT pos dst start nargs` and are not calls for the boxing analysis. "Leaf" does not mean pure: a leaf may have side effects.
- Errors an intrinsic throws are host errors (see the exception model); `hostError` in `errors.ts` makes one without the cost of a JS stack trace.

### Control requests
What a non-leaf intrinsic may return instead of a value: a `ControlRequest` (`coreops.ts`), a transfer of control the VM carries out where the intrinsic was called (`CALLHOST`), as if the call site were that operation.
- **Carrying one out**: heap code calls `run(ctx, executor, frame, isTail)` with the calling frame, whose ip is already past the call; a non-tail request leaves its value in `ctx.acc` (read by the `MOVEACC` that follows), a tail one hands it to the frame's caller, and it returns the frame to run next. Direct code, which has no heap frame, calls `direct(ctx, executor, closure, marks, mframe, isTail)`: it returns the value, or throws a `Suspend` to carry the request out on heap frames (a nested resume runs the coroutine in place instead). The interpreter handles every request in this one place.
- **From the host**:
  - `hostTail(proc, arg ...)` (or `new HostTail(proc, args)`): the value is `(proc arg ...)`, made as an ordinary call (a tail call if the intrinsic was in tail position), so it can yield, capture continuations and raise. This is how host libraries (userdata, Luau tables and their metamethods) call back into the VM. To pass on part of the window, `hostTailFrom(proc, regs, from, count)` copies it with a loop: `regs.slice` with a spread costs about twice as much on windows this small.
  - `hostYield(v ...)`: the coroutine running the call yields the values, and those it is resumed with are the value of the call (its caller's, in tail position; with no caller left, resuming it returns them from the coroutine). A raise into it is raised where it yielded. A JS function cannot yield itself, as its own stack cannot be suspended.
- **The core operations' requests** are reused (`of`), since the VM reads a request's fields before running anything else, which shows in tight coroutine loops. The AOT compiler writes out what each one's request does at the call (`CONTROL_AOT` in `aot/emit.ts`: a template for heap code and one for direct code), so compiled code makes no request object and does not dispatch on one; the argument checks are helpers shared with the intrinsics.
- In debug code, a request made in tail position records its procedure (or coroutine) as the tail call (`tailProc`).

### How intrinsics are compiled
- **Core operations** (see above) are intrinsics at fixed positions (below `CORE_COUNT`) in every table, so they compile as below.
- **Applying a registered leaf intrinsic** (`(%apply %name arg ... array)`) compiles to `APPLYINT pos dst start nargs`: the last argument is spread as by `%apply`, and since the count is only known at run time, it is checked against the intrinsic's `args` there. Only leaves can be applied.
- **Registered intrinsics** compile to `CALLINT pos dst start nargs` (leaves) or `CALLHOST pos start nargs tail`, where `pos` is the intrinsic's position in the table the code is compiled against. The interpreter calls `code.table.fns[pos](regs, start, nargs)`; AOT code inlines the intrinsic's template when it has one; a call that is the fast path goes through a local the function is read into once (which V8 can inline), while a template's fallback goes through `RT[pos]`, so V8 does not inline the function into a cold path, which measurably slows the hot one.
- **Control flow**: `CALL` and `CALLHOST` take a trailing `tail` operand (bit 0 set in tail position; non-tail forms are followed by `MOVEACC`), and `RETURN` leaves the function. The control operations, `%call/ec` and `%catch` included, are `CALLHOST`s of core intrinsics (see above).

# Runtime Architecture

This section describes how compiled code runs. The code is layered: `bytecode.ts` (compiled code and closures), `values.ts` (frames, contexts, continuations, coroutines, `Suspend`), `coreops.ts` (the core intrinsics and control requests), `interpreter.ts` (the opcodes and the interpreter), `aot/` (the AOT compiler: decoding, liveness, code generation) and `executor.ts` (`VMExecutor` and the driver loop), with no import cycles between them at run time; `exec.ts` re-exports them. Then `vm.ts` (entry points), `opcodes.ts` (the instruction set), and `arity.ts` (argument counts and binding).

## Instruction set
`opcodes.ts` describes every opcode once, in `OPCODES`: its operands, each with a kind (a register, a constant, an immediate, an upvar, a jump target, an intrinsic position, a runtime index, a `tail` operand or flags, with the names of their bits), and whether the instruction after it starts a basic block (always, or unless it is a tail call; jump targets always do). Everything that walks instructions without running them is derived from it: instruction lengths, remapping intrinsic operands when code is bound to another table, the AOT compiler's basic blocks, and the disassembler (`stringifyInst` in `utils.ts`, which prints `NAME operand=value, ...`). `IR.lower` checks each instruction it emits against the spec. A new opcode needs its spec entry, and its cases in the interpreter and the AOT decoder, which are exhaustive switches.

## Argument binding
A procedure's argument count is an `Arity` (`arity.ts`): `min`, `max`, and for a closure, what its rest parameter holds (`none`, an `array`, or `packed`; see sequences), how many positional parameters it has (`params`), and whether it pads (`pad`: `min` 0 and `max` ∞, missing parameters `<#void>`, extra arguments dropped). A padded closure without a rest parameter takes any count on its direct AOT entry (`ByteCode.directPad`: JS fills missing arguments with `undefined` and ignores extra ones); one with a rest parameter goes through `callPadded` when called with fewer arguments than its parameters. Intrinsics use the same `min`/`max`. Every way into a closure binds arguments with `bindArgs`: a new frame, a self tail call (which binds over its own registers, so the rest value is built first and positionals move down), and a direct entry's rest parameter; AOT code for self tail calls inlines the same steps. A wrong count is always reported as `name: expected exactly 2 args, got 1` (or `at least n`, or `n to m`), whether the callee is a closure or an intrinsic.

## Pipeline

1. A front end reads the source and lowers it to core forms (a call of a builtin becoming a call of its intrinsic).
2. `lift.ts` first turns escapes into jumps: in `(%call/ec (%lambda (k) body ...))`, or the same with `%call/cc`, where `k` is never assigned and only ever called in the body itself (not inside a lambda in it, passed on, or used as a value), every call of `k` happens while the call is still running, so it can only be an escape, whichever kind of continuation it is. The body becomes a `%block` (in the same tail position) and each `(k v ...)` an `%escape` to it, carrying `(%values v ...)` for other than one value: no continuation is made, and escaping is a jump. A continuation captured in the body and resumed later resumes the frame holding the block, so an escape there lands where `k` would return to. It then splits local case-lambdas: a `%lambda` of several clauses bound by a `%let`, `%let*` or `%letrec` to a name that is never assigned gets a name per clause (bound in a `%letrec`), and each call of the name with a count a clause takes calls that clause, as a plain call; the procedure itself is only made (`%make-case-lambda` of the clauses) if the name is still used another way. Then it lifts lambdas: a `%letrec` lambda whose name is never assigned and only ever called gets its free local variables as extra parameters, passed by every call (the lifted lambdas it calls, itself included when it recurses, among them), so it captures nothing and compiles to a constant closure instead of one made each time the `%letrec` runs. It is not lifted if a variable it would receive is assigned, may not have its value yet when it is called (a `%letrec` value, see `lateValues`), or is shadowed at a call.
3. `analysis.ts` works out which variables live in `Box`es: only assigned ones (with `%set!`), when they are captured (used from inside a nested `%lambda`; a `%let` is not a boundary) or live across a call, i.e. read after a call before being assigned again. A variable that is never assigned is copied into the closures that capture it.
4. `compiler.ts` turns the expression into IR nodes (`ir.ts`) over numbered registers, and `IR.lower` turns those into a `ByteCode` (a `Uint32Array` of instructions plus a constant pool).
5. The bytecode runs either in the interpreter (`BytecodeInterpreter`) or, in `"aot"` mode, is compiled to JS functions (`AotCompiler`).

## Type facts

V8 speculates on the types it sees, and drops most of our templates' checks itself; but a `typeof` check on a float it keeps unboxed makes it box the float first, an allocation per operation, so a float loop spent most of its time on checks (and a loop over integers the guards V8 kept). The AOT compiler therefore works out which kind of value each register certainly holds (`aot/facts.ts`), and templates skip the checks of what is known.

- **Kinds are the front end's.** A kind is a name (`Kind`) the VM gives no meaning, except `"boolean"`, which it knows (it decides truthiness: a branch on a known boolean tests the register itself, otherwise `r !== false`). A front end gives the others meaning with a type system on its table (`Intrinsics.setTypes`): the kind of a literal (`ofConstant`), a JS test for a kind (`guard`, e.g. `typeof x === "number"`, or `x instanceof ${d.Vec}` with its `deps`), and how to show V8 an expression gives a kind (`coerce`, e.g. `+x`). Facts come from literals, moves, and intrinsics' `returns` rules; without a type system, only booleans are known.
- Direct code is only entered at its start, so its facts are worked out over the whole function, to a fixpoint through loops (`blockFacts`). Resume code is entered at any block, with its registers read back from a frame (which is also how a continuation or a coroutine comes back), so it keeps facts only within a block.
- **Versions for parameters of a kind.** A direct function whose positional parameters are read (directly or through moves) by intrinsics that want a kind (`wants`) is emitted twice: a version knowing them to be of it, and the checked one. `spec` (their `guard`s, made on entry) picks between them, and a self tail call checks its new arguments again before looping.
- Measured, with a front end whose kinds are doubles (`"number"`) and bigints (`"bigint"`): a float loop (a Mandelbrot kernel) 2.5× faster, integer counting loops about 3× faster, call-heavy code (`fib`, `tak`) and list code unchanged. Known bigints get bare JS bigint operators.

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
- **Direct entry** (`directFn`, fixed arity or rest variants): takes the arguments as JS arguments and returns the result. It allocates no frame, and is emitted as structured JS (`if`/`else` from `IF`/`ELSE`/`ENDIF`, an `ELSEIF` chain as a labeled block of `if`s that `break` out of it, self tail calls as `continue`). Non-tail calls to compiled closures with a matching arity call their direct entry, up to a depth of `MAX_JS_DEPTH`: every direct entry takes the current depth as an argument (`direct$(ctx, closure, executor, depth, ...args)`) and passes `depth + 1` on, and resume code starts at 1. A call to the function's own closure with its own arity (plain recursion) calls itself by name, skipping the closure and arity checks.

Direct code has no heap frames, so when something needs them (`call/cc`, invoking a continuation, a call that cannot be made directly, a host error, the depth limit, a coroutine switch) it throws a `Suspend`. Each direct function it passes through rebuilds its own `Frame` from its locals at `rip` (the resume point of the call it was making; `rip = -1` marks a tail call, which adds no frame). The heap-mode caller that started the direct chain attaches its frame and performs the pending action (`executor.resumeSuspend`), after which execution continues in resume mode. Rebuilding frames on every capture is expensive, so when direct calls of a function keep ending in a `Suspend` for `call/cc`, a continuation call or a yield (`DIRECT_SUSPEND_LIMIT` times, counted on the outermost direct function the `Suspend` passed through), that function's direct entry is switched off and calls to it use heap frames from then on, where capturing needs no rebuilding. Errors count too, since each direct function an error passes through catches and rethrows it (a JS throw costs about 200ns), while heap code handles it with a single throw; depth-limit suspends do not count. Intrinsics also raise errors without a JS stack trace (`hostError` in `errors.ts`), since Anima builds its own tracebacks and V8's stack capture was most of the cost of a handled error. Likewise, direct code resumes a coroutine in a nested driver loop only `DIRECT_SUSPEND_LIMIT` times per function; after that it suspends instead, since resuming from heap frames is a switch inside one driver loop.

Tail calls from heap code also use the callee's direct entry when it has one: the resume function returns the callee's value right after, so the JS stack does not grow, and a `Suspend` out of the callee rebuilds its frames on top of the tail caller's caller. A long chain of tail calls that way would reach the depth limit and unwind a thousand JS frames every time, so once a function's heap tail calls have come back as a `Suspend` `DIRECT_SUSPEND_LIMIT` times, its tail calls use heap frames instead, which run such chains in constant space.

Top-level code starts through its direct entry too (it is a zero-argument function), falling back to heap frames the same way on a `Suspend`. A function that nests structured control flow more than `MAX_STRUCTURED_NESTING` levels deep (e.g. a `cond` with hundreds of clauses) gets a `switch`-based direct entry instead, since V8 fails to compile JS nested thousands of levels deep.

Code shared between instances (e.g. a front end's prelude, compiled once) runs as a copy per instance (`ByteCode.fresh`: shared instructions, its own templates and adaptive counters, bound to the instance's intrinsics), so one program's heap-mode switches do not reach another instance's templates. The JS of copied code is generated and compiled (`new Function`) once, cached by instruction array and by what the intrinsics it calls generate (positions, templates, deps), so instances whose intrinsics were registered the same way share it; each copy only calls the compiled factory for its own functions. A constant closure (no upvars) is shared by the copies outright when its intrinsics resolve to the same functions in the instance's table (`ByteCode.runsWith`), as they do for tables copied from the same base (`new Anima(impl, maxSteps, base)`). Such a closure's code, and so its adaptive counters and compiled functions, is then shared by every instance, like the runtime feedback V8 keeps for a function: an instance whose program makes, say, `map` switch to heap frames switches it for all instances in the process. The counters only choose between two ways of running the same code, so results never differ; sharing is what makes creating an instance cheap (a copy of each constant closure costs 25-35% more per instance, and about 2.5x in AOT, which would compile every prelude function per instance).

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

- **Names**: a lambda is named after what it is bound to (`%define-global`, `%set!`, a binding form), else `lambda@file:line`. A front end can rename the procedures it exports.
- **Source positions**: a front end attaches positions to the forms it produces (`SOURCE_POS`). The compiler emits `Pos` IR nodes, which lower into `ByteCode.lineTable` (`ip, file, line, col` entries); `positionAt(ip)` looks one up. Positions cost nothing at runtime.
- **Tracebacks**: `%debug-frames` / `%debug-traceback` describe a snapshot `(%current-stack)` takes in the function that calls it, so written in the caller itself, that function is the first frame. A frame's position is that of the call it is waiting on. Frames removed by tail calls do not appear. Given a coroutine, they trace it instead: a suspended one from where it yielded, a normal one (waiting on a coroutine it resumed) from where it resumed it, and an unstarted or dead one as empty. The host can get a coroutine's traceback with `Anima.traceback(co)`.
- **Unhandled errors**: the VM builds a traceback from the raising frame before giving up, and it is attached to the JS error as `animaTraceback`. For an error that escaped a coroutine, the coroutine's traceback is kept.
- **Debug mode** (`implDebug` / `implAotDebug`, i.e. `new Compiler(true)`): the compiled `ByteCode` is flagged `debug`, and interpreter and AOT code for it
  - record every tail call in a continuation mark on the frame it replaces (the last 16 callees, repeats collapsed to `name xN`), which tracebacks show on that frame as `(tail calls: ...)`; as a mark it travels with continuations and coroutines;
  - track the exact position of the last operation (`frame.posIp`, or `dip` in direct code), so errors inside inlined intrinsics report the right position.
  Debug and non-debug code can run side by side (code compiled without debug, such as a prelude, stays out of the tail history), but there is only one set of compiled AOT functions per `ByteCode`.

## Messages

Every message the VM and the compiler report is an op (`Msg` in `common.ts`) with arguments, e.g. `Msg.NonProcedure` with the value called, or `Msg.Arity` with the name, bounds and count. The VM words none of them and prints no values: whoever uses it (a front end, a transpiler emitting core forms, a host embedding the VM) sets a formatter on its table, e.g. for Lua 5.1's errors:

```ts
table.setFormatter((op, args, fmt, at) => op === Msg.NonProcedure ? `${at?.file}:${at?.line}: attempt to call a ${typeof args[0]} value` : ...)
```

- `fmt` is the installed formatter, so a message shows values through its `Msg.Value` (and a front end's own data prints itself, `Datum.stringify`); `at` is where it happened, when known. Without a formatter a message is the op's name (`Msg[op]`, e.g. `NonProcedure`), and the host reads `op` and `args` from the `VMError`. A formatter can fall back on another front end's for the ops it does not word itself.
- Errors are thrown as `VMError`s (`vmError(op, ...args)`, without a JS stack trace) and worded when delivered: by the executor (`handleHostException`, with the position of the frame it happened in) before Anima code or the host sees them, and by the compiler for its own errors (with the position of the innermost form that has one). Helpers deep in the runtime need no table, and AOT source does not depend on the formatter. Until delivered, a `VMError`'s message is its op's name.
- Tracebacks are `Msg.TracebackHeader` and a `Msg.TracebackFrame` per frame, so their layout is the front end's too, as is the message of an unhandled non-`Error` value (`Msg.Unhandled`).
- Messages about the host's own use of the API (registering intrinsics, loading bytecode) and internal errors are plain English `Error`s.

## Calling what is not a procedure

A call of a value that is not a procedure is `Msg.NonProcedure`, unless the value can be called (Lua's `__call`): its `TRY_CALL` property (`common.ts`) is the procedure to call in its place, which is called with the value before the arguments; `<#void>` (or anything but a procedure) fails as usual. It is a VM procedure, never a JS function, so host code is still only reached through intrinsics. A field ties a procedure to one value; a getter looks it up at each call, as Lua's `__call` must (a metatable's `__call` can change after `setmetatable`):

```ts
obj[TRY_CALL] = closure

class Instance {
    meta: LuaTable | null = null
    get [TRY_CALL]() { return this.meta?.lookup("__call", undefined) }
}
```

- Only values that are not procedures are asked (continuations are called as themselves), and only on the path a call takes when the callee is not a closure or case-lambda it can enter directly, so ordinary calls cost nothing more.
- Direct code calls the procedure it gives through its direct entry (`executor.callOther`), in tail position too, so a hot loop calling a callable value stays on the JS stack; heap code calls it as any call (`executor.invoke`). A `TRY_CALL` getter may be read more than once for one call, so it must only look.

## Continuation marks

Marks are an immutable list, newest first, of `(key, value, frame)` entries, where `frame` numbers the logical frame the mark belongs to. Direct functions take the list and their logical frame as arguments (`direct$(ctx, closure, executor, depth, marks, mframe, ...args)`): a non-tail call passes `mframe + 1`, a tail call passes `mframe` unchanged, so the callee continues its caller's frame, as in Racket. Heap frames keep them in `frame.marks` / `frame.mframe`, so `call/cc` and coroutines capture them with the frames. `%with-mark` in tail position replaces the current frame's entry for its key; otherwise the compiler saves the marks in registers (`MARKSAVE`), starts a new logical frame and puts them back after the body (`MARKRESTORE`), also on an `%escape` out of it. Setting a mark allocates one list node; code that uses no marks only pays for passing the two arguments (about 5% on call-bound code such as fib).

## Bytecode serialization

`dumpFull`/`readFull` (`utils.ts`) prefix the serialized bytecode with a magic word and `BYTECODE_VERSION`. Bump the version whenever opcodes, core operation positions or the serialized layout change. Code that only uses core operations loads without a table (it is bound to `CORE_INTRINSICS`). Constants of a front end's own data types are `Datum`s (`common.ts`), which serialize themselves, and are read back by the factory the type registers (`BSReader.registerType`).

Each `ByteCode` refers to the `Intrinsics` table it was compiled against (`table`, null when it uses no intrinsics), and records the intrinsics it uses in its metadata (`intrinsics`: position, name, and whether it was compiled as a leaf). `CALLINT`/`CALLHOST` operands are positions in that table, so code always calls the intrinsics it was compiled with, whichever instance runs it.

Binding (`ByteCode.bind`) moves code to another table by name: `readFull(buf, anima.intrinsics)` binds everything it loads, and `fresh(copies, intrinsics)` binds a copy. It is an error if an intrinsic is not registered in the new table, or is registered as a leaf when the code was compiled for a non-leaf, or the other way round (the boxing analysis depends on it). Instructions are rewritten (copied first if other code shares them) only when a position differs. Loading code that uses intrinsics without a table is an error. The disassembler shows intrinsics by name.
