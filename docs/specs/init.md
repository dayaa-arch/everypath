# スキルと everypath init

## 目的
開発者が対象リポジトリで `npx everypath init` を 1 回叩くと、設定と性質の雛形、Claude Code 用のスキル、hooks の例、`.gitignore` の追記がそろい、AI エージェントが `@state-*` を書き始められる。npm で入れた人は `README.md` だけで serve まで辿り着ける。保守する人は、配る雛形が `templates/init/` と `skill/` の 2 か所にあり、`init` はそれを写すだけだと覚えればよい。
満たす: R-01（`init` が書くのは決まった雛形だけで、既存のファイルを上書きしない）、R-02（`dependencies` は空のまま）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [x] 2. 空のディレクトリに `everypath init <dir>` を実行すると、`everypath.config.json`、`everypath.properties.json`、`.claude/skills/everypath/SKILL.md`、`.claude/settings.example.json`、`.gitignore` の 5 つだけができ、それ以外のパスは作られない（`test/init.test.ts`）
- [x] 3. 2 回目の実行はどのファイルのバイトも変えない。既存のファイルは上書きせず、作ったものと飛ばしたものを日本語で 1 行ずつ出す。既存の `.gitignore` には `.everypath/*` と `!.everypath/review.json` を、無い行だけ末尾に足し、元の内容を保つ（決定 0003）（`test/init.test.ts`）
- [x] 4. 雛形の `everypath.properties.json` は `parseProperties` で警告なしに読め、`everypath.config.json` は `parseConfig` で読め、`settings.example.json` は `PostToolUse` に `npx everypath scan --quiet` の hook を持つ JSON である（`test/init.test.ts`）
- [x] 5. `skill/SKILL.md` は `SPEC.md` §14.1 の 11 項目をすべて日本語で書き、各項目に理由を添える。frontmatter の `name` は `everypath`。§5.2 の記法例を含み、例のアノテーションは `everypath scan` で警告なしに読める（`test/init.test.ts` が例を抜き出してスキャンする）
- [x] 6. `README.md`（日本語）が、インストール、`init`、`serve`、`check`、`check --tlc`、`tla install`、アノテーションの最小例、サンプル `example/` の動かし方を書く。書いたコマンドはすべて実在する（`test/init.test.ts` が README のコードブロックの `everypath <cmd>` を `--help` の一覧と照合する）
- [x] 7. `npm pack` した tarball に `dist/`、`skill/`、`templates/`、`README.md` が入り、空のディレクトリにその tarball を入れて `npx everypath init .` が条件 2 の 5 つを作る（手で 1 回実行し、出力を残す）

## データの形
```ts
// src/core/init.ts。init の判断はこれだけ。CLI はこの結果を表示するだけ
type InitFile = { path: string; source: { kind: "template"; file: string } | { kind: "gitignore"; lines: readonly string[] } };
type InitAction = { path: string; kind: "created" | "skipped" | "appended" };
declare function initRepository(root: string, packageRoot: string): Promise<readonly InitAction[]>;
```
表し方: 配るファイルを 1 つの表（`InitFile[]`）にし、`initRepository` がその表を順に処理する。理由: 雛形を足すときに表の 1 行だけを直せばよく、テストも同じ表から期待値を作れるため。

実装で決めたこと。
- テストの期待値は表から作らず、条件 2 の 5 つのパスをそのまま書く。表に 6 つ目を足すとテストが落ち、この仕様を直すまで通らない。表（`INIT_FILES`）は公開しない。
- 雛形は `COPYFILE_EXCL` で写し、既にあれば飛ばす。`.gitignore` は行末の空白と `\r` を除いて比べる。git も行末の空白を無視するため。
- `init.ts` を `test/single-writer.test.ts` が書き込みを許す 3 つ目のファイルにした。R-01 が `.everypath/` と並べて `init` の雛形を挙げているため。
- 性質の雛形は `{"properties": []}`。性質は人間が承認するレビュー対象で、どのリポジトリでも成り立つ性質は無いため。設定の雛形は `aliases`、`includeTests`、`ignore` の既定値だけを持つ。`findings` は `null` だと警告になるので入れない。
- 出力は標準出力に 1 ファイル 1 行で、「を作りました」「は既にあるので飛ばしました」「に足りない行を足しました」。対象のディレクトリが無ければ、ほかのコマンドと同じく exit 2 で何も作らない。
- `skill/SKILL.md` には §14.1 の 11 項目に加えて、タグの表、ガードと代入の文法、`check` の出力の読み方、性質の `kind` の表を入れた。対象リポジトリには `SPEC.md` が無く、エージェントが読めるのはスキルだけのため。
- README のサンプルは clone して `node dist/cli.js` で動かす。`example/` は npm のパッケージに入らないため。

残る端（直さない）。既存の `.gitignore` に `.everypath/` の行があると、git はその下のファイルを `!` で戻せないので、`review.json` は無視されたままになる。`init` は元の行を消さず、警告も出さない。写している途中で落ちると半端なファイルが残り、次の実行はそれを飛ばす。

## 非目標
- `/everypath-fix` スラッシュコマンド（`SPEC.md` §14.2。任意のため後回し）
- 対話での質問（決定 0003 で `.gitignore` の扱いは決め済み）
- `src/server/`、`src/ui/`、`templates/prompts/` の変更（別のブランチ `feat/viewer-panels` が作業中）

## 検証方法
`test/init.test.ts`（一時ディレクトリへの実行、冪等性、雛形の妥当性、SKILL.md の例のスキャン、README のコマンド照合）。条件 7 は手で確認する。作る。
