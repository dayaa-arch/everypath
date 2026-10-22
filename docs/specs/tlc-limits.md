# TLC のメモリ上限と出力の上限

## 目的
`check --tlc` とビューアの「全探索を実行」が走らせる TLC が、マシンの RAM の 4 分の 1 を使ったり、everypath のプロセスを大量の出力で落としたりしないようにする。利用者は `everypath.config.json` の `tla.maxHeap` で上限を変えられ、足りなければ日本語のエラーで上げ方を知る。保守する人は、上限が `runJava` の引数と出力の受け方の 2 か所にあり、既定値の根拠が `scripts/bench-tlc-heap.ts` で再計測できると覚えればよい。
満たす: R-03（Java があっても資源の足りない環境で、案内つきのエラーで続行する）、R-01（書く場所は変えない）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` が exit 0 で、`scripts/verify-requirements.ts` が ok（実行して確認）
- [ ] 2. 既定値。設定の無いリポジトリの TLC は、毎回 `java -Xmx3g -XX:+UseParallelGC -jar …` で動く（偽の `java` の引数の記録。`test/tlc-limits.test.ts`）
- [ ] 3. 設定。`{"tla": {"maxHeap": "6g"}}` なら `-Xmx6g`、`"512m"` なら `-Xmx512m` で動く。`"3"`、`"3gb"`、`3`、`"0g"`、`"4m"`（8m 未満）、`"tla": "x"` は `tla.maxHeap` を名指す警告を 1 件出して既定の `3g` で動き、`scan` は exit 0（同上）
- [ ] 4. 出力の上限。TLC の出力は最後の 16 Mi 文字だけを持つ。偽の `java` が 600 MB の途中経過の行のあとに違反を出しても、`check --tlc` は落ちずに反例 3 歩と状態数 25 を読む（同上。上限が無いと Node の文字列の上限を超える）。上限を超えて反例の先頭まで捨てたときは、出力を捨てたことを言う `error` になる（`test/tla.test.ts` のパースの単体）
- [ ] 5. メモリ不足。TLC が「Java ran out of memory」か `java.lang.OutOfMemoryError` で終わると、残りの性質は TLC を走らせ直さずに `error` になり、`check --tlc` は「TLC のメモリが足りませんでした（Java のヒープの上限 3g）」と `tla.maxHeap` の上げ方を出して exit 1（偽の `java` と実物の出力の fixture。同上）
- [ ] 6. 実機。実物の TLC で `example/` のコピーと 19,740 本の遷移のモデルが既定値で通り、後者に `"maxHeap": "256m"` を書くと 5 の日本語のエラーになる（手で実行し、返答に貼る）

## データの形
```ts
// src/core/config.ts。境界で読む。8m 以上の整数 + m か g。既定は 3072（3g）
type Config = { …; readonly tla: { readonly maxHeapMb: number } };
// src/core/tla/run.ts。出力は末尾だけを持つ。truncated は先頭を捨てたか
type TlcRun = { kind: "missing"; … } | { kind: "exited" | "timeout"; output: string; truncated: boolean };
// src/core/tla/parse.ts。メモリ不足は判定の 1 つの結末
type TlcReport = … | { kind: "out-of-memory"; distinctStates: number | null };
```
表し方: メモリ不足は `TlcReport` の別の `kind` にする。理由: メッセージに上限の値を入れるのは設定を知る `run.ts` で、パースは設定を知らないため。

## 決めたこと
- 既定は `3g`。`scripts/bench-tlc-heap.ts` の実測（TLC 2.19、16 GB の macOS、JVM の既定は 3641 MB）で決める。数字は「実測」の節に書く。
- `-Xmx` は `JAVA_TOOL_OPTIONS` より後に読まれるので、everypath の値が勝つ。上限は `tla.maxHeap` だけで変える。
- 出力の上限は 16 Mi 文字。9,000,000 状態の格子の端で破れる不変条件の反例（2,999 歩）が 416 KB だったので、その 40 倍。先頭を捨てても、パーサーが読む `Error:` の行、反例、最後の状態数は末尾にある。
- メモリ不足の後は残りの性質で TLC を走らせない。どの実行も同じ `Model.tla` を読むので同じく足りず、上限の近くでは 1 回に 100 秒かかったことがある。

## 実測
`scripts/bench-tlc-heap.ts`。`-workers 1`、TLC 2.19、Apple Silicon の 16 GB。ヒープの必要量は状態数ではなく `Model.tla` の大きさで決まる。

| モデル | 遷移 | Model.tla | 足りない | 通る（所要） | JVM の既定（3641 MB） |
|---|---|---|---|---|---|
| `example/` | 13 | 4 KB | なし | 16m（0.7 秒） | 0.9 秒、RSS 101 MB |
| 親 + 子 140 + 自己遷移 | 19,740 | 4.1 MB | 640m | 768m（29 秒）、1536m（8.6 秒） | 9.5 秒、RSS 1.7 GB |
| 同じ + ガード 8 項 | 19,740 | 7.3 MB | 1536m | 2048m（17 秒） | 15.5 秒、RSS 2.3 GB |
| 同じ + ガード 10 項（8 MB の上限の手前） | 19,740 | 8.1 MB | なし | 2048m（25 秒）、2560m（14.7 秒）、3072m（14.4 秒） | 15.4 秒、RSS 2.6 GB |
| 2 つの変数 0..1499 の格子 | 4 | 2 KB | なし | 64m（40 秒）、3g（21.6 秒） | 22.2 秒、RSS 2.0 GB |

`3g` なら、`generateTla` が作る最大のモデル（`MAX_ARCS` と `MAX_TLA_BYTES` の両方の手前）が JVM の既定と同じ速さで通り、900 万状態のモデルも同じ速さで RSS が 2.0 GB から 1.4 GB に下がる。2g では 8 MB の手前のモデルが GC で 1.6 倍遅くなり、7.3 MB のモデルは 1536m で足りなかったので余裕が無い。RAM が 8 GB のマシンでは JVM の既定（2 GB）より上がるが、`-Xmx` は上限なので小さなモデルは小さいまま（`example/` の RSS は約 100 MB）。

## 非目標
- worker 数の設定（1 のまま。同じモデルで同じ反例を返すため）
- 実行中のメモリの監視や、上限からの自動のやり直し
- `tla.jar` の設定（`docs/specs/tla.md` の非目標のまま）

## 検証方法
`test/tlc-limits.test.ts`（偽の `java` で引数、設定、600 MB の出力、メモリ不足を確かめる）、`test/fixtures/tlc-output-out-of-memory.txt`（実物の TLC を `-Xmx128m` で動かした出力）、`test/tla.test.ts`（パースの単体）を実装より先に作る。既定値は `scripts/bench-tlc-heap.ts` で測る。条件 6 は手で実行する。
