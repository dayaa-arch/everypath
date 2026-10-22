# ビューアのパネル（未レビュー一覧、変更ログ、指示生成、モデルタブ）

## 目的
レビューが追いつかない開発者が、未レビュー一覧から次に見る箱へ飛び、変更ログで何が増えたかを追い、選んだ箱（Shift+クリックで複数）の文脈を指示文としてクリップボードに入れ、エージェントに貼れるようになる。モデルタブでは、その箱に関わる TLA+ の定義を生成コメントつきで読める。保守する人は、パネルの状態も既存の 1 つの reducer にあり、指示文は `templates/prompts/*.md` を純関数で埋めるだけだと覚えればよい。
満たす: R-01（ビューアは `.everypath/` 以外を書かない）、R-02（`dist/ui.html` は単一ファイルでネットワーク参照なし）、R-03（指示生成は Java が無くても動く）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` がすべて exit 0。`dist/ui.html` は 1 ファイルで、`scripts/verify-requirements.ts` の R-02 が ok（実行して確認）
- [ ] 2. `fillTemplate` は `{{NAME}}` を値で置き換える。`{{#NAME}}…{{/NAME}}` は、値が配列なら要素ごとに中身を繰り返し、文字列なら空でないときだけ 1 回出す。`{{^NAME}}…{{/NAME}}` は空のときだけ出す。行に区間の印だけがあるときは、その行の改行も消す。`<!-- -->` は消す。知らない変数はそのまま残す。3 行以上続く改行は 2 行にする（`test/prompts.test.ts`）
- [ ] 3. `templates/prompts/` に `PROMPT_KINDS` の 5 種類すべての `.md` があり、example のグラフで埋めると `{{` が 1 つも残らない（`test/prompts.test.ts`）
- [ ] 4. example のグラフに TLC の反例（48 状態、ログイン → パスワードリセット → Home）を入れ、ログインと Home を承認済みにして「反例を直す」を作ると、`SPEC.md` §13 の例と同じ要素が入る。ファイル名と機能名、違反した性質の説明と id、探索した状態数、3 歩の反例（各行に状態、`on:` のイベント、`authed=FALSE retries=0`、最後の行に「← ここで違反」）、`@state-risk`、`@state-spec`、完了条件の `everypath check --tlc`、「ログイン・Home は承認済み」（`test/ui-prompt.test.ts`）
- [ ] 5. 未テストの 3 ノードとテスト済みの 1 ノードを選んで「テストを書く」を作ると、3 ノードのファイルが並び、テスト済みのノードは入らない。どの種類が何ノードに当たるかを `promptTargets` が返し、当たるノードが 0 の種類は作れない（`test/ui-prompt.test.ts`）
- [ ] 6. `GET /templates.json` は 5 種類すべてを `source: "default"` で返す。`.everypath/templates/write-tests.md` を置くとその種類だけ中身が変わり `source: "override"` になる。種類にない名前のファイルは無視する（`test/server.test.ts`）
- [ ] 7. reducer は次を満たす。Shift つきの選択で `many` になり、1 つまで減ると `node` に戻る。`history` は `at` と `reason` と中身が同じ項目を 1 つにまとめ、古い順で最新 200 件を持つ。差分つきの `graph` イベントはその差分を足す。`generate` は今の選択と `templates` から指示文を作って持ち、選択が変わると消える。`templates` が null なら何も変えない（`test/ui-state.test.ts`）
- [ ] 8. `modelSlice` は example から生成した `Model.tla` について、ログインなら `Init`、出ていく 5 本、入ってくる 3 本を返し、Home なら `no-unauth-home` の性質の定義も返す。`Model.tla` に無い状態なら null を返す（`test/ui-model.test.ts`、`src/core/tla/generate.ts` の出力で確かめる）
- [ ] 9. example を `relayout` で置いたとき、flow エッジのラベルの矩形どうしが重ならず、箱とも重ならない（`test/ui-view.test.ts`）
- [ ] 10. 実物のブラウザで `npx tsx src/cli.ts serve example` を開く。未レビュー一覧が色の優先順に並び、行を押すとその箱が選ばれて画面の中央に来る。example に `@state 設定` のファイルを足すと変更ログに「+ 設定」の行が増える。全探索の後、パスワードリセットで「反例を直す」を押すと §13 相当の文面がクリップボードに入る。Shift+クリックで 2 つ選ぶと「まとめて生成」ができる。モデルタブにその箱のアクションが出て、「このモデルを説明させる」でクリップボードに入る。`signup_done` と `login_fail [retries==3]` のラベルが重ならない（内蔵ブラウザで確認し、画面写しを残す。足したファイルは後で消す）

## データの形
```ts
// src/core/prompts.ts。DOM も Node も使わない。サーバーとビューアが共有する
export const PROMPT_KINDS = ["fix-counterexample", "write-tests", "draw-model", "propose-properties", "explain-model"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];
export type PromptTemplates = Readonly<Record<PromptKind, { readonly text: string; readonly source: "default" | "override" }>>;
export type Scope = { readonly [name: string]: string | readonly Scope[] };
export declare function fillTemplate(template: string, scope: Scope): string;

// src/ui/prompt.ts。純関数
export type Prompt = { readonly kind: PromptKind; readonly targets: readonly StateName[]; readonly text: string };
export declare function promptTargets(kind: PromptKind, graph: Graph, ids: readonly StateName[]): readonly StateName[];
export declare function buildPrompt(kind: PromptKind, state: ViewState): Prompt | null;

// src/ui/model.ts。純関数
export type ModelBlock = { readonly kind: "init" | "out" | "in" | "property"; readonly text: string };
export declare function modelSlice(tla: string, id: StateName): { readonly ident: string; readonly blocks: readonly ModelBlock[] } | null;

// src/ui/state.ts への追加
type Selection = … | { readonly kind: "many"; readonly ids: readonly [StateName, StateName, ...StateName[]] };
type ModelText = { readonly kind: "unknown" } | { readonly kind: "loaded"; readonly text: string } | { readonly kind: "missing"; readonly message: string };
type ViewState = … & { panelTab: "detail" | "model"; dockTab: "queue" | "log"; history: readonly HistoryEntry[];
  model: ModelText; templates: PromptTemplates | null; prompt: Prompt | null };
type Action = … | { kind: "select"; id: StateName | null; extend: boolean } | { kind: "history"; entries: readonly HistoryEntry[] }
  | { kind: "model"; model: ModelText } | { kind: "templates"; templates: PromptTemplates }
  | { kind: "tab"; panel: "detail" | "model" } | { kind: "tab"; dock: "queue" | "log" } | { kind: "generate"; prompt: PromptKind } | { kind: "dismiss-prompt" };
```
表し方: 指示の種類は `PROMPT_KINDS` の表で、発動条件と見出しも種類ごとの表に置く。選択は判別可能なユニオンに `many` を足す。理由: 種類ごとの条件をパネル、まとめて生成、テストの 3 か所で別々に書くと、出るボタンと作れる指示がずれるため。

決めたこと。
- テンプレートの書式は、1 種類 1 ファイルで、Mustache の小さな部分集合（変数、区間、反転区間）にした。「枠とノードの 2 ファイル」案は上書きするファイルが 2 つになり、「変数だけ」案は複数ノードの繰り返しをコードに持つことになるため捨てた。反例の表と状態数の行はコードが組み立てて `{{VIOLATIONS}}` に入れる。言い回しと完了条件はテンプレートに置く。
- 作る種類は 5 つ。「仕様と証明を書く」（フェーズ 3）と「乖離を直す」（`drift` がまだ無い）は作らない。発動条件は、反例を直すが「今のモデルでの違反がある」、テストを書くが「`!tested` かつ計画のみでない」、モデルを描かせるが「計画のみでなく、出ていく flow が無いか、どれにも `if:` と `set:` が無い」、残り 2 つが「いつでも」。
- 承認済み隣接ノードは、対象と flow でつながるノードと反例の経路上のノードのうち、`reviewed` で対象でないもの。
- サーバーに `GET /templates.json` を足す。ブラウザは `.everypath/templates/` を読めず、上書きを効かせるにはサーバーが読むしかないため。既定のテンプレートは `src/cli.ts` が `dist/ui.html` と同じくパッケージからの相対パスで渡す。テンプレートと `Model.tla` は接続のたびに読み直し、`Model.tla` は全探索の終了とモデルタブを開いたときにも読み直す。
- `src/core/prompts.ts` は import を 1 つも持たない。ビューア（DOM）とサーバー（Node）が同じ `fillTemplate` と `PROMPT_KINDS` を使うために core に置き、`src/ui` に許す core の import を `types` に加えてこの 1 ファイルだけにした。Node が入り込まないことは `test/ui-boundaries.test.ts` で確かめる。
- クリップボードへの書き込みはクリックの処理の中で同期的に `generate` を流してから行う。書けなかったときは、生成した文面を読み取り専用の欄に出して手で写せるようにする。

## 非目標
- 「仕様と証明を書く」「乖離を直す」、グループ枠、ファイル粒度へのズーム
- 指示文の送信やエージェントの起動。クリップボードに入れるまで（要件定義書の非目標「コードの自動修正」）
- テンプレートの編集画面。上書きは `.everypath/templates/` にファイルを置いて行う

## 検証方法
`test/prompts.test.ts`、`test/ui-prompt.test.ts`、`test/ui-model.test.ts`（純関数）、`test/ui-state.test.ts`、`test/ui-view.test.ts`、`test/server.test.ts` に足す。条件 10 は内蔵ブラウザで実物を確かめる。作る。
