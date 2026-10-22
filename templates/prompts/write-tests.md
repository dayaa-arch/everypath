<!--
everypath の「テストを書く」。.everypath/templates/write-tests.md に置くと、この文面の代わりに使う。
全体の変数: {{TARGETS}}
{{#NODES}}…{{/NODES}} の中だけの変数: {{NODE}} {{FILES}} {{DESC}} {{SPEC}}
{{#名前}}…{{/名前}} は値が空でないときだけ、{{^名前}}…{{/名前}} は空のときだけ出る。
-->
次の機能にテストを書いてください。everypath の地図で「未テスト」になっています。

{{#NODES}}
{{NODE}}（{{FILES}}）
{{#DESC}}
説明: {{DESC}}
{{/DESC}}
{{#SPEC}}
想定仕様: {{SPEC}}
{{/SPEC}}

{{/NODES}}
テストは機能のファイルを import し、利用者から見える振る舞いを確かめてください。

完了条件: テストが上のファイルを import し、`everypath scan` の後に {{TARGETS}} が「未テスト」でなくなること。既存テストが通ること。
