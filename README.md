# 当直表メーカー

大学医局の当直・外勤表を、勤務帯や回復時間ルールから自動生成する Web ツール。

## サイト構成

| URL | ファイル | 内容 |
|---|---|---|
| `/` | `index.html` | ランディングページ(LP) |
| `/app` | `app/index.html` | 当直表メーカーアプリ本体 |
| `/privacy` | `privacy.html` | プライバシーポリシー |
| `/terms` | `terms.html` | 利用規約 |
| `/contact` | `contact.html` | 運営者情報・お問い合わせ |

clean URL は `vercel.json` の `cleanUrls: true` で実現(`.html` 拡張子を省略可)。

## アプリ機能(無料プラン)

- 担当者・グループ・外勤先の登録
- 勤務帯(外来 / 日直 / 当直 / 日当直)+ 自動勤務時間 + 回復時間
- 第N曜日 / 毎日・偶数日・奇数日 などの勤務日ルール
- 当直・オンコール セルの 日直/当直 分割対応
- 候補者の自動振り分け(同日重複・連続勤務・回復時間を考慮)
- グループ間/グループ内の均等化(全カテゴリ合計回数ベース)
- Excel(.xlsx)出力(プレビュー → 30秒広告 → ダウンロード)
- 1ステップ Undo (Ctrl+Z)
- ブラウザ localStorage によるマスタ保存

## 技術構成

- 静的 HTML + Vanilla JS(アプリ)
- Tailwind CSS(LP / privacy / terms / contact)
- [xlsx-js-style](https://github.com/gitbrent/xlsx-js-style) (Excel 出力)
- Inter / Noto Sans JP (フォント)

## デプロイ

Vercel に GitHub 連携でデプロイ。Build 設定不要(静的ファイル配信)。`vercel.json` のみ反映される。

## ロードマップ

- [x] 無料プラン (静的)
- [ ] 会員登録(Clerk)+ DB 保存(Neon)
- [ ] ライトプラン課金(Stripe)
- [ ] プロプラン: 希望休 Web 自動収集 / 医局員向けスマホ画面
