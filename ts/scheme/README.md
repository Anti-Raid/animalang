# Scheme

`createScheme(impl, maxSteps?)` (`index.ts`) makes an `Anima` instance that runs Scheme. The compiler and VM underneath know only the core forms and intrinsics (see `../bytecode-rvm/README.md`); everything Scheme adds is here:

1. **Intrinsics.** Every builtin procedure (`intrinsics.ts`) is registered on the instance as the leaf intrinsic `%name`, always first and in the same order, so the cached prelude finds them at the same positions in every instance.
2. **Reserved names.** The surface keywords (`symbols.ts`), the builtins' names and the prelude's exports go into the instance's `Intrinsics.reserved`, so code cannot bind them (`define: cannot bind builtin car`).
3. **Reader and transformer.** `reader.ts` parses source; `transformer/` expands macros and lowers the surface syntax to core forms.
4. **Prelude.** `prelude.ts` defines the procedures behind the builtins' names and the rest of the standard library. It is compiled once for all instances and implementations, kept unbound, and each instance runs its own copy bound to its intrinsics by name.

The instance's intrinsics stay open, so a host can add its own before compiling code that uses them:

```ts
const anima = createScheme(implAot)
anima.registerIntrinsic("%lua-index", fn, { args: [2, 2], leaf: true, inline, deps: { Table } })
anima.compileRaw("(%lua-index t 1)")
anima.freeze() // optional: no more registrations
```

## Surface syntax

Each surface form lowers to a core form:

| Surface syntax | Core form |
|---|---|
| `begin` | `(%begin <expr> ...)` |
| `if` (exactly 3 arguments) | `(%if <cond> <then> <else>)` |
| `cond` | one flat `(%if <c1> <e1> <c2> <e2> ... [<else>])`, however many clauses |
| `quote`, `'datum` | `(%quote <datum>)` |
| `lambda` | `(%lambda <params> <body> ...)` |
| `let`, `let*` (nested), `letrec` (void inits then `%set!`), and any immediately applied lambda `((lambda (p ...) body) arg ...)` | `(%let ((<symbol> <init>) ...) <body> ...)` |
| `receive`, `let-values`, `let*-values` (nested) | `(%let-values/strict ((<formals> <expr>) ...) <body> ...)` |
| `set!` | `(%set! <symbol> <expr>)` |
| `with-continuation-mark` | `(%with-mark <key> <value> <body>)` |
| `try`, `try-catch`, `pcall`, Luau `pcall`/`xpcall` | `(%catch <thunk> <handler> [<pre>])` |
| `define` at top level (after `(define (f ...) ...)` becomes a lambda) | `(%define-global <symbol> <expr>)` |

Internal `define`s in a body become a `letrec`. `let`, `let*`, `letrec`, named `let`, `cond`, `and`, `or`, `guard`, `receive`, `let-values` and `let*-values` are pure surface syntax built from the core forms (for example `let` becomes `%let`, which binds variables in the current function instead of calling a lambda).

A named `let` whose name is only called in tail position of its body, with the right number of arguments, becomes a loop instead of a procedure: `(%let ((c init) ...) (%block done (%loop (%block next (%let ((v c) ...) (%escape done body'))))))`, where each tail self call in `body'` assigns the hidden carriers `c` and escapes to `next`. The carriers are assigned right before the jump and read right after, so the boxing analysis keeps them in registers, and the parameters are bound fresh every iteration as calls would bind them. The check runs on the expanded body; any other use of the name (as a value, a non-tail call, a call from a nested lambda, `set!`, a wrong argument count) keeps the procedure instead of applying this optimization.

### `%at`
- **Form**: `(%at <file> <line> <col> <expr>)`
- **Semantics**: Evaluates `<expr>`, recording `file:line:col` as its source position. For frontends that generate Anima code (e.g. a transpiler) so errors and tracebacks point at the original source. It is removed by the syntax transformer before macros run, so macros never see it. Positions only attach to forms (lists); a wrapped atom keeps the enclosing form's position.

## Builtins

A builtin is a JS function over a register window (`fn(regs, start, nargs)`), with an argument count range (`SCHEME_BUILTINS` in `intrinsics.ts`; the arithmetic, `c[ad]+r` and predicate functions come from `ops.ts`). Each is reachable two ways:

- **Direct calls.** The transformer rewrites `(name arg ...)` to `(%name arg ...)` (`SCHEME_ALIASES`) when the argument count is in range, so the call compiles to `CALLINT`, and to inline JS in AOT code when the builtin has a template (`INLINES`, whose `deps` give it `Cons`, `Table` and so on). `list` and `values` map to the compiler's own `%list` and `%values`. A call with a count out of range is left as an ordinary call, so it still compiles, and fails only if it runs.
- **As values.** `(map car xs)` uses the prelude's procedure of that name, a wrapper around the intrinsic: `(define ($car a0) (%car a0))` for a fixed count, `(define ($+ . args) (%apply %+ args))` otherwise (`APPLYINT`, which checks the count at run time). A wrong count is reported by the procedure: `cons: expected exactly 2 args, got 1`, or `%- requires at least 1 arguments, got 0`. `list` is `(define ($list . args) args)`, since a rest parameter is already a fresh list, and `values` is `(define ($values . args) (%list->values args))`.

Builtins, like every name the prelude exports, cannot be rebound.

## Standard library

- `apply`: a direct call `(apply proc arg ... lst)` becomes `(%apply proc arg ... lst)`; as a value, it is the prelude procedure `(define $apply (lambda (proc . lst) (%apply-multi proc lst)))`.
- `call/cc` and `call-with-current-continuation` wrap `(%call/cc proc)`; `call/ec`, `call-with-escape-continuation` and `(let/ec k body ...)` wrap `(%call/ec proc)`. `guard` uses `%call/ec`; `try` and `pcall` use `%catch`.
- `coroutine-create coroutine-resume coroutine-yield coroutine-status coroutine-close`: direct calls become the matching `%` form; as values, prelude wrappers around them.
- `values`, `call-with-values`: `(values a b)` is a `MultipleValues` object, `(values x)` is just `x` and `(values)` is zero values. `call-with-values` is a prelude procedure built on `%values->list`, except that a direct call whose producer and consumer are literal lambdas is rewritten to `receive`, binding the values without a list. `receive`, `let-values` (parallel binding) and `let*-values` are macros built on it. Multiple values reaching a single-value context stay a `MultipleValues` object and print as `(values a b)`.
- `dynamic-wind` wraps `(%dynamic-wind before thunk after)`.
- Exceptions (see the exception model in `../bytecode-rvm/README.md`): `raise` / `raise-continuable` are `%raise` (direct calls are rewritten); the prelude keeps procedures of those names for use as values. `try` / `try-catch` are `%catch`, with the catch procedure running after unwinding like Racket's `with-handlers`. `(pcall f arg ...)` evaluates `f` and the arguments, then returns `(values #t result ...)` or `(values #f err)` (`%values-cons` prepends to the result values). `guard` escapes with `%call/ec` and re-raises with `raise-continuable` through a full continuation when no clause matches. Luau's `xpcall(f, h)` is `%catch` with `h` as `pre`.

### `debug-frames` / `debug-traceback`
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
