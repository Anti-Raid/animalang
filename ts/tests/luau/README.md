`conformance/` holds some of Luau's own conformance scripts (from luau-lang/luau `tests/conformance`, MIT licensed, see
`LICENSE.txt`), unchanged. `forms.json` is, for each, a hash of the forms the parser makes of it (offsets and which locals
are the same included), which the tests check the parser still makes. They were taken when the parser's trees, the same
but for their shape, matched what Luau's `luau-ast` (0.740) prints of these scripts.
