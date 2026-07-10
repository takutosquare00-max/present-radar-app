# 🎁 プレゼント企画レーダー(スマホ版)

[present-radar](https://github.com/takutosquare00-max/present-radar)(非公開リポジトリ)の
収集データをスマホで閲覧・応募管理するための静的Webアプリ。GitHub Pagesで配信。

## セキュリティ設計

- このリポジトリには**アプリのコードのみ**を置く。キャンペーンデータ・応募状況・
  トークン等の個人情報は一切含まれない(それらは非公開リポジトリと端末内のみ)
- 認証は **Fine-grained PAT**(present-radar 1リポジトリ・Contents読み書きのみ)。
  トークンは端末の localStorage にのみ保存され、外部送信先は GitHub API だけ
- CSP で接続先を `api.github.com` に限定、外部・インラインスクリプト禁止
- 収集データ(外部RSS由来)は全てエスケープして描画(XSS対策)。
  応募リンクは https/http のみ許可

## 仕組み

- 読み込み: `data/campaigns.json`(収集結果)と `data/status.json`(応募状況)を
  GitHub Contents API で取得
- 書き込み: 応募した/スキップ を `data/status.json` に PUT(sha競合時は
  リモートとマージして再送)
- 状態変更は端末のlocalStorageへ即時保存し、GitHubへは10件単位または
  5分後にまとめて同期する。ヘッダーの同期ボタンで手動同期も可能
- Mac側は `python -m radar.sync` が status.json をローカルSQLiteに反映する

テスト:

```sh
node --test tests/*.test.js
```
