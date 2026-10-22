# Codex App Serverで仕事を進める

`worker.kind: "codex_app_server"` は、既存のTask ownerからCodexの公式harnessへ一件の仕事を渡します。モデルを分担させる独自loopは作りません。Codexのnativeな`multi_agent`を有効にし、必要なときだけ分担と結果の統合・検証を依頼します。

```json
{
  "worker": {
    "kind": "codex_app_server",
    "executable": "codex",
    "workspace": "work-repo",
    "apiKeyEnv": "OPENAI_API_KEY",
    "actions": ["research", "summarize", "write_file", "develop"],
    "verify": [{"executable": "node", "args": ["--test"]}],
    "timeoutSeconds": 300
  }
}
```

`workspace`は設定ファイルからの相対パスです。モデルを指定した場合はその指定を使います。API認証には既存の環境変数を使い、鍵を設定JSONや会話へ書きません。

## 認証を分ける

- `apiKeyEnv`を指定すると、`dataDir/codex-app-server`を専用のCodex homeにし、`cli_auth_credentials_store="ephemeral"`でAPI keyをプロセス内だけに設定します。`account/read`がAPI key認証を返したことを確認してからTaskを送ります。subscriptionへのfallbackや、親のauthファイルの変更は行いません。
- 既存の個人ログインを使う場合は`apiKeyEnv`を省略し、本人がChatGPTへログイン済みの専用`codexHome`を指定します。`account/read`が`chatgpt`を返すことを確認し、保存済みAPI key認証は拒否します。BotがブラウザログインやMFAを代行しません。API key用homeと同時指定できません。
- App Serverには`codex exec --ignore-user-config`と同じ起動optionがありません。既定の`ignoreUserConfig: true`では、選んだhomeに`config.toml`があると開始を拒否します。必要な個人設定を読む場合はoperatorが内容と実行権限を確認した専用homeで`ignoreUserConfig: false`を明示します。

ChatGPT subscriptionの権利とAPIの従量課金は別です。このadapterは共有・商用hostedサービス向けのSign in with ChatGPTを実装していません。その提供形態へ、個人のApp Server認証を転用しません。[公式App Server認証](https://learn.chatgpt.com/docs/app-server#auth-endpoints)、[認証とephemeral保存](https://learn.chatgpt.com/docs/auth)を確認してください。

## 同じ仕事を継続する

`dataDir/executions/<taskId>.json`はTaskとCodex thread/turn、使用workspace、入力revision、送信/終了状況の対応だけを保存します。Task ownerの権限・Source・状態台帳を置き換えません。同じTaskの訂正や明示的な再開は、同じthreadと変更候補のworktreeを使います。新しいrevisionの成果とpatchは別に保存します。

書込み後に読取り専用の調査へ訂正した場合も、同じ変更候補をread-onlyで調べます。後で書込みへ戻しても候補とthreadを維持します。配送するファイルは`dataDir/artifacts/<taskId>-r<revision>/files`のsnapshotへ固定し、現在のTask ID・revision・許可された保存先・hashを照合します。後続の訂正で以前の配送内容を書き換えません。

turn送信前に状態を書き、同じrevisionを自動再送しません。応答が失われた場合、分かっているturn IDだけを公式履歴から照合します。実行中やturn ID自体が不明なら`EXECUTION_RECONCILIATION_REQUIRED`として止めます。threadや対応ファイルを消して仕事をやり直す前に、operatorが既存の結果と外部効果を確認する必要があります。

停止は`turn/interrupt`、検証の停止は`command/exec/terminate`へ送り、最後にこのworkerが所有するプロセス群の終了を確認します。取消、失敗、承認待ち、接続断を成功へ変えません。新しい権限を要求された場合は自動許可せず`WORKER_INPUT_REQUIRED`で返します。この初期adapterにはDiscord上の追加承認UIはありません。

## 生成と検証の実行範囲

書込みはTask専用のGit worktreeです。生成と設定済み`verify`の両方に、workspace-write、network無効、共有temporary directoryへの追加書込み無効を明示します。検証は[App Serverのcommand/exec](https://learn.chatgpt.com/docs/app-server#command-execution)で実行し、生成されたコードをBotのhost shellで直接起動しません。sandboxが使えなければ失敗させます。

App Serverのapps・plugins・hooks・画像生成とweb検索はこの実行経路では無効です。追加の外部操作は、対応する権限と接続を設計・確認してから扱います。

旧`codex_cli`経路で`verify`を指定した書込みは、実行前に`VERIFY_REQUIRES_APP_SERVER`で拒否します。hostへの直接実行へfallbackしません。モデル・providerの自動fallbackもありません。read-onlyの調査は引き続きCLI経路で行えます。

この構成はmacOS/LinuxのPOSIX owner用です。Windowsからはそのownerへ依頼します。sandboxは実行中の書込みとnetworkを制限するもので、hostの全ファイルの読取りを隔離したcontainerではありません。秘密を持つ共有hostや、他者のコードを扱う公開サービスの隔離完了と扱わないでください。必要な依存は対象workspaceに準備し、検証のためにsandboxを無効にしません。

## 確認範囲

ローカルfixtureはthread再利用、途中停止、送信結果不明の重複抑止、別actorの対応拒否、認証選択、生成と検証へのsandbox指定、失敗の伝播を検査します。2026-10-22にはCodex `0.163.0-alpha.10.2` のschemaと照合し、macOSの実 `command/exec` でworkspace内の書込み成功・外側の拒否を確認しました。

Linuxでは既存CLIを変更せず、隔離した公式Codex `0.163.0` を使用。領域外・共有temporary領域の書込みとnetworkを拒否する実sandbox確認に加え、製品のResponses analyzer→Task→App Server実生成→sandbox内テスト→成果hash/添付bytesの読戻しが成功しました。認証はAPI key、専用homeにはauth.jsonもキー本文も残りませんでした。

これは実Discord音声、複数AIによる実案件、2人30分の会話、稼働Botへの配備を受け入れた証拠ではありません。正確な範囲は[確認状況](ACCEPTANCE.md)、残件は[製品Issue #3](https://github.com/Kotodama-Project/discord-voice-template/issues/3)を参照します。
