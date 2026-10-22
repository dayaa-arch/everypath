# フェーズ 2 計画

`SPEC.md` §16 フェーズ 2 の 5 項目を、触るファイルと依存で 3 つの波に分ける。各項目は機能仕様（`docs/specs/<slug>.md`）を持つ 1 つの PR になる。フェーズ 1 で残した穴（前回承認日時、TypeOK の表示、Linux 監視の実機確認、TLC の資源上限）はどれもフェーズ 2 の前提ではないので、後回しにする（2026-10-22 の判断）。

## 進め方

1 つのチェックが 1 つの作業で、根拠（テストの出力、画面写し、SHA）がそろったときだけ付ける。各 PR は my-mode の Spec-driven feature で進める。仕様、失敗するテスト、実装の順にコミットし、ビューアに触る PR は内蔵ブラウザで実物を確かめる。マージは作者の指示で行う。

## 第 1 波（並行、ファイルが重ならない）

- [ ] P2-1 Mermaid 出力。`everypath export [dir] --mermaid` が `stateDiagram-v2` を出す。触るのは `src/core/mermaid.ts`（新規）と `src/cli.ts` の `export` だけ。
- [ ] P2-2 `dep-only-via` の簡易検査と、`never-reach` の TLC 判定。触るのは `src/core/properties.ts`、`src/core/tla/`、`src/core/types.ts` の性質の型。
- [ ] P2-3 観測遷移と乖離、`@state-route`。`SPEC.md` §8.5、§17.1（推奨どおり `@state-route` 必須で始める）。触るのは `src/core/scan.ts`、`src/core/annotations.ts`、新しい観測モジュール、`src/core/types.ts` の辺と `drift`。

## 第 2 波（P2-3 の後）

- [ ] P2-4 ビューアの乖離表示（橙の辺と「宣言なし」、`SPEC.md` §7.3）、「乖離を直す」指示（§13）、グループ枠（§12.1）、ファイル粒度へのズーム。触るのは `src/ui/` と `templates/prompts/`。

## 第 3 波（すべての後）

- [ ] P2-5 階層状態 `@state-parent`。TLA+ 上は平らにする。注釈、スキャン、TLA+ 生成、ビューアのすべてに触るので、最後に 1 つで行い、architect と interrogate を通す。

## 終わり方

- [ ] 全 PR をマージした `main` で、フェーズ 1 の受け入れ基準 12 項目が崩れていないことと、各仕様の完了条件を確かめる。

## 付録. 重なりと危険

- `src/core/types.ts` は P2-2 と P2-3 の両方が触る。触る箇所は性質と辺で分かれるが、後からマージする側が取り込み直す。
- 階層状態は、グループ枠（P2-4）と描き方が近い。P2-5 で枠の描画を共通にするかを決める。
