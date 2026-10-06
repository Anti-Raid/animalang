# Luau

The Luau front end, in progress: the parser (`syntax/`, see its README), the lowering to the VM's core forms
(`lower.ts`), the operators (`ops.ts`), Luau's table (`table.ts`), the string library (`strlib.ts`, with `matcher.ts`,
`pattern.ts`, `format.ts`), numbers as strings (`number.ts`), buffers (`buffer.ts`), vectors (`vector.ts`) and integers
(`integer.ts`). `createLuau(options, host)` (`index.ts`) makes an instance
whose language is Luau; `host.print` gets each line `print` writes (without it, `console.log` does). A Luau string is
of bytes, one char each, there and in what a chunk returns: `luauText` reads one as UTF-8.

## Lowering
So far: locals, assignment (to locals, globals and table entries, several at once), compound assignment, `do` blocks,
`if`, `while`, `repeat`, numeric `for`, `for ... in`, `break`, `continue`, `return`, functions (`function`,
`local function`, `function a.b:c()`), calls and method calls, several values and `...`, table constructors, indexing,
literals, interpolated strings, if-expressions, and the operators (arithmetic, `..`, comparisons, `and`, `or`, `not`,
`#`). Anything else is a positioned "not supported yet" error. Of the standard library there are `next`, `pairs`,
`ipairs`, `tostring`, `tonumber`, `print`, `error`, `pcall` and `string` (but `pack`, `unpack` and `packsize`); the rest, and
metamethods, come later.

- A chunk is a `%block` that `return` escapes from; each `local` binds the rest of its block (`%let`), and locals are
  the parser's own symbols, so shadowing needs nothing more. Globals live in the instance's `Env`, made with nil
  (`undefined`) as its `unbound` value, so an unassigned global reads as nil.
- Operators are intrinsics (`%luau-add` ... `%luau-unm`, `%luau-concat`) doing what Luau's VM does: numbers, strings
  that read as numbers (coerced as `tonumber` reads them), vectors as `lvmutils.cpp` allows, integers with integers,
  and Luau's errors otherwise (`attempt to perform arithmetic (add) on nil and number`, `attempt to concatenate
  boolean with string`). Their AOT templates compute numbers (and integers) inline, the rest in the slow path. The
  type system's kinds are `number` and `integer`. Metamethods come later.
- Conditions are Luau's truthiness (nil and false are false; the VM's is only false): a condition is
  `%luau-truthy` of its value, except where it is a comparison or built of `and`, `or` and `not`, which branch directly.
  `a and b` and `a or b` as values keep `a` in a temporary. Equality is raw (the same value, or equal vectors); `<` and
  `<=` take two numbers, two strings (by bytes) or two integers, and `a > b` is `b < a`, as Luau compiles it and words
  its errors (`attempt to compare string < number`).
- Loops are a `%block` to break out of around a `%loop`, and the body a `%block` to continue to. A `repeat`'s condition
  sees the body's locals, so it is tested inside them, and a `continue` there tests it too; a `continue` that jumps over
  a local the condition uses is Luau's compile error. A numeric `for` is Luau's `FORNPREP`/`FORNLOOP`: its three values
  are read as numbers once (`invalid 'for' limit (number expected, got nil)`), the loop goes on while
  `step > 0 ? i <= limit : limit <= i` (decided when compiling for a literal step), and each iteration binds a fresh local.
- A function is a `%lambda` clause with the `pad` option: missing arguments are nil and extra ones dropped, as Luau
  calls go. Its body is a `%block` its `return`s escape from; a `local function` is a `%letrec`, so it sees itself.
  Calls are `%call`s; calling what is not a function is `attempt to call a nil value` where the call is, tail call or
  not. Luau has no tail calls, but the VM's are not observable but in tracebacks (and in recursion that never runs out).
- Several values are the VM's (`%values`): a function returns what its `return` lists, nothing (`return`, or the end
  of its body) being no values. A call or `...` gives all its values where it is last in a list (of returned values,
  of arguments, of a `local` or an assignment, which take what they need: `%let-values`), and one value anywhere else
  (`%first-value`, nil if there is none; so do parentheses), which for a call is a call that asks its callee for one
  value, so costs nothing. `return f()` stays a tail call. In `f(a, g())`, `g` is called
  first, and when it gives one value, as most calls do, `f` is called as usual; only several values go through
  `%apply`. A function's `...` is its rest parameter, an array (the chunk's is empty).
- Luau's compiler keeps a function's own locals in registers and uses a register itself as an operand, so when a call
  in an expression assigns a local the expression also reads, which value is read is Luau's compiler's doing; the
  lowering does the same (checked against Luau): a local on the left of an arithmetic or comparison operator, or the
  target of `op=`, is read after the other operand is evaluated; concatenation, arguments and lists of values copy it
  first. With several targets (`compileStatAssign`), a local takes its value as soon as it is computed unless a value
  computed later refers to it, and the other targets, and those locals, are assigned at the end.
- A table constructor is `compileExprTable`'s: a table of the sizes Luau's compiler gives it (`%luau-table`: an array
  slot per positional item, a hash slot per keyed one; keys `[1]`, `[2]`, ... in order go to the array part when there
  are no other `[]` keys; a table of fields only has a slot per distinct name, as its `DUPTABLE` template has), then
  the items in order: a keyed one is stored as an assignment is, so it overwrites a positional one before it and is
  overwritten by one after it; a positional one after a keyed one goes into the array part, grown to hold it if a
  keyed store shrank it (`%luau-seti`, Luau's `SETLIST`), and the last item, when it is a call or `...`, gives all its
  values (`%luau-setlist`).
  An empty constructor bound to a local gets the sizes Luau predicts from the local's assignments (`shapes.ts`, Luau's
  `TableShape.cpp`): a hash slot per field name assigned, an array slot per `t[1]`, `t[2]`, ... in order, or the bound
  of a `for i = 1, k` (`k` up to 16) that assigns `t[i]`. Sizes decide when a table grows, and so `#t` of a table with
  holes.
- `t[k]`, `#v` and stores are `%luau-index`, `%luau-len` and `%luau-setindex` (`luaV_gettable`, `luaV_dolen`,
  `luaV_settable`, without metamethods so far): a table's entry, a string's entry in the string library, a vector's
  component; `attempt to index nil with 'name'` and `attempt to get length
  of a number value` otherwise. Their templates test for a table inline. The kinds are `number`, `integer`, `string`
  and `table`.
- A key that is a string constant (`t.name`, `t["name"]`, a method's name) is Luau's `GETTABLEKS`, `SETTABLEKS` and
  `NAMECALL`: `%luau-field`, `%luau-setfield` and `%luau-method`, which keep, where they are compiled, the slot the
  name was last found in (the VM's per-site state), and look there first (`LuaTable.getfield`, `setfield`): tables
  whose keys came in the same order have a name in the same slot, so a field access is a comparison and a read, with
  no lookup. String constants are the engine's one object per string, so that comparison is of references. A
  constructor of fields only, each name once, is `%luau-record`: a table that shares its keys and their index with
  every table the same constructor makes (a `RecordShape`, Luau's `DUPTABLE` template) until it gets another key.
- `obj:name(args)` is `LOP_NAMECALL`'s order: the object, the arguments, and only then the method is looked up
  (`%luau-method`), so an argument that replaces the method is seen; a missing one is `attempt to call missing method
  'name' of table`.
- A local of the function that is an operand of an index, a store or a method call is its register in Luau, read when
  the operation runs, after the other operands: `t[f()] = g()` stores into what `t` is after both calls. With several
  targets, the objects and keys of indexed targets are evaluated first, and a local that is both assigned and indexed
  by the statement is assigned last. `t[k] op= v` evaluates the object and key once, reads the entry, evaluates `v`,
  then stores.
- `for v1, ..., vn in f, s, c` is Luau's `FORGPREP` and `FORGLOOP`. Once, before the loop (`%luau-for-prep`), it is
  decided how it goes on: when `f` is what `ipairs` returns, over a table from index 0, each round reads the array
  part at the next index and stops at a nil (`LuaTable.arrayAt`); when `f` is `next` (or what `pairs` returns) over a
  table from nil, or `f` is itself a table with no `__call`, each round moves to the next position that has an entry
  (`nextPos`, `keyAt`, `valueAt`: the array part's indexes, then the hash part's slots, as Luau walks its nodes by
  index); otherwise `f(s, c)` is called, asked for as many values as there are variables, the loop stops when the first
  is nil, and that value is the next `c`. Anything else is `attempt to iterate over a number value`. One loop tests
  which it is each round, so the body is there once, and each round binds fresh locals. What a traversal by position
  does when the table gets new keys meanwhile is unspecified in Luau and is not Luau's here; assigning or removing
  entries it has is.
- `next`, `pairs` and `ipairs` are procedures over intrinsics (`%luau-fn-next` ...), made when the instance is
  (`index.ts`): they take any arguments and check them as Luau's do (`invalid argument #1 to 'pairs' (table expected,
  got nil)`, `missing argument #1 to 'ipairs' (table expected)`). Their code is marked as the VM's own, so such an error
  is where the function was called, as Luau reports a C function's, and they are not in tracebacks. The functions
  `pairs` and `ipairs` return are not the global `next` and have no name, as in Luau; `invalid key to 'next'` has no
  position, as in Luau.
- `` `a{x}b` `` is `("a%*b"):format(x)`, as Luau compiles it: `%` in the text doubled, `%*` for each expression (one
  value of it), a string constant among the expressions written into the format. So it calls whatever `string.format`
  is then.
- `tostring`, `tonumber` and `print` are made the same way (`luaB_tostring`, `luaB_tonumber`, `luaB_print`, without
  `__tostring` so far): `tonumber(v)` reads a number or a string as arithmetic does, `tonumber(s, base)` as C's
  `strtoull` does (a number is read as it is written; `base out of range` outside 2 to 36), and `print` hands its line
  (the values tab-separated) to the host.
- `pcall` is a procedure whose body is the call under a catch (`%apply-catching`, so no closure is made for it):
  `true` and the results, or `false` and the error
  (an error of the VM or of the library is its message, with its position). `error` is `%raise`: a string or a number
  at level 1 is raised as the library's own errors are, so it gets the position of the frame it leaves through, which
  is none when `pcall` called `error` itself (`pcall(error, "x")` gives `x`), as in Luau; at level 0, and for any other
  value, the value is raised as it is. A level further up reads the position from the stack (`%current-stack`), which
  differs from Luau's in two ways: a call in tail position leaves no frame here (Luau makes no tail calls), and the
  library's functions are not levels (Luau counts `pcall`, and gives no position at it).
- Luau code is compiled as not re-entrant (`reentrant: false`): Luau has no continuations that run a frame twice
  (a coroutine resumes its one suspended frame), so an assigned local needs a box only when a closure captures it.
- Errors are `LuauError`s (`errors.ts`, the VM's `Msg.Text`), so they get where they happened, and the formatter
  (`messages.ts`) words them as Luau does: `file:line: message`. Syntax errors are `LuauSyntaxError`s, worded alike.

`tests/luau-lower.test.ts` checks it, and with `LUAU` set compares random programs (results, error messages and lines)
with Luau's own.

Where it differs from Luau's compiler, in the sizes a table starts with only:
- Luau knows a constructor's `[k]` key is a number when `k` folds to a constant, which includes locals never assigned;
  the lowering only sees literals and arithmetic on them.
- Luau predicts a hash slot for `t.name = v` but not for `t["name"] = v`; the tree does not tell them apart, so both
  count here.

Luau also resolves `a.b.c` on a global its chunk never assigns when the chunk is loaded (`GETIMPORT`); here it is read
when it runs.

## Tables
`LuaTable` is Luau's table, ported from Luau's `VM/src/ltable.cpp`, so that what a program can see of a table is Luau's:

- **Layout**: an array part for keys `1..sizearray` (holes allowed) and a hash part with Luau's capacity (`2^k`
  slots). Both are sized and grown as Luau sizes them now (`newkeytagged`, `rehash`, `resize`, `computesizes`,
  `adjustasize`: the paths behind `LuauSplitTableLookups`, which its command line runs with), so `#t` (`rawlen`,
  Luau's `getn` with its cached boundary) is Luau's: adding a key that is not an integer never resizes the array part,
  an integer key recounts both parts, and keys moved while resizing never resize again. `t[k] = nil` on a missing key
  still takes a slot, as it takes a node in Luau. A constructor's table is `LuaTable.of` (its first values become the
  array part) and `setlist` (`LOP_SETLIST`, growing the array part as `luaH_resizearray` does). The hash part is full
  when it has as many keys as slots; Luau's fills earlier when keys collide. `getfield` and `setfield` are `rawget`
  and `rawset` of a string key given a cache of the slot it was last in, and `LuaTable.record` makes a table over a
  shared `RecordShape`, copied when the table first adds a key.
- **Short ways in**: reading or storing an index of the array part (`rawget`, `rawset`, `arrayAt`), a field at its
  cached slot (`getfield`, `setfield`) and a step of a traversal (`nextPos`, `keyAt`, `valueAt`) are a few lines
  each, small enough for V8 to inline, that fall through to the full operation for anything else. They look at the
  array part and the keys through second references (`#fastArray`, `#fastKeys`, `#fastVals`) that are empty arrays
  when the table's values (or, for the hash part's values, its keys) are weak, so a weak table takes the full
  operation every time and an ordinary one never asks whether it is weak (asking on every read cost five times the
  read). A weak mode set on a metatable that tables already have is taken up by each at its next full operation.
- **Hash part**: slots in insertion order, with a `Map` from key to slot, instead of Luau's hashed nodes. Luau
  guarantees only that a traversal (`next`) visits keys `1..k` in order, up to the first nil; that order is Luau's,
  and the rest comes in insertion order rather than Luau's hash order.
- **Weak tables**: the metatable's `__mode` (`k`, `v`, `kv`) is read whenever it changes, as Luau reads it at every
  collection. Collectable keys or values (tables, functions, coroutines, other objects; never strings, numbers or
  booleans) are held by `WeakRef`s, and an entry whose key or value was collected is gone. As in Luau, there are no
  ephemerons: a weak key's value is held strongly. The `s` (shrinkable) mode is accepted; tables are not shrunk.
- **Vector keys**: equal vectors (`-0` and `0` alike) are one key, found through a map from their hash to the vector
  first stored; a vector with a NaN component is `table index contains NaN`. Vectors are values, so never weak.
- **Calls**: calling a table calls its metatable's `__call` with the table first (the VM's `TRY_CALL`). The table keeps
  the `__call` it last read, read again only when the metatable changes or has its `__call`, `__mode` or contents
  cleared (a version on the metatable), so a call is a field read.
- **Also**: `freeze` / `frozen` (read-only tables), `clear` (Luau's: sizes kept), `clone` (same entries, sizes and order),
  Luau's errors (`table index is nil`, `table index is NaN`, `attempt to modify a readonly table`, `invalid key to
  'next'`), and the host's `get` / `set` / `has` / `delete` / iteration.

`tests/luau-table.test.ts` checks it against Luau's own results; with `LUAU` set to a Luau binary, it also compares
lengths after every write and traversals (the guaranteed order, the rest as a set) for a thousand random programs.

## Strings
`strlib.ts` is Luau's string library (`lstrlib.cpp`) but `pack`, `unpack` and `packsize`: each function takes its
arguments as an array, checked as `luaL_check*` do (`args.ts`: a number is a string where one is wanted, a numeric
string a number; an integer is the number cut toward zero), and is an intrinsic (`%luau-string-<name>`) under a
procedure in the `string` table, like `pairs`. What it gives is Luau's, the messages too; how it gets there is not:

- A pattern is matched by a JS `RegExp` made of it once and kept (`matcher.ts`; it needs lookbehind, so Safari 16.4):
  classes as explicit ranges of bytes, `-` as `*?`, `%f[set]` as a lookbehind and a lookahead, `%1` as `\1`, `()` as
  an empty group whose position is asked for. A RegExp backtracks in the order Luau's matcher does, so it finds the
  same match. `pattern.ts` is a port of Luau's matcher, used for what a RegExp cannot say or would say differently:
  `%b`, a malformed pattern (Luau finds it so only when matching reaches the bad part), a reference to a capture that
  is open or a position, and a pattern long enough that Luau might call it too complex.
- `gsub` with a function calls it through the VM (`hostCall`) and goes on when it returns; with a string that has no
  `%`, it is JS's `replace` (which goes on after an empty match as Luau does). `gmatch` gives a closure over where the
  last match ended.
- `format` (`format.ts`) writes numbers as C's `printf` does: exact digits, a tie rounded to even (JS's `toFixed`
  rounds one up, so it is used only where there is no tie), `%d` of 64 bits, `inf` and `nan` (without a sign, as the
  C library Luau is checked against writes it). A format is parsed once and kept.
- `upper` and `lower` change the 26 letters only; `rep` refuses a result over 2^30 bytes.

`tests/luau-string.test.ts` checks the RegExp against the port on 24,000 random cases; with `LUAU` set, it compares
12,000 random calls (patterns, formats, argument checks) and the error cases with Luau's results.

## Numbers as strings
`num2str` is Luau's `tostring` of a number (`lnumprint.cpp`): the shortest digits that read back, fixed notation when
the decimal point falls between 5 places left of the digits and 21 places right of the first one, else `1e+21`-style
with at least two exponent digits; `-0`, `inf`, `-inf`, `nan`. `str2number` is `luaO_str2d` (what `tonumber` and
arithmetic on strings use): C's `strtod` grammar, so hex (`0x10`, hex floats `0x1p4`, rounded exactly), `inf`,
`nan`, `.5`, `5.` and surrounding space, and nothing after a `"\0"`. `str2integer` is `tonumber(s, base)` for other
bases (`strtoull`: a negative wraps around 2^64).

## Buffers
`LuaBuffer` is Luau's buffer (`lbuflib.cpp`): little-endian reads and writes of every width, strings, `copyFrom`
(`buffer.copy`), `fill`, `readbits` / `writebits`, with Luau's errors. Numbers are cast as Luau's C casts them on
arm64 (saturating, NaN being 0; an unsigned through int64, so `1e30` writes `0xffffffff`). Checking an argument's type
is the caller's. `readinteger` / `writeinteger` read and write integers (see below).

## Vectors
`LuaVector` is Luau's 3-wide vector: three float32 components, the arithmetic of `lvmutils.cpp` (`v+v`, `v-v`, `-v`,
and `*`, `/`, `//` between vectors or a vector and a number) and the `vector` library, computed in float32 in the
order Luau's source writes them, which is what x86-64 builds give. Luau's arm64 builds fuse the multiply-adds of
`magnitude`, `normalize`, `cross`, `dot`, `angle` and `lerp`, so they can differ there in the last bit.

## Integers
Luau's `integer` (`lintlib.cpp`) is a JS bigint kept in the signed 64-bit range: `typeof` tells it from a number,
`===` and `Map` keys (so table keys) compare it by value, and every result is wrapped back with `BigInt.asIntN(64, ...)`,
which V8 compiles to native 64-bit arithmetic. `integer` in `integer.ts` is the library, all of it, with Luau's errors
(`division by zero`, `integer overflow`, ...); `fromstring` reads as Luau's `strtoll` / `strtoull` do (saturating in
base 10, wrapping otherwise). Integers never mix with numbers, as in Luau.

**Deviation from Luau**: every operator works on two integers (Luau allows only `==` on them and gives `attempt to
perform arithmetic (add) on integer`), giving an integer, as the library's functions do:

- `+`, `-`, `*`, unary `-`: `integer.add`, `sub`, `mul`, `neg`, wrapping around 64 bits.
- `/`: `integer.div`, dividing truncated (`-7i / 2i` is `-3i`); `//` and `%`: `integer.idiv` and `mod`, floored. Each
  gives `division by zero` and `integer overflow` as its function does.
- `^`: `ipow` (`integer.ts`; Luau's library has no power), wrapping; with a negative exponent it is the truncated
  `1 / a^-b` (`0i` but for `1i` and `-1i`, `division by zero` for `0i`).
- `<`, `<=`, `>`, `>=`: signed, as `integer.lt` and so on.
- `..`: an integer is written as `tostring` writes it (signed decimal).

An integer with a number is still Luau's error, for every operator.

The tests (`tests/luau-{number,buffer,vector,integer}.test.ts`) check them against Luau's own results, and with `LUAU` set,
against thousands of random cases run by Luau.
