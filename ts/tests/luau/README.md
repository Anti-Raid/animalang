`conformance/` holds some of Luau's own conformance scripts (from luau-lang/luau `tests/conformance`, MIT licensed, see
`LICENSE.txt`), unchanged. `luau-ast.json` is, for each, the number of nodes Luau's `luau-ast` (0.740) prints and a hash of
their sorted `type@location` pairs, which the parser's tests check its own trees against.
