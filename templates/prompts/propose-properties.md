<!--
everypath の「性質を提案させる」。.everypath/templates/propose-properties.md に置くと、この文面の代わりに使う。
全体の変数: {{TARGETS}} {{STATES}} {{VARS}} {{EVENTS}} {{PROPERTIES}}
{{#名前}}…{{/名前}} は値が空でないときだけ、{{^名前}}…{{/名前}} は空のときだけ出る。
-->
everypath のモデルに足すとよい性質を提案してください。

状態: {{STATES}}
{{#VARS}}
変数: {{VARS}}
{{/VARS}}
{{#EVENTS}}
イベント: {{EVENTS}}
{{/EVENTS}}
注目している状態: {{TARGETS}}

{{#PROPERTIES}}
いまの性質（everypath.properties.json）:
{{PROPERTIES}}
{{/PROPERTIES}}
{{^PROPERTIES}}
いまの性質はありません。
{{/PROPERTIES}}

書ける種類は invariant（expr がいつも真）、leads-to（from が真になったら、いつか to が真）、never-reach、always-reach、no-dead-end です。式は if: と同じ文法に、state、state in {…}、=>（含意）を足したものです。

完了条件: everypath.properties.json に足す案を JSON で示し、それぞれが何を守るのかを 1 文で説明すること。ファイルには書き込まないでください。人間が読んで承認してから足します。
