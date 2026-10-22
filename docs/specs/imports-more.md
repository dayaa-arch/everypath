# Go・Rust・Java・Kotlin の import 解決

## 目的
Go、Rust、Java、Kotlin のリポジトリでも、`everypath scan` が import からファイル間の依存を読み、`graph.json` の dep とテスト済みの印が JS/TS、Python と同じように付く。利用者は、これらの言語で `@state-next` だけを頼りにせず、点線の依存と「未テスト」の色で全体を見られる。保守する人は、言語ごとの解決が `src/core/imports*.ts` の 1 言語 1 ファイルに分かれ、`resolveImports` の表に拡張子で引かれると覚えればよい。
満たす: R-01（読むのは `go.mod` と `Cargo.toml` だけで、書くのは `.everypath/` のまま）、R-05（1,000 ファイルの再スキャンが遅くならない）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. Go の解決。`go.mod` はルートと入れ子の全部を読み、`module` 行のパスとその置き場所を 1 つのモジュールとする。`import "m/p"`、`import ( … )`、別名・`_`・`.` 付きは、パスに一致するか `/` で続くモジュールのうち最長のものに当て、残りをディレクトリとして、そこにある `_test.go` 以外の `.go` 全部へ解決する。標準ライブラリ、第三者のパス、`go.mod` の無いリポジトリ、別の `go.mod` が入るディレクトリ以下（親モジュールのパッケージではない）、同じパスを 2 つの `go.mod` が名乗るモジュールは何も記録しない（`test/imports-go.test.ts`）
- [ ] 3. Go のテスト。`_test.go` はテストファイルで、import 先のパッケージの全ファイルと、同じディレクトリの `_test.go` 以外の全ファイルをテスト済みにする。ノードの `tested` は全ファイルがテスト済みのときだけ true（同上）
- [ ] 4. Rust の `mod`。`mod foo;` は宣言したファイルの隣の `foo.rs` か `foo/mod.rs` に解決する。`lib.rs`・`main.rs`・`mod.rs`・クレートの根（`src/bin/*.rs` など）は同じディレクトリを、それ以外の `bar.rs` は `bar/` を探す。`mod a { mod b; }` の入れ子は `a/b.rs`。`#[path = "文字列"]` は入れ子の外の `mod` だけ、宣言ファイルのディレクトリからの相対で解決し、入れ子の中は何も記録しない。2 つの候補が両方ある場合も何も記録しない（`test/imports-rust.test.ts`）
- [ ] 5. Rust の `use`。`crate::`、`self::`、`super::`（連続可）、`{ }`・`as`・`*` の入れ子を展開し、パスをたどれる一番深いモジュールのファイルに解決する。先頭が名前のとき、そのファイルが `mod 名前;` を宣言していれば `self::` と同じに、`Cargo.toml` の `[package] name`（`-` は `_`）か `[lib] name` と一致すれば、そのクレートの `src/lib.rs` から解決する。`std`・`core`・`alloc`・外部クレート、`src/lib.rs` と `src/main.rs` が並ぶときの `crate::項目`（どちらの根か決まらない）は何も記録しない。`tests/`・`examples/`・`benches/` の `use 自分のクレート名::…` と、`tests.rs` の `use super::*` がテスト済みの印になる（同上）
- [ ] 6. Java と Kotlin。`src/main/java`、`src/main/kotlin`、`src/test/java`、`src/test/kotlin`（`app/src/…` のような入れ子のモジュールを含む）とリポジトリのルートをソースルートとする。`import a.b.C;`（Kotlin は `;` と `as 別名` も）は `a/b/C.java` か `.kt` に、`import static`、入れ子クラス、静的メンバーは一番長く一致するクラスのファイルに解決する。`a.b.*` は `a/b/` 直下の全ファイル（サブパッケージは含まない）、`a.b.C.*` は C のファイルに解決する。自分のモジュールのルートを先に探し、無ければ他のモジュールを探す。同じ段で 2 つ以上のファイルに当たれば何も記録しない。`src/main` のファイルは `src/test` のルートを見ない。同じパッケージの参照と Kotlin のトップレベル関数の import は解決しない（`test/imports-jvm.test.ts`）
- [ ] 7. コメントと文字列。3 言語それぞれで、行コメント、ブロックコメント（Rust と Kotlin は入れ子）、ドキュメントコメント、文字列、Rust の生文字列、Java のテキストブロック、Go の import グループ内のコメントに書かれた import と `mod` は、実在のファイルを指していても依存を作らない。Rust のライフタイム、文字リテラルの `'{'`、`"` を含む生文字列の後ろの宣言は読める（3 つのテストファイル）
- [ ] 8. 推測しない。解決できない import、曖昧な import、壊れたファイル（各言語の正しいソースを 1 文字ずつ削った 200 通り以上）は、例外も警告も出さず何も記録せず、`scan` は exit 0 になる（`test/imports-scan.test.ts`）
- [ ] 9. 速度。各言語 1,000 ファイルの fixture で、温めた `scan` 3 回のうち最短の CPU 時間が 1 秒未満で、依存の数が期待どおり（`test/imports-scan.test.ts`。壁時計の時間は返答に書く）
- [ ] 10. fixture。`test/fixtures/imports-go`・`imports-rust`・`imports-jvm` の小さな木を `analyze` した依存の集合が期待と一致する。一時ディレクトリに作る Go モジュール、Cargo のワークスペース、Gradle 形式の木では、`scan` の `graph.json` の dep とテスト済みの印が期待と一致する（`test/imports-scan.test.ts`）
- [ ] 11. R-01 と監視。3 言語の木を `scan` した前後で `.everypath/` 以外の全ファイルの hash が一致する。`isScanInput` は `go.mod`・`Cargo.toml` を入力と数え、`node_modules` の下の同名は数えない（同上）
- [ ] 12. 文書。`SPEC.md` §8 手順 4 の Go/Rust/Java/Kotlin の行と README の対応言語の説明が、この仕様と食い違わない（目視と `git diff`）

## データの形
```ts
// src/core/imports.ts
type Manifest = { readonly path: string; readonly text: string }; // go.mod と Cargo.toml だけ。workspace.ts が読む
type ImportContext = { files; aliases; go: GoModules; rust: RustCrates; jvm: JvmRoots }; // files と manifests から 1 回だけ作る
declare function importContext(input: { files: readonly string[]; aliases: …; manifests: readonly Manifest[] }): ImportContext;
declare function resolveImports(path: string, content: string, context: ImportContext): string[]; // 署名は変えない
// 拡張子 → 解決関数の表。.go → imports-go.ts、.rs → imports-rust.ts、.java .kt → imports-jvm.ts
```
表し方: 言語ごとに「索引（`files` と manifest から 1 回作る）」と「ファイル 1 つの解決（純粋）」の 2 つ組を持たせ、拡張子の表で引く。理由: 言語を足すたびに `resolveImports` の if 連鎖を伸ばさず、索引の持ち方（Go はモジュールの表、Rust はクレートの表、JVM はソースルートの表）を言語の中に閉じ込められる。

## 決めたこと
- 曖昧なら何も記録する。ファイルが 2 つ当たる、根が決まらない、モジュールが重複する、のどれでも推測で 1 つを選ばない。
- Go は `go.work` と `replace` を読まない。リポジトリ内の全 `go.mod` のパスで引くので、`replace` で結んだ入れ子のモジュールもパスが一致すれば解決する。ビルドタグ（`//go:build`）は見ず、ディレクトリの全 `.go` を対象にする。
- Rust のクレートの根は Cargo の規約（`src/lib.rs`、`src/main.rs`、`src/bin/`、`tests/`、`examples/`、`benches/`）だけを認め、`Cargo.toml` の `path =` と、依存の `package =` による改名は読まない。別のファイルで宣言した入れ子のモジュール（`a.rs` の `mod inner { mod deep; }`）の先は、`a.rs` までを記録する。
- Java と Kotlin はディレクトリとファイル名で引く。`package` 宣言は読まない。`src/` 直下だけを根にする Eclipse 形式、`src/androidTest` などの別のソースセット、同じパッケージの暗黙の参照（JUnit の `FooTest` が同じパッケージの `Foo` を import なしで使う場合）は対象外で、テスト済みにならない。
- JS/TS と Python の解決は変えない（コメント内の import を拾う現状のまま）。テストファイルの判定（`TEST_PATH`）も変えない。

## 非目標
- `go.work`、`replace`、ビルドタグ、`Cargo.toml` の `path =` と依存の改名、Gradle・Maven の設定ファイルの読み取り
- Ruby の `require_relative`、Kotlin のトップレベル関数・拡張関数、Java のクラスパス上の第三者ライブラリ
- 型や関数の単位の参照（import されたシンボルが実際に使われているかの検査）

## 検証方法
`test/imports-go.test.ts`、`test/imports-rust.test.ts`、`test/imports-jvm.test.ts`、`test/imports-scan.test.ts` を実装より先に作り、赤を確かめてからコミットする。木は一時ディレクトリに書き、小さな固定の木は `test/fixtures/imports-*` に置く。
