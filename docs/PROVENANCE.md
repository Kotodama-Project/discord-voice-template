# 出典とライセンス

この独立公開テンプレートは、[discord-bot-template](https://github.com/Kotodama-Project/discord-bot-template)（公開元：[Kotodama-project](https://github.com/Kotodama-Project/Kotodama-project/tree/86bc5bf45124e1b8e4520d376028c4e2eba99c84/runtime/discord-template) `86bc5bf45124e1b8e4520d376028c4e2eba99c84`）から、音声会話・録音と全文文字起こし・明示依頼の実行に絞って抽出しました。ブラウザ操作、外部サービス連携、招待作成などの機能は含みません。MITライセンスと寄与者表記を引き継ぎ、導入手順を独立リポジトリ向けに調整しています。公開コードのコピーを起点とし、非公開リポジトリのGit履歴は含みません。

このテンプレートの新規ソースはMITです。既存のprivate repositoryや運用設定、会話、音声、認証情報はコピーしていません。

設計上参照した公開候補：

- [Kotodama PR #69](https://github.com/Kotodama-Project/Kotodama-project/pull/69) — チャンネル別workspaceとLive接続の契約。
- [PR #71](https://github.com/Kotodama-Project/Kotodama-project/pull/71) — 静音・発話の分離とVoice-to-Work。
- [PR #59](https://github.com/Kotodama-Project/Kotodama-project/pull/59) — 訂正と実入力の版の束縛。
- [PR #67](https://github.com/Kotodama-Project/Kotodama-project/pull/67) — CLI実行証拠と独立確認の境界。

PRの存在やCI成功を、その機能の実運用成功とは扱いません。未解決レビューのあるSwarm実装をそのまま同梱していません。

使用するライブラリはpackage.jsonとpnpm-lock.yamlで固定します。依存関係のライセンスは各packageのLICENSEと公開時の第三者表示に従います。既存Kotodama本体のMITへの整理は、出典・寄与者・第三者条件を確認した別の変更として扱います。

## CT200 Live runtime adaptation

The optional natural conversation path ports the existing CT200 Live runtime's Responses delegation, streamed function-call completion and deduplication, 20 ms paced PCM input, and tool-controlled conversation ending. Its original regression contracts remain the comparison baseline; the public implementation contains no deployment configuration, private notes, credentials, or recorded conversation. Local transcription remains independent evidence. The existing speaker/mixed archival fusion pipeline is a separate integration requirement; a text-only correction candidate is not its replacement.
