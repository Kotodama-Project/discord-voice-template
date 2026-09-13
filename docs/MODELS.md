# 仕事を実行するモデル

Lunaでの接続はCodex CLI 0.154.0で確認しています。古いCLIから「requires a newer version of Codex」が返ったら、使用するCLIを更新してください。

Botの意図整理・仕事実行は、既定で `gpt-5.6-luna` をCodex CLIから呼びます。明示した別モデルは保持します。音声の聞き役 `gpt-live-1`、任意のローカルASR、Luna backendは別の役割です。Liveの断片文字起こしからTaskを作らず、Kotodamaが保存した確定SourceをLunaへ渡します。

音声相談の応答時間とプロセス負荷を下げたい場合は、意図整理だけをResponses APIへ切り替えられます。同じ `OPENAI_API_KEY` でGPT-LiveとLunaを使う例です。

```json
{
  "analyzer": {
    "kind": "responses",
    "model": "gpt-5.6-luna",
    "apiKeyEnv": "OPENAI_API_KEY",
    "baseUrl": "https://api.openai.com/v1",
    "timeoutSeconds": 60,
    "maxOutputTokens": 3000,
    "reasoningEffort": "low",
    "maxContextSources": 12,
    "maxContextChars": 24000,
    "maxTaskContextItems": 5,
    "maxTaskContextChars": 12000
  }
}
```

この経路は `store: false`、API retry 0、厳密なIntent JSON schemaで一回だけ呼びます。Sourceと現在のTaskを資料として渡しますが、Luna自身にファイルや外部ツールを実行させません。実際の仕事は引き続き権限・workspace・検証を持つworkerが担当します。

安定したinstructionsを先頭、変化するSource・contextを後ろに置き、installationごとの匿名cache keyを使います。contextは新しいSourceから最大12件・合計24000文字、既存Taskは最大5件・request合計12000文字、出力は推論分を含め最大3000 tokenです。各応答のinput、cached input、output、total tokenを `analysis.model_used` eventへ一回記録します。

認証保存先を分ける場合は `analyzer.codexHome` と `worker.codexHome` を設定し、本人が `tools/codex-login.mjs` でログインします。認証情報をBotの会話やモデルへのプロンプトへ入れません。

## 任意のフォールバック

`analyzer.fallback` / `worker.fallback` に別のCLI設定を入れられます。無限再試行や再帰的なフォールバックはしません。

- 認証が必要な場合、または実行器の起動に失敗した場合だけ切り替えます。
- 停止・権限取消・終了未確認・一般的なモデル失敗では切り替えません。
- 書込みでは、開始時のGit HEAD、index、作業ファイル、未追跡・ignoredファイルが変わっていないことを確認します。
- CLIへ指定したモデル、フォールバックの有無、切替理由を成果・意図整理の記録へ残します。

仕事の実行器が文章で成果を返した場合は、文章をそのまま資料候補へ保存します。変更ファイルはモデルの申告だけに頼らずGitから列挙し、設定したテストとhash読戻しを通します。意図・権限・ToDoの機械処理には引き続き構造化JSONを要求し、文章から推測で補完しません。

ローカルのResponses互換サーバーを使う設定例（`worker.fallback`の値）：

```json
{
  "executable": "node",
  "args": [
    "/path/to/template/tools/compatible-codex.mjs",
    "--base-url", "http://127.0.0.1:8080/v1",
    "--codex", "/path/to/codex"
  ],
  "model": "your-configured-local-model",
  "codexHome": "codex-home",
  "timeoutSeconds": 300
}
```

この補助CLIは、一回の呼出しだけloopbackプロキシを起動します。先頭にだけsystemメッセージを置けるチャットテンプレート向けに、元のsystem/developer指示を先頭へ整理し、user・資料・tool出力はその役割のまま保持します。ブラウザのCookieや呼出し元のAuthorizationヘッダーを転送しません。未対応のtool形式は拒否します。モデル、構造化出力、ツール操作は使うサーバーごとに確認してください。

既定のCLI呼出しでは、別用途のアプリ・プラグイン・多重エージェント・画像生成を起動しません。接続するツールを増やす場合は、実行器の構成と初回の許可範囲を合わせて検証します。
