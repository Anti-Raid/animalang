# Luau parser

`parseLuau(source, { comments, noErrorLimit })` (`parser.ts`) parses Luau (the grammar at luau.org/grammar) into the
tree in `ast.ts` and returns `{ root, errors, lines, lineCount, hotComments, comments }`. The tree is for compiling to
Anima, so it keeps only what the program does at run time. Parsing follows Luau's own lexer and parser
(`Ast/src/Lexer.cpp`, `Parser.cpp` in luau-lang/luau) function for function, so node kinds, locations, precedence, error
messages and error recovery are Luau's:

- **Lexer** (`lexer.ts`, tokens in `tokens.ts`): a cursor over the source, not a stream of token objects: the current
  token is the lexer's own fields, its kind a `Tok` (a numeric enum; `TOK_TEXT` spells each). Names are interned, comments are skipped inside it, and short decimal numbers are
  valued as they are read. Interpolated strings keep a stack of what each open brace is, so `}` knows whether it closes a
  table or returns into the string. `unescapeQuoted`/`unescapeLong` give a string's value.
- **Parser**: recursive descent, expressions by precedence climbing (Luau's priority table), statements by parsing an
  expression first and then telling a call, an assignment and the contextual keywords (`type`, `export`, `continue`,
  `const`) apart. Names are resolved as they are parsed: each binding is a `Local`, and a name expression is `ExprLocal` (the
  very `Local` it refers to) or `ExprGlobal`. What is captured or assigned is left to Anima's own analysis.
- **Errors** are collected, not thrown: an error node (`ExprError`, `StatError`) marks where parsing failed, and
  parsing goes on, up to 100 errors (`noErrorLimit` lifts that). Nesting too deep for the JS stack is one more error rather
  than a crash.
- **Spans** are source offsets on the nodes themselves (`from`, `to`), not location objects. `lines.pos(offset)` gives a line and column. Only comments are kept beside the tree (with
  `comments`); there are no tokens and no CST.
- **Left out of the tree**, though checked as Luau does: types (annotations, generics, type aliases, type functions;
  `x :: T` is an `ExprGroup`, which keeps one value of a call, and `f<<T>>` is `f`), attributes, and what only shows how
  the source was written (semicolons, which of `.`/`:` indexed, a string's quotes, the spans of keywords and parts of a
  node).

Where it differs from Luau:

- **Columns** are UTF-16 code units (as editors count them), not bytes.
- **Locations** are offset pairs, not Luau's `Location` records; `StatFor`'s bounds are `init`, `limit`, `step` (Luau's
  `from`, `to`, `step`), as `from`/`to` are its span. As `f<<T>>` is `f`, a node around it ends before the `<<T>>`.
- **String values** are byte strings, one char per byte (0-255), with characters outside ASCII encoded as UTF-8, as Luau's
  are.
- **Left out**: declaration files (`declare`), and Luau's syntax behind feature flags: `if local`, classes, `export` on
  values, integer literals (`1i`).

Tests (`../../tests/luau.test.ts`) check Luau's first error for 41 broken inputs against what `luau-analyze` reports, and
check the trees of some of Luau's own conformance scripts (`../../tests/luau/`) against `luau-ast`'s.
