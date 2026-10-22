# OpenAIのモデルと認証

新規インストールは次の構成を生成します。既存設定の省略値は従来のCLI / Liveを維持するので、配備更新時は明示的に移行してください。

| 役割 | 新規設定 | 認証 |
|---|---|---|
| 音声会話 | GPT-Live 1 | OpenAI APIキー |
| 発話ごとの確定文字起こし | `gpt-transcribe` | OpenAI APIキー |
| 依頼・質問・提案の整理 | Responses API、`gpt-5.6-luna` | OpenAI APIキー |
| 作業・必要な協調実行・検証 | Codex App Server、`gpt-5.6-luna` | APIキー、または専用Codex homeのChatGPTログイン |

音声とResponsesのAPI利用は、ChatGPT契約の利用枠とは別です。App Server自体は課金方式ではなく、選んだ認証で仕事を実行する接続方式です。APIエラー時に契約ログインへ自動で切り替えません。利用できるモデルは接続先の権限も確認してください。

## 確定文字起こし

`voice.transcriptSource: "openai"` は、話者ごとに区切ったWAVを公式の `/v1/audio/transcriptions` へ送り、確定した文を処理します。`voice.openaiAsr` の既定は `gpt-transcribe`、日本語、1発話30秒、タイムアウト20秒です。音声の利用上限はLiveと文字起こし分を合算します。新規設定の一日上限は0なので、利用前に上限を決めます。

Liveの暫定文字列は表示・記録に使い、確定した依頼へ昇格させません。既存ローカルASRは移行用に保持しますが、新しい自己ホストモデル基盤は追加しません。録音全体を後処理するarchiveのASR設定は別です。

## 意図整理

Responses analyzerは `store: false`、再試行0、厳密なJSON schemaで呼び出します。資料と現在のTaskを読むだけで、ファイル操作や外部ツール実行はworkerが担当します。

既定の会話contextは最大12件・合計24000文字、既存Taskは最大5件・request合計12000文字、出力は推論を含め最大3000 tokensです。入力・cache・出力token数をイベントへ記録します。これらは1回の呼出し上限であり、月額費用の上限ではありません。

## 仕事の実行

新規設定の `worker.kind: "codex_app_server"` は、TaskとCodex threadを対応付け、同じ仕事の訂正を同じthreadへ渡します。モデルの作業と `worker.verify` はworkspaceを限定したsandboxで実行します。必要な分担はCodexのmulti-agent機能へ任せ、独自の常駐swarmは追加しません。[詳細設定と復旧](CODEX-APP-SERVER.md)。

`worker.apiKeyEnv: "OPENAI_API_KEY"` を使う場合は隔離したhomeと一時認証で動かします。ChatGPTログインを使う場合は `apiKeyEnv` を削除し、専用の `worker.codexHome` を指定します。両方の同時指定は拒否します。ログイン操作は必要なときだけ本人が行います。

旧 `worker.kind: "codex_cli"` は既存構成の移行用です。検証コマンドのホスト直接実行は廃止したため、`worker.verify` がある構成はApp Serverへ移行してください。`analyzer.fallback` / `worker.fallback` とローカルモデル互換プロキシは削除しました。旧設定は黙って無視せず、設定エラーにします。

変更ファイルはGitから列挙し、テスト結果とhash読戻しを成果に残します。結果は確認待ちで返し、テスト成功を利用者の採用や独立レビューと同一視しません。

公式資料：[ファイル文字起こし](https://developers.openai.com/api/docs/guides/speech-to-text)、[Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Codex App Server](https://developers.openai.com/codex/app-server)。
