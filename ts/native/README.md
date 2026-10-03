# native-scheme

The VM's core forms (see `bytecode-rvm/README.md`) as a language of its own, with a little sugar. It shares no code with the Scheme front end. Use it for code that works at the level of the VM: Scheme's prelude, the VM's tests, an embedder's wrappers around its intrinsics, and later what other languages lower to.

```ts
import { createNativeScheme, compileNative } from "animalang";

const ns = createNativeScheme(implRvm);   // an instance whose language is native-scheme
ns.registerIntrinsic("%add", (regs, s) => regs[s] + regs[s + 1], { args: [2, 2], leaf: true });
ns.evaluateRaw(ns.compileRaw(`(define (twice x) (%intcall %add x x)) (%call twice 21)`)); // 42

// or on any instance, with its table and its front end's quoted data (Scheme's: lists)
compileNative(scheme, `(define (clamp . args) (%intapply %clamp args))`, "host.ns");
```

## Reading
`readNative(src, file, { datum })` (`reader.ts`) reads text straight into the arrays the compiler takes. It names VM values only:

| Text | Value |
|---|---|
| `( ... )` | an array: a form, or quoted data |
| a name | a symbol (`Symbol.for`) |
| `12`, `-2.5`, `1e3`, `12n` | a number, a bigint |
| `"..."` | a string (escapes `\n \t \r \0 \" \\ \u{41}`) |
| `#t`, `#f`, `#null`, `#void` | `true`, `false`, `null`, `undefined` |
| `'x` | `(%quote x)` |
| `; ...` | a comment, to the end of the line |

Several forms are read as a `%begin` of them, and every list keeps where it was read, so errors and tracebacks point into the text. What a quoted `( ... )` means is up to the instance's front end: `datum` (by default the front end's `FrontEnd.datum`) is called on what each `(%quote x)` quotes, and on nothing else. What cannot be read is a `NativeReadError` (`what`, `at`).

## The language
Every core form, written as stored: `(%lambda (() (x y) #null body ...))`, `(%if c a b)`, `(%block done ...)`. Calls are always explicit, `(%call f x)` and `(%intcall %name x)`; anything else in head position is an error. The sugar (`transformer.ts`), whose names are keywords:

| Form | Is |
|---|---|
| `(lambda formals body ...)` | a `%lambda` of one clause; formals a name (every argument), `(a b)`, or `(a b . rest)` |
| `(define name expr)`, `(define (name . formals) body ...)` | `%define-global`, at the top level only |
| `(let ((x init) ...) body ...)`, `let*`, `letrec` | `%let`, `%let*`, `%letrec` |
| `(named-let name ((x init) ...) body ...)` | a loop, when `name` is only called in tail position with every argument; else a `%letrec` of a procedure |
| `(when c body ...)`, `(unless c body ...)` | `%if` of a `%begin` |
| `(and x ...)`, `(or x ...)` | `%if` chains (only `#f` is false) |

A `named-let` loop binds its parameters fresh every round, from carriers assigned just before the jump to the next, so a continuation or closure made in a round keeps that round's values, as calls would. A malformed sugar form is a `NativeSyntaxError` with where it is.

## Messages
`nativeFormat` (`messages.ts`) words the VM's messages, and shows values as the reader reads them: `(1 2)` an array, `#t`, `#null`, `#void`, `12n`.
