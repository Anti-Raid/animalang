# Luau

The Luau front end, in progress: the parser (`syntax/`, see its README) and Luau's table (`table.ts`). The lowering to
the VM's core forms comes next.

## Tables
`LuaTable` is Luau's table, ported from Luau's `VM/src/ltable.cpp`, so that what a program can see of a table is Luau's:

- **Layout**: an array part for keys `1..sizearray` (holes allowed) and a hash part of `2^k` nodes chained with Brent's
  variation. Both are sized and grown as Luau sizes them (`rehash`, `computesizes`, `adjustasize`; the paths Luau uses by
  default), so `#t` (`rawlen`, Luau's `getn` with its cached boundary) and the order of a traversal (`next`, array part
  first, then nodes) are Luau's. `t[k] = nil` on a missing key still takes a node, as in Luau.
- **Hashing**: numbers, strings (`luaS_hash` over the byte string) and booleans hash as in Luau, so their order matches
  Luau's exactly; other values, which Luau hashes by address, hash by an id of their own. A `Map` beside the nodes finds
  keys without hashing them.
- **Weak tables**: the metatable's `__mode` (`k`, `v`, `kv`) is read whenever it changes, as Luau reads it at every
  collection. Collectable keys or values (tables, functions, coroutines, other objects; never strings, numbers or
  booleans) are held by `WeakRef`s, and an entry whose key or value was collected is gone. As in Luau, there are no
  ephemerons: a weak key's value is held strongly. The `s` (shrinkable) mode is accepted; tables are not shrunk.
- **Also**: `freeze` / `frozen` (read-only tables), `clear` (Luau's: sizes kept), `clone` (same entries, sizes and order),
  Luau's errors (`table index is nil`, `table index is NaN`, `attempt to modify a readonly table`, `invalid key to
  'next'`), and the host's `get` / `set` / `has` / `delete` / iteration.

`tests/luau-table.test.ts` checks it against Luau's own results; with `LUAU` set to a Luau binary, it also compares
lengths after every write and traversal orders for a thousand random programs.
