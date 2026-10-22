# Kotodama — Discordで話したことを、仕事と成果へ

**Discordで話す → 文字起こしを確認する → ゴールと作業を整理する → Codexが実行・検証する → 成果を受け取る。**

このリポジトリはKotodamaのDiscord製品を集約する場所です。OpenAIの音声・意図整理・Codex実行をつなぐ、小さなMITの接続層を作ります。旧Company OS、独自のエージェント実行基盤、新しいモデル配信基盤は作りません。[移行元と方針](https://github.com/Kotodama-Project/Kotodama-project)。

現在は開発候補です。ローカル試験、実API、実Discord、利用者の受入を[確認状況](docs/ACCEPTANCE.md)で区別します。移行中の既存Bot・記録・Task ownerを、この設定だけで置き換えたとは扱いません。

現行版の配送先は個人DM、会話の文脈はチャンネルごとです。既存の共有会議Botを置き換えるには、共有先の閲覧範囲・VCと仕事部屋の文脈・未処理依頼の移行が必要です。[既存Botからの移行](docs/OPERATIONS.md#既存botからの移行)を確認し、旧データ領域を直接指定しないでください。

## 残す機能

- **声で話す、すぐ文字で確認する。** GPT-Liveと会話しながら、発話ごとの確定文字起こしを読める人へDMで届けます。話者・発話ID・版を残し、訂正は原文を消さずに保存します。発話終了後の表示であり、逐字ストリーミングの保証ではありません。
- **頼んだ仕事が進む。** 許可された操作者の確定した明示依頼を、目的・作業・必要な操作へ整理します。Codex App Serverがworkspace内で実行し、必要な分担はCodexのmulti-agent機能を使います。
- **成果と根拠が返る。** ファイル・テスト結果・hashを読み戻して返します。同じ仕事の訂正は同じTaskとCodex threadへつなぎ、停止・再開・重複実行の防止を扱います。
- **記録を必要な範囲で残す。** 文字起こし・出典・権限・配送状態を小さく保持します。原音の永続保存は任意です。既存の録音・全文文字起こし・exportは移行用に保持します。

提案・質問・引用・Liveの暫定文字列を実行依頼へ変えません。発話停止と仕事停止は別です。新しいTask台帳や固定の常駐swarmは追加しません。

## 最初の設定

Node.js 24以上、Git、pnpm、Codex CLI（App Server対応）を用意します。録音保存を使う場合はffmpegも必要です。常駐配備はLinuxで検証し、Windowsの書込みworkerは未対応です。

```sh
git clone https://github.com/Kotodama-Project/discord-voice-template.git
cd discord-voice-template
pnpm install --frozen-lockfile
node bin/kotodama.mjs init --guild YOUR_GUILD_ID --app YOUR_APPLICATION_ID --operator YOUR_USER_ID --channel YOUR_TEXT_CHANNEL_ID --workspace /path/to/your/repository
```

生成した `.kotodama/config.json` で、次の4点を設定します。

1. Bot・サーバー・テキスト/音声チャンネルと操作者。導入手順は[Discord接続](docs/DISCORD-SETUP.md)。
2. `voice.participantIds` の処理対象。既定の `owner_managed` は人間の運用者が説明・同意確認を担当します。対象外の参加者や明示的な停止を無視しません。
3. `worker.workspace`、許可する `worker.actions`、実際に検証する `worker.verify`。書込みを使う場合は `write_file` / `develop` を明示します。検証コマンドもCodexのsandbox内で実行します。
4. 音声の一回・一日あたりの上限。**既定の一日上限は0**です。Liveと確定文字起こしの音声秒数を合算します。API側の利用上限も設定してください。

新規設定は `voice.transcriptSource: "openai"`、`conversationStart: "speech"`、Responses analyzer、Codex App Server workerです。GPT-Liveの会話と発話単位の確定ASRを並行し、Live接続に失敗しても確定した依頼は残します。既存設定の省略値は変えないため、既存配備は[モデルと認証](docs/MODELS.md)に沿って移行してください。

必要な変数は `.env.example` にあります。`DISCORD_BOT_TOKEN` と `OPENAI_API_KEY` を信頼する実行ホストで設定します。値をGit、CLI引数、会話へ貼りません。

```sh
node --env-file=.env bin/kotodama.mjs doctor --json
node --env-file=.env bin/kotodama.mjs register
node --env-file=.env bin/kotodama.mjs start
```

仕事の実行にはAPIキーまたはChatGPT契約のCodexログインを使えます。後者は `worker.apiKeyEnv` を削除して専用の `worker.codexHome` を指定します。音声・Responses APIの利用料は別です。[App Server設定と復旧](docs/CODEX-APP-SERVER.md)。

固定VCへの自動接続は `voice.autoJoin: true` で選べます。対象VCにいて、全員が現在の処理対象である場合だけ接続します。無人時には退出し、別VCへ追いかけません。

## 普段の使い方

| 操作 | Discord |
|---|---|
| 音声で相談・依頼 | 対象VCで話す。接続は `/kotodama voice join` |
| テキストで相談・依頼 | Botへのメンション、`/kotodama ask` / `do` |
| 自分の仕事・成果を見る | `/kotodama tasks` / `result` |
| 仕事を止める・再開する | `/kotodama stop` / `resume` |
| 聞き役・議事録のみ | `/kotodama voice assist` / `minutes` |
| 音声処理を止める・再開する | `/kotodama voice pause` / `resume` |
| VC退出・発話だけ停止 | `/kotodama voice leave` / `stop_speech` |
| 対象範囲・状態の確認 | `/kotodama consent` / `/kotodama voice status` |

手動の音声停止は再起動後も維持します。モード切替だけでは解除しません。文字起こしの表示は解析完了を待たず、解析が混み合った場合も発話を保存します。解析待ちは最大8件で、それを超えた発話から勝手に仕事を始めません。

成果は依頼者へのDM、コマンド結果は依頼者だけに見える返信です。送信結果が不明な場合は重複配送せず、`result`から確認します。成果は確認待ちとして返し、利用者の採用を代行しません。

## 既存記録の保存と移行

`voice.storeAudio: true` と `archive` を設定すると、参加者別の原音・mixed音声・全文文字起こしを保持します。GPT-Live返答の保存は `archive.captureAssistantAudio: true` で選びます。再生queueへ受け入れた音声と実際に聞き終えた範囲は区別します。

録音の外部文字起こし先は公式OpenAI APIだけです。既存privateローカルWhisperも保持します。リアルタイムASRと録音全体の後処理は別設定です。[保存接続](docs/ARCHIVE-RUNTIME.md)、[記録契約](docs/ARCHIVE-ADAPTER.md)。

```sh
node bin/kotodama.mjs export-transcript --actor YOUR_USER_ID --output ./full-transcript.md
node bin/kotodama.mjs read-export --actor YOUR_USER_ID --file ./full-transcript.md
```

既存remote Task ownerを使う場合は単独の正本として接続し、ローカル台帳との二重書込みをしません。[Task owner契約](docs/TASK-OWNER.md)。データ移行・実Botでの受入・切戻しを確認するまで旧サービスを止めません。

## 開発

```sh
pnpm test
pnpm check
```

Macでtemp directoryがシンボリックリンクを経由する場合、`TMPDIR=/private/tmp pnpm test` を使います。記録先のsymlink拒否を緩めません。

- [構成・権限・出典](docs/ARCHITECTURE.md)
- [起動・停止・復旧](docs/OPERATIONS.md)
- [確認状況](docs/ACCEPTANCE.md)

実サーバー・参加者・音声・認証情報・成果はGitへ入れません。変更は関連する検証と独立レビューを通し、実APIの成功と実VCでの使いやすさを分けて記録します。[MIT](LICENSE)、[出典と依存ライセンス](docs/PROVENANCE.md)。
