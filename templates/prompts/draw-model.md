<!--
everypath の「モデルを描かせる」。.everypath/templates/draw-model.md に置くと、この文面の代わりに使う。
全体の変数: {{TARGETS}} {{STATES}} {{VARS}} {{EVENTS}}
{{#NODES}}…{{/NODES}} の中だけの変数: {{NODE}} {{FILES}} {{DESC}} {{NEXT}}
{{#名前}}…{{/名前}} は値が空でないときだけ、{{^名前}}…{{/名前}} は空のときだけ出る。
-->
次の機能のコードを読み、状態遷移の注釈をファイルの先頭に書き足してください。everypath はこの注釈から TLA+ のモデルを作り、すべての経路を検査します。

{{#NODES}}
{{NODE}}（{{FILES}}）
{{#NEXT}}
いまの遷移:
{{NEXT}}
{{/NEXT}}
{{^NEXT}}
いまの遷移: @state-next はまだありません。
{{/NEXT}}

{{/NODES}}
いまのモデルの状態: {{STATES}}
{{#VARS}}
変数: {{VARS}}
{{/VARS}}
{{#EVENTS}}
イベント: {{EVENTS}}
{{/EVENTS}}

書き方の例:
// @state ログイン
// @state-var authed: BOOLEAN = FALSE
// @state-var retries: 0..3 = 0
// @state-next Home on:login_ok set:authed=TRUE, retries=0
// @state-next ログイン on:login_fail if:retries<3 set:retries=retries+1
// @state-next ロック on:login_fail if:retries==3

遷移にはできるだけ on:（イベント）を付けてください。条件分岐は @state-var の変数と if: で表し、値の変化は set: で書いてください。変数は BOOLEAN、0..N の整数、列挙のどれかにしてください。

完了条件: {{TARGETS}} から flow の矢印が出て、`everypath check` が通ること。
