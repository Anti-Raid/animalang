# native-scheme

A language for writing preludes and wrappers: the VM's core forms (see `../magicvm/README.md`) with Scheme's everyday syntax on top. It shares no code with the Scheme front end. Scheme's own prelude is written in it, and so are the procedures an embedder defines around its intrinsics. Transpilers do not use it: they build core forms (arrays) directly.

```ts
import { createScheme, compileNative, implRvm } from "animalang";

const anima = createScheme(implRvm);
anima.registerIntrinsic("%clamp", (regs, s) => Math.min(Math.max(regs[s], regs[s + 1]), regs[s + 2]), { args: [3, 3], leaf: true });
// Scheme code cannot name intrinsics; a procedure defined in native-scheme can call them
anima.evaluateRaw(compileNative(anima, `(define-intrinsic clamp %clamp)`, "host.ns"));
anima.evaluateRaw(anima.compileRaw(`(map (lambda (x) (clamp x 0 10)) '(-5 5 50))`)); // (0 5 10)
```

`compileNative(anima, src, file)` compiles native-scheme on any instance, with that instance's intrinsics and its front end's meaning for quoted data (Scheme's: lists). `createNativeScheme(options)` makes an instance whose own language is native-scheme, for an embedder that wants no Scheme at all.

## Reading
`readNative(src, file, { datum })` (`reader.ts`) reads text straight into arrays, and names VM values only:

| Text | Value |
|---|---|
| `( ... )`, `[ ... ]` | an array: a form, or quoted data (a bracket closes a bracket) |
| `%[f x ...]` | a call: `(%call f x ...)`, or `(%intcall %name x ...)` when the head is a `%` name |
| a name | a symbol (`Symbol.for`) |
| `12`, `-2.5`, `1e3`, `12n` | a number, a bigint |
| `"..."` | a string (escapes `\n \t \r \0 \" \\ \u{41}`) |
| `#t`, `#f`, `#null`, `#void` | `true`, `false`, `null`, `undefined` |
| `'x` | `(%quote x)` |
| `; ...`, `#\| ... \|#`, `#;form` | comments: to the end of the line, a (nestable) block, the next form |

Several forms are read as a `%begin` of them, and every list keeps where it was read, so errors and tracebacks point into the text. `datum` (by default the front end's `FrontEnd.datum`) is called on what each `(%quote x)` quotes, and on nothing else. What cannot be read is a `NativeReadError` (`what`, `at`).

## The language
Every core form, written as stored: `(%lambda (() (x y) #null body ...))`, `(%if c a b)`, `(%block done ...)`. A call is always explicit, `%[f x]` (or `(%call f x)` / `(%intcall %name x)`); a bare `(f x)` is an error. The sugar (`transformer.ts`), whose names are keywords:

| Form | Is |
|---|---|
| `(lambda formals body ...)`, `(case-lambda (formals body ...) ...)` | a `%lambda`; formals a name (every argument), `(a b)`, or `(a b . rest)` |
| `(define-global name expr)`, `(define-global (name . formals) body ...)` | `%define-global`, anywhere (locals are bound with `let` and `letrec`) |
| `(define-intrinsic name %intrinsic)` | a global procedure calling the intrinsic, its parameters from the table: a fixed count, or any count of a leaf, which it applies |
| `(let ((x init) ...) body ...)`, `let*`, `letrec` | `%let`, `%let*`, `%letrec` |
| `(let name ((x init) ...) body ...)` | a loop when `name` is only called in tail position with every argument; else a `%letrec` of a procedure |
| `(let-values ((formals expr) ...) body ...)`, `(receive formals expr body ...)` | `%let-values/strict` |
| `if`, `set!`, `begin`, `not` | `%if`, `%set!`, `%begin`, `(%if x #f #t)` |
| `(cond (test body ...) ... [(else body ...)])` | one flat `%if` chain |
| `(when c body ...)`, `(unless c body ...)`, `(and x ...)`, `(or x ...)` | `%if` (only `#f` is false) |
| `(apply f x ... seq)` | `%apply`, or `%intapply` of a `%` name, spreading `seq` with the table's spread when it has one |

A named `let` loop binds its parameters fresh every round, from carriers assigned just before the jump to the next, so a continuation or closure made in a round keeps that round's values, as calls would. A malformed sugar form is a `NativeSyntaxError` with where it is.

## Messages
`nativeFormat` (`messages.ts`) words the VM's messages on a native-scheme instance, and shows values as the reader reads them: `(1 2)` an array, `#t`, `#null`, `#void`, `12n`.
