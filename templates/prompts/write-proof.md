<!--
everypath の「仕様と証明を書く」。.everypath/templates/write-proof.md に置くと、この文面の代わりに使う。
全体の変数: {{TARGETS}} {{TOOL}} {{TOOL_COMMAND}}（everypath.config.json の proof。無ければ空）
{{#NODES}}…{{/NODES}} の中だけの変数: {{NODE}} {{FILES}} {{DESC}} {{SPEC}} {{PROOF}}（前回の証明。無ければ空）
{{#SPECS}}…{{/SPECS}} の中だけの変数: {{LINE}}（@state-spec の 1 行）
{{#名前}}…{{/名前}} は値が空でないときだけ、{{^名前}}…{{/名前}} は空のときだけ出る。
-->
次の機能には `@state-require proof` が付いていますが、証明が通っていません。仕様（事前条件、事後条件、不変条件）と、それを満たすことの証明を書いてください。

{{#NODES}}
{{NODE}}（{{FILES}}）
{{#DESC}}
説明: {{DESC}}
{{/DESC}}
{{#SPEC}}
現在の仕様（@state-spec）:
{{#SPECS}}
- {{LINE}}
{{/SPECS}}
{{/SPEC}}
{{^SPEC}}
現在の仕様: @state-spec はありません。まず事前条件と事後条件を `@state-spec` に 1 行ずつ書いてください。
{{/SPEC}}
{{#PROOF}}
前回の証明: {{PROOF}}
{{/PROOF}}

{{/NODES}}
{{#TOOL}}
検証ツール: {{TOOL}}（everypath.config.json の proof）。`everypath prove` が状態ごとに `{{TOOL_COMMAND}}` を走らせます。
{{/TOOL}}
{{^TOOL}}
検証ツールが決まっていません。everypath.config.json の proof に tool（dafny、verus、command のどれか）を書くよう人間に提案してください。設定は自分で書き込まないでください。
{{/TOOL}}
`{files}` に入るのは、その状態のファイルのうち、dafny なら .dfy、verus なら .rs、command ならすべてです。証明を新しいファイルに書くときは、先頭のコメントに対象と同じ `@state <名前>` を書いて、その状態のファイルにしてください。

`@state-spec` と証明の条件を食い違わせないでください。`.everypath/` の中は書き換えないでください（proofs.json は everypath prove が書きます）。

完了条件: `everypath prove` の後、`.everypath/proofs.json` で {{TARGETS}} の result が passed になり、既存テストが通ること。
