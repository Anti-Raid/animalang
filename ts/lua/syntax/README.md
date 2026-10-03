# Luau parser

`parseLuau(source, { comments, noErrorLimit })` (`parser.ts`) parses Luau (the grammar at luau.org/grammar) and returns
`{ root, errors, lines, lineCount, hotComments, comments }`. The tree is for compiling to Anima, so it keeps only what the
program does at run time, as prefix forms (`ast.ts`): `x = 1 + 2 * 3` is `(assign [(global "x")] [(+ 1 (* 2 3))])`.
Parsing follows Luau's own lexer and parser (`Ast/src/Lexer.cpp`, `Parser.cpp` in luau-lang/luau) function for function,
so precedence, error messages and their locations, and error recovery are Luau's:

- **Lexer** (`lexer.ts`, tokens in `tokens.ts`): a cursor over the source, not a stream of token objects: the current
  token is the lexer's own fields, its kind a `Tok` (a numeric enum; `TOK_TEXT` spells each). Names are interned, comments
  are skipped inside it, and short decimal numbers are valued as they are read. Interpolated strings keep a stack of what
  each open brace is, so `}` knows whether it closes a table or returns into the string. `unescapeQuoted`/`unescapeLong`
  give a string's value.
- **Parser**: recursive descent, expressions by precedence climbing (Luau's priority table), statements by parsing an
  expression first and then telling a call, an assignment and the contextual keywords (`type`, `export`, `continue`,
  `const`) apart.
- **Forms** are arrays `[HEAD, ...operands, offset]`: `HEAD` is one of `L`'s symbols, and the last element is always where
  the form starts in the source (`lines.pos(offset)` gives a line and column). Constants are themselves (numbers, byte
  strings, booleans, `L.NIL`); lists (of locals, of values) are plain arrays, told from forms by `isForm`. `print.ts`'s
  `show` writes a form as an s-expression.
- **Names** are resolved as they are parsed: each declaration makes a symbol, and a use of the local is that symbol
  itself, so two locals of one name are two symbols; a global is `(global "name")`. What is captured or assigned is left
  to Anima's own analysis.
- **Errors** are collected, not thrown: an `(error)` form marks where parsing failed, and parsing goes on, up to 100 errors
  (`noErrorLimit` lifts that). Nesting too deep for the JS stack is one more error rather than a crash.
- **Left out of the tree**, though checked as Luau does: types (annotations, generics, type aliases, type functions;
  `x :: T` is `(one x)`, which keeps one value of a call as `(x)` does, and `f<<T>>` is `f`), attributes, and what only
  shows how the source was written (semicolons, a string's quotes, keywords). Only comments are kept beside the tree
  (with `comments`).

Where it differs from Luau:

- **Columns** are UTF-16 code units (as editors count them), not bytes.
- **Locations** are where each form starts, not Luau's `Location` records; an error's is a span (`from`, `to`).
- **String values** are byte strings, one char per byte (0-255), with characters outside ASCII encoded as UTF-8, as Luau's
  are.
- **Left out**: declaration files (`declare`), and Luau's syntax behind feature flags: `if local`, classes, `export` on
  values, integer literals (`1i`).

Tests (`../../tests/luau.test.ts`) check Luau's first error for 42 broken inputs against what `luau-analyze` reports, and
check the forms of some of Luau's own conformance scripts (`../../tests/luau/`) against a record of them.
