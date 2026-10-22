<!--
everypath の「反例を直す」。.everypath/templates/fix-counterexample.md に置くと、この文面の代わりに使う。
全体の変数: {{TARGETS}} {{CHECK_COMMAND}} {{PROPERTY_IDS}} {{APPROVED}}
{{#NODES}}…{{/NODES}} の中だけの変数: {{NODE}} {{FILES}} {{DESC}} {{SPEC}} {{FINDINGS}} {{RISKS}} {{VIOLATIONS}}
{{#名前}}…{{/名前}} は値が空でないときだけ、{{^名前}}…{{/名前}} は空のときだけ出る。
-->
{{#NODES}}
{{FILES}}（機能: {{NODE}}）を修正してください。

{{VIOLATIONS}}
{{#FINDINGS}}
スキャン指摘:
{{FINDINGS}}
{{/FINDINGS}}
{{#RISKS}}
自己申告のリスク（@state-risk）:
{{RISKS}}
{{/RISKS}}
{{#SPEC}}
想定仕様: {{SPEC}}
{{/SPEC}}
{{^SPEC}}
想定仕様: @state-spec はありません。
{{/SPEC}}

{{/NODES}}
考えられる修正: 反例の最後の遷移の行き先を変える、または遷移にガード（if:）か代入（set:）を足す。どれが正しいかは実装を見て判断し、理由を報告してください。

完了条件: `{{CHECK_COMMAND}}` で {{PROPERTY_IDS}} が ok になり、既存テストが通ること。
{{#APPROVED}}
{{APPROVED}} は承認済みのため変更しないでください（必要なら理由を添えて報告）。
{{/APPROVED}}
