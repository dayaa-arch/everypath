#!/bin/sh
# Rebuilds test/fixtures/proofs/ from the pinned sources. Usage: fetch-fixtures.sh <repo root>
set -eu
OUT="$1/test/fixtures/proofs"
mkdir -p "$OUT/dafny" "$OUT/verus"
D=5f717bf447b19d38cad1b69b1bf9a9f102feccfb
V=920ee002ddf3510d096c97deea4c1691c5af6fe2
LIT=Source/IntegrationTests/TestFiles/LitTests/LitTest
raw() { gh api "repos/$1/contents/$2?ref=$3" --jq '.content' | base64 -d; }
fixture() { # file source exit note
  { printf 'source: %s\nexit: %s\nnote: %s\n---\n' "$2" "$3" "$4"; cat; } > "$OUT/$1"
}
raw dafny-lang/dafny "$LIT/dafny4/Bug72.dfy.expect" $D | fixture dafny/verified.txt \
  "https://github.com/dafny-lang/dafny/blob/$D/$LIT/dafny4/Bug72.dfy.expect" 0 \
  "Bug72.dfy の RUN 行は %verify（dafny verify）で %exits-with が無いので、終了コードは 0"
raw dafny-lang/dafny "$LIT/dafny4/Bug73.dfy.expect" $D | fixture dafny/assertions.txt \
  "https://github.com/dafny-lang/dafny/blob/$D/$LIT/dafny4/Bug73.dfy.expect" 4 \
  "Bug73.dfy の RUN 行が %exits-with 4 %verify"
raw dafny-lang/dafny docs/DafnyRef/UserGuide.1.expect $D | fixture dafny/postcondition.txt \
  "https://github.com/dafny-lang/dafny/blob/$D/docs/DafnyRef/UserGuide.1.expect" 4 \
  "UserGuide.md 13.7.1.1 の %check-verify。終了コードは出典に無く、UserGuide.md 13.6.3 の「4 -- verification errors」による"
raw dafny-lang/dafny "$LIT/cli/defaultTimeLimit.dfy.expect" $D | fixture dafny/timeout.txt \
  "https://github.com/dafny-lang/dafny/blob/$D/$LIT/cli/defaultTimeLimit.dfy.expect" 4 \
  "RUN 行は ! %baredafny verify（0 以外）。4 は UserGuide.md 13.6.3 の検証エラーの値で推測。秒数は RUN 行の sed が <redacted> に置き換えたもの。--show-snippets:false を付けない既定の出力なのでコードの抜き書きが付く"
raw dafny-lang/dafny docs/DafnyRef/Types.5.expect $D | fixture dafny/resolution.txt \
  "https://github.com/dafny-lang/dafny/blob/$D/docs/DafnyRef/Types.5.expect" 2 \
  "終了コードは出典に無く、UserGuide.md 13.6.3 の「2 -- syntax, parse, or name or type resolution errors」による"
raw verus-lang/verus source/docs/guide/src/getting_started_cmd_line.md $V | sed -n 32,34p | fixture verus/verified.txt \
  "https://github.com/verus-lang/verus/blob/$V/source/docs/guide/src/getting_started_cmd_line.md?plain=1#L32-L34" 0 \
  "終了コードは出典に無い。通ったので 0 とした（推測）"
raw verus-lang/verus source/docs/guide/src/getting_started_cmd_line.md $V | sed -n 52,62p | fixture verus/assertion.txt \
  "https://github.com/verus-lang/verus/blob/$V/source/docs/guide/src/getting_started_cmd_line.md?plain=1#L52-L62" 1 \
  "終了コードは出典に無い。rustc と同じく失敗で 1 とした（推測）"
raw verus-lang/verus source/vir/src/messages.rs $V | sed -n 115,122p | sed -e 's#^/// \{0,1\}##' -e 's#  *// .*$##' | fixture verus/precondition.txt \
  "https://github.com/verus-lang/verus/blob/$V/source/vir/src/messages.rs#L115-L122" 1 \
  "doc コメントの例。行頭の /// と、行末の // 以降（例の説明の注記）を消した。終了コードは出典に無く 1 とした（推測）"
raw verus-lang/verus source/docs/guide/src/assert_assume.md $V | sed -n 23,26p | fixture verus/postcondition.txt \
  "https://github.com/verus-lang/verus/blob/$V/source/docs/guide/src/assert_assume.md?plain=1#L23-L26" 1 \
  "ガイドが場所の行（-->）を省いた抜き書き。終了コードは出典に無く 1 とした（推測）"
raw verus-lang/verus source/docs/guide/src/assert_assume.md $V | sed -n 51,51p | fixture verus/verified-legacy.txt \
  "https://github.com/verus-lang/verus/blob/$V/source/docs/guide/src/assert_assume.md?plain=1#L51" 0 \
  "古い版の要約行の形。終了コードは出典に無く、通ったので 0 とした（推測）"
