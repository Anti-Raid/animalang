# Luau

The Luau front end, in progress: the parser (`syntax/`, see its README), Luau's table (`table.ts`), numbers as strings
(`number.ts`), buffers (`buffer.ts`) and vectors (`vector.ts`). The lowering to the VM's core forms comes next.

## Tables
`LuaTable` is Luau's table, ported from Luau's `VM/src/ltable.cpp`, so that what a program can see of a table is Luau's:

- **Layout**: an array part for keys `1..sizearray` (holes allowed) and a hash part with Luau's capacity (`2^k`
  slots). Both are sized and grown as Luau sizes them (`rehash`, `computesizes`, `adjustasize`; the paths Luau uses by
  default), so `#t` (`rawlen`, Luau's `getn` with its cached boundary) is Luau's. `t[k] = nil` on a missing key still
  takes a slot, as it takes a node in Luau.
- **Hash part**: slots in insertion order, with a `Map` from key to slot, instead of Luau's hashed nodes. Luau
  guarantees only that a traversal (`next`) visits keys `1..k` in order, up to the first nil; that order is Luau's,
  and the rest comes in insertion order rather than Luau's hash order.
- **Weak tables**: the metatable's `__mode` (`k`, `v`, `kv`) is read whenever it changes, as Luau reads it at every
  collection. Collectable keys or values (tables, functions, coroutines, other objects; never strings, numbers or
  booleans) are held by `WeakRef`s, and an entry whose key or value was collected is gone. As in Luau, there are no
  ephemerons: a weak key's value is held strongly. The `s` (shrinkable) mode is accepted; tables are not shrunk.
- **Vector keys**: equal vectors (`-0` and `0` alike) are one key, found through a map from their hash to the vector
  first stored; a vector with a NaN component is `table index contains NaN`. Vectors are values, so never weak.
- **Also**: `freeze` / `frozen` (read-only tables), `clear` (Luau's: sizes kept), `clone` (same entries, sizes and order),
  Luau's errors (`table index is nil`, `table index is NaN`, `attempt to modify a readonly table`, `invalid key to
  'next'`), and the host's `get` / `set` / `has` / `delete` / iteration.

`tests/luau-table.test.ts` checks it against Luau's own results; with `LUAU` set to a Luau binary, it also compares
lengths after every write and traversals (the guaranteed order, the rest as a set) for a thousand random programs.

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
is the caller's. `readinteger` / `writeinteger` are behind a Luau flag and left out.

## Vectors
`LuaVector` is Luau's 3-wide vector: three float32 components, the arithmetic of `lvmutils.cpp` (`v+v`, `v-v`, `-v`,
and `*`, `/`, `//` between vectors or a vector and a number) and the `vector` library, computed in float32 in the
order Luau's source writes them, which is what x86-64 builds give. Luau's arm64 builds fuse the multiply-adds of
`magnitude`, `normalize`, `cross`, `dot`, `angle` and `lerp`, so they can differ there in the last bit.

The tests (`tests/luau-{number,buffer,vector}.test.ts`) check them against Luau's own results, and with `LUAU` set,
against thousands of random cases run by Luau.
