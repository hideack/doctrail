# DocTrail

macOS 向けの閲覧専用 Markdown Viewer です。Tauri + React + TypeScript で動作し、GitHub Flavored Markdown、コードハイライト、Mermaid 図、アウトライン、全文検索に対応します。

## セットアップ

```bash
npm install
```

Tauri のビルドには Rust と macOS 向けの Tauri 前提環境が必要です。

## 開発ドキュメント

実装の構成、主要なイベント経路、Tauri 側の注意点は [docs/development.md](docs/development.md) にまとめています。生成AIや別の開発者が作業を引き継ぐ場合は、先にこのファイルを読んでください。

## 開発起動

```bash
npm run tauri:dev
```

ブラウザだけで UI を確認する場合:

```bash
npm run dev
```

## ビルド

Web アセットのみ:

```bash
npm run build
```

macOS アプリ:

```bash
npm run tauri:build
```

## 使い方

- `Open` で Markdown ファイルを開きます。
- 上部ツールバーのフォルダアイコンで Markdown ファイルを開きます。
- Markdown ファイルをウィンドウへドラッグ＆ドロップして開けます。
- macOS の `Open With` / ファイル関連付けから Markdown ファイルを開けます。
- 複数ファイルを開くと、アウトラインの左側にファイル名だけの縦タブが表示されます。
- 更新アイコンで現在のファイルを再読み込みします。
- ツールバー右側のピンアイコンで、ツールバーを常時表示するか、カーソルが上部へ近づいたときだけ表示するかを切り替えられます。この設定は再起動後も保持されます。
- 拡大・縮小アイコンでプレビュー本文のフォントサイズを変更できます。
- 左ペインのアウトラインをクリックすると該当見出しへ移動します。
- 検索ボックスで本文検索し、Enter / Shift+Enter で次・前の一致箇所へ移動します。
- Markdown 内の相対画像パスは、開いている Markdown ファイルの場所を基準に表示します。

## macOS で Markdown に関連付ける

1. `npm run tauri:build` で `DocTrail.app` を作ります。
2. Finder で任意の `.md` ファイルを選び、`情報を見る` を開きます。
3. `このアプリケーションで開く` で `DocTrail.app` を選びます。
4. `すべてを変更...` を押すと、同じ拡張子の Markdown を DocTrail で開けます。

開発中の app bundle は以下に生成されます。

```text
src-tauri/target/release/bundle/macos/DocTrail.app
```
