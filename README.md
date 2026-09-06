# BookView PDF (Obsidian plugin)

縦書き・**右綴じ**の日本語文書を、正しい向きで**見開き表示**できる Obsidian 用 PDF ビューアです。
Acrobat Reader の「**表紙を表示**」（1 ページ目だけを単独で表示し、2 ページ目以降を 2-3 / 4-5 … と見開きにする）にも対応しています。

## 機能

- **見開き表示 / 単ページ表示** の切り替え
- **右綴じ（縦書き向け）/ 左綴じ** の切り替え
  - 右綴じでは 1 ページ目が左半分、2 ページ目が右・3 ページ目が左…と、実際の和書と同じ並びになります
  - 矢印キーの意味も綴じ方向に追従します（右綴じなら `←` が「次へ」）
- **表紙を表示（Show Cover Page）**
  - 表紙は単独表示。さらに表紙や最終ページのように片側しかない場合は、中央ではなく綴じ側に寄せて配置します（Acrobat と同じ見え方）
- PDF 自身の設定の自動判別
  - `/ViewerPreferences /Direction /R2L` → 右綴じ
  - `/PageLayout /TwoPageRight` → 見開き＋表紙単独
- 全体表示 / 幅に合わせる / 任意倍率のズーム、90 度回転
- ファイルごとに綴じ方向・見開き設定・表示中のページを記憶
- 日本語 PDF 向けに pdf.js の CMap を同梱（`UniJIS-UCS2-H`、`90ms-RKSJ-H` などの定義済みエンコーディングを使う PDF もそのまま表示できます）
- ネットワークアクセスなし。pdf.js 本体・Worker・CMap はすべて `main.js` に同梱

## 操作

| キー | 動作 |
| --- | --- |
| `←` / `→` | 次／前（綴じ方向に応じて反転） |
| `↑` `↓` `PageUp` `PageDown` `Space` | 前／次 |
| `Home` / `End` | 最初／最後 |
| `+` / `-` | 拡大／縮小 |
| `0` | 全体を表示 |
| `W` | 幅に合わせる |
| `S` | 見開き表示の切り替え |
| `C` | 表紙を表示の切り替え |
| `R` | 右綴じ／左綴じの切り替え |

- ホイール: ページ送り（拡大してはみ出しているときは端まで来てから送ります）
- `Ctrl` / `Cmd` + ホイール: 拡大縮小

コマンドパレットからも同じ操作ができます（`BookView PDF:` で検索）。ホットキーは Obsidian の設定で割り当てられます。

## インストール

コミュニティプラグインには未登録なので、手動で入れます。

```bash
npm install
npm run build
```

生成された `main.js` / `manifest.json` / `styles.css` を Vault の
`<Vault>/.obsidian/plugins/bookview/` にコピーし、Obsidian の設定 → コミュニティプラグインで有効化してください。

コピーはスクリプトでもできます。

```bash
npm run deploy -- "C:/path/to/Vault"
```

## 設定

- 新しく開く PDF の既定値（見開き／右綴じ／表紙表示／ズーム）
- PDF 自身のレイアウト指定を優先するか
- 片側だけのページを綴じ側に寄せるか、見開きの間隔、ページの影、描画解像度
- ダークテーマで色を反転するか
- `.pdf` を BookView で開くか（オフにすると Obsidian 標準のビューアのままで、コマンド `Open current PDF in BookView` やファイルメニューから個別に開けます）
- ファイルごとの状態を記憶するか

## 開発

```bash
npm run dev      # esbuild の watch ビルド
npm run build    # 型チェック + 本番ビルド
```

### 動作確認用ハーネス

Obsidian を起動せずに、実物のビューをブラウザ上で動かせます。

```bash
npm run test:pdf      # test/sample.pdf を生成（5 ページ・右綴じ指定・日本語入り）
npm run test:build    # test/harness.js をビルド
npm run test:serve    # http://localhost:4321/test/index.html
```

`test/obsidian.ts` は Obsidian API の最小スタブで、プラグイン本体には含まれません。

## 制限

- テキストレイヤーがないため、本文の選択・コピー・検索はできません（描画のみ）。
- Markdown 内の埋め込み（`![[file.pdf]]`）は Obsidian 標準の描画のままです。
- 埋め込みフォントのない CJK PDF は、環境のフォントで代替描画されます。

## ライセンス

MIT. pdf.js（Apache License 2.0）を同梱しています。
