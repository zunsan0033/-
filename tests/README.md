# かんたん家計簿 v1.11.0 テストキット（kakeibo_v11100_testkit）

v1.11.0 で追加した「今月の食費」（食費の月予算と今月の残り）のテストと、v1.10.20 との比較テストです。

## 必要なもの

- Node.js 18 以降
- Playwright（`npm i -g playwright` など。`require('playwright')` で読める場所か、`npm root -g` の下）と Chromium
  - Chromium の場所を指定するときは環境変数 `KAKEIBO_CHROMIUM=/path/to/chromium`
- `unzip`（ZIP を直接指定するとき）、`diff`（static_checks の差分確認）

## 実行

```sh
node run_all.cjs --app <kakeibo_free_v1_11_0_netlify.zip または展開したフォルダ> \
                 --base <kakeibo_free_v1_10_20_layout_fix_netlify.zip または展開したフォルダ> \
                 --out <結果を書き出すフォルダ>
```

- パスはすべて、実行したときのカレントディレクトリからの相対パスか絶対パスです（作者の環境のパスは使いません）。
- `--app` を省くと、このキットの1つ上の `site/` を使います（リポジトリの配置）。どちらもなければエラーで止まります。
- `--base` を省くと、v1.10.20 との比較（static_checks の差分確認と regression_compare）は「skipped」になります（合格としては数えません）。
- 各テストは単独でも実行できます：`node unit_food_budget.cjs --app …`
- ネットワークは使いません（読み取りエンジンの jsDelivr への通信は止め、Service Worker は使わずに、指定したファイルだけで動かします）。

## 中身

| ファイル | 内容 |
|---|---|
| `static_checks.cjs` | 版の表記5か所、ENGINE_CACHE・IndexedDB・バックアップ形式1・CSP が変わっていないこと、v1.10.20 との差分が予算機能と版の表記だけであること |
| `unit_food_budget.cjs` | `foodBudgetStatus` など純関数の単体テスト（未設定／設定済み／超過／残り0／税の按分／食費と外食の混在／前月・翌月／月末・月初の日数／不正な入力値／壊れたJSON／localStorage の例外） |
| `browser_food_budget.cjs` | 390×844（iPhone 相当）での操作テスト（設定・手入力・外食・削除・解除・再読み込み・月またぎ・カテゴリ別との一致・書き込み失敗・バックアップ） |
| `layout_food_budget.cjs` | 幅 320／375／390／430px で横スクロールが出ないこと、¥10,000,000 などの大きな金額でもカードからはみ出さないこと（`--out` があれば画面写真を保存） |
| `regression_compare.cjs` | v1.10.20 と v1.11.0 を同じ時計・同じ入力で動かし、新しいカード以外（画面のHTMLと計算済みスタイル、レシート文字の読み取りと保存、手入力、編集、削除、カレンダー、グラフ、バックアップ）が同じになること |
| `lib/harness.cjs` | 共通の小さな仕組み（静的サーバ、Playwright の起動、結果の書き出し） |

結果は `--out` のフォルダに suite ごとの JSON と `summary.md` で書き出します。

## このキットで確かめられないこと

Chromium（Linux）での模擬です。iPhone の Safari・ホーム画面に追加したアプリでの表示と入力（数字キーボード、文字の大きさ、セーフエリア）は実機で確認してください。
