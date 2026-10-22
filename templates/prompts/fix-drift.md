<!--
everypath の「乖離を直す」。.everypath/templates/fix-drift.md に置くと、この文面の代わりに使う。
全体の変数: {{TARGETS}}
{{#NODES}}…{{/NODES}} の中だけの変数: {{NODE}} {{FILES}} {{NEXT}}
{{#DRIFTS}}…{{/DRIFTS}} の中だけの変数: {{TO}} {{VIA}} {{TO_FILES}}。{{#REMOVE_CALL}} は「宣言が正しい」、{{#ADD_NEXT}} は「コードが正しい」を人間が選んだときだけ出る。
{{#名前}}…{{/名前}} は値が空でないときだけ、{{^名前}}…{{/名前}} は空のときだけ出る。
-->
{{#NODES}}
{{FILES}}（機能: {{NODE}}）のコードに、注釈で宣言していない画面遷移があります。

宣言している遷移:
{{#NEXT}}
{{NEXT}}
{{/NEXT}}
{{^NEXT}}
@state-next はありません。
{{/NEXT}}

コードにだけある遷移:
{{#DRIFTS}}
- {{NODE}} → {{TO}}（呼び出しのあるファイル: {{VIA}}。{{TO}} の @state-route は {{TO_FILES}} にあります）
{{#REMOVE_CALL}}
  宣言が正しいと人間が判断しました。{{VIA}} にある {{TO}} への呼び出し（router.push、router.replace、redirect、navigate、href）を消すか、宣言した遷移先へ向けてください。
{{/REMOVE_CALL}}
{{#ADD_NEXT}}
  コードが正しいと人間が判断しました。{{FILES}} の注釈に `@state-next {{TO}}` を足してください。分かるなら on: のイベントと if:、set: も書いてください。
{{/ADD_NEXT}}
{{/DRIFTS}}

{{/NODES}}
人間が選んだ側だけを直してください。もう一方は変えないでください。

完了条件: `everypath scan` の後、`.everypath/graph.json` の `drift` に上の遷移が無く、既存テストが通ること。
