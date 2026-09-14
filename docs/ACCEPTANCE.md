# 確認状況

この文書は実装候補の受入境界です。ローカル試験で実サービスの成功を代用しません。

| 範囲 | 状態 |
|---|---|
| 出典の版・訂正・閲覧制限、意図と実行の分離 | ローカル回帰試験 |
| CLI子プロセス→実HTTP→Task→成果ファイルの読戻し | 合成入力・合成モデルの実プロセス試験 |
| 同一Liveセッションでの複数回答、commentary返却、割り込み、未許可音声の破棄 | SDK・Discord player注入fixture試験 |
| ローカルASRのWAV境界、日本語確定テキスト、呼びかけ前Live 0件、呼びかけ後の継続 | HTTP・音声stream注入fixture試験 |
| Luna Responses analyzerの`store:false`、retry 0、厳密schema、context/output上限、token usage、エラー本文非露出 | SDK注入fixture試験。実APIの構造化応答は別に確認 |
| Liveの累積秒snapshotと`session.closed`最終値を加算せず保存 | SDK注入fixture試験 |
| 音声API残高不足の分類、重複通知防止、停止の再起動保持 | 両SDKのエラーを注入したローカル回帰試験。残高補充後の実音声は未受入 |
| 固定VCの自動入退室、無人猶予、手動停止の再起動保持、接続競合・復旧 | 接続注入fixtureによるローカル回帰試験。実Discordの入退室・復旧は未受入 |
| Linuxでのコード変更・Git差分・検証コマンド | 合成課題を実Luna/Codex CLIで実行し、差分・テスト・hash読戻し成功 |
| 実Discordの登録・コマンド表示・成果配送 | 専用Bot登録、実メッセージ→意図→Task→変更・テスト→成果DMのhash読戻し成功。入力はCLIによる接続試験で、利用者の満足確認は別 |
| 2人・30分の実音声、モード切替、実聴 | 未受入 |
| 実VCでの割り込み停止時間、120ms prefillの途切れ・体感遅延、500ms queue上限 | 未受入 |
| 参加者別原音・GPT-Live返答track・全体音声の保存、OpenAI API・ローカルWhisper両方式の全文文字起こし、時系列export | Live/local入力と再生受付音声を使う保存パイプライン、OpenAI multipartと全文text fallback、話者時系列、制限付きexportはfixture試験。実聴完了範囲、OpenAI本番APIでの実音声文字起こしは未受入 |
| 公開テンプレートとして別設定で再現 | 未受入 |

`offline_fixture`は合成試験の表示です。設定にIDやモデル名があるだけで接続済みとは表示しません。CIは実音声・APIキー・Discord tokenを使いません。

2026-09-13の限定実行確認では、合成の開発課題をtrusted CLIから投入し、Lunaが実ファイルを変更しました。Discordの画面操作による確認はエージェントがCLI経由で行ったもので、人による満足・音声同意の証拠とは区別します。ローカルモデルのfallbackはprimaryの起動失敗を模した条件で、実モデルのCLIツール操作・ファイル変更・テスト・成果hash読戻しまで確認しました。Discordの後続訂正でも同じTask IDの新版でREADME作成とコード修正が成功しています。
