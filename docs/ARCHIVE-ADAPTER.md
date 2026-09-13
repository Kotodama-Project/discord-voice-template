# 保存音声adapter候補

`src/archive-adapter.mjs`は48kHz mono PCM16を話者・source ID・session開始からのsample位置で受け取り、SQLite journalへ同期保存する。既存Task ownerにはならない。Liveへの音声送信・発話・入退室は変更しない。

## 呼出し契約

1. `new ArchiveAdapter({journalPath,authorize,sink,asr,correct,recordIntent,limits})`。全adapter必須で既定の外部送信先なし。journalPathは既存archive ownerが管理するprivate stagingに置く。ownerが排他leaseを保持している間だけ1instanceを動かす。
2. `begin({sessionId,guildId,channelId,startedAtMs,sampleRateHz:48000,channels:1,sampleFormat:'s16le',speakerIds,sourceRef,retentionPolicyRef})`。
3. 受信側で話者を検証して`append({sessionId,speakerId,sourceId,startFrame,pcm})`。source IDは同一フレーム配送を識別できる安定値。同speakerの時間逆行/重複区間を拒否し、同source再送はbytes一致時だけ無作用。24kHz PCMを48kHzとして渡してはいけない。
4. 受信を停止・drainし、最後に受け取ったsample以上の`endFrame`で`seal(sessionId,endFrame)`。即時durable queue化。無人退出はこの完了後にtransportを解放する。appendより先にsealすると以後の音声は拒否される。
5. 別の低優先度workerで`processNext()`。並列1。失敗時はqueuedを保持し、次回呼出しまたは再起動から再開する。自動無制限retryは行わない。

## 既存系との接続

既存recorderは48kHz/mono、`session_start_silence_padded`で、話者別mp3と`mixed.mp3`を保存する。`speakers.json`のfile0はmixed、以後は対応speaker ID。`metadata.json`はsessionId/channelId/guildId/startedAt/endedAt/participantsとtimelineを保持する。本adapterは同じsample alignmentのtracks/mixedとsourceChunksを` sink.seal`へ渡す。既存ownerのencoderとstaging→rename処理でその契約へ書き出すこと。新しい保存先や第二のarchive台帳は作らない。

`sink.seal`はidempotencyKeyで再照合でき、同じkeyを返す `{sessionId,archiveRef,idempotencyKey}` を返す。書込成功後journal更新前に落ちても、sink自身が二重保存を防ぐ必要がある。保存権限はsinkでもrename直前に照合する。`archive-host.mjs`の`createArchiveSink`がこの処理を実装している。

ASR callbackは個別tracksを逐次処理し、最後にmixedを処理する。戻り値は`[{idx,start,end,text,confidence,speaker_id?}]`。時刻はsession開始からの秒。個別の話者IDは入力トラックから固定し、mixedにspeakerを割り当てない。現在の短文LocalAsrはtextのみを返すため、この区間付き契約の代替にはならない。

訂正callbackには個別rawとmixed contextを渡す。返却は`[{speaker_id,idx,start,end,before,after,reason,confidence}]`。話者/idx/時刻/before不一致は拒否、rawは変更せず別のcorrected出力へ保存する。既存のspeaker-preserving refinerは`refineSpeakerPreserving(rawSegments,mixedSegments,candidates,vocabulary)`であり、別途local Whisperの再decode候補と信頼性条件を要求する。ここでの構造検証だけでは訂正品質や完全なrefiner採用を証明しない。

`recordIntent`は訂正済み出力を既存Intent ownerへ渡し、同じidempotencyKeyとreceiptRefを返す。これは明示実行権限ではない。受信成功後応答喪失時もownerで冪等性を保つ。

## 保持・上限・再開

`authorize(binding,phase)`は同期のtrueだけを許可。capture/seal/process/persist/asr/correct/intentで現在の範囲とretentionを確認する。取消後の処理は拒否する。既存retention ownerがjournal（PCM/raw/derivedを含む）とarchiveを一緒に期限管理・削除する必要がある。adapter自身は削除しない。上限到達は入力を黙って捨てず例外を返すため、呼出側はcaptureを停止または短いsegmentへrotateする。

journal内のPCMは後処理再開用staging。実sinkの`verify`で全保存音声のhashとretention有効期限を確認してから、そのsessionのPCM行を削除し、secure_deleteとWAL checkpoint/TRUNCATEを実行する。archive側のlossless PCMとMP3だけが原音の正本となる。後処理再開は保存済みreceiptから行う。maxSessionsは未完sessionを数え、総PCM上限はstagingに残る音声を数える。録音中の再起動はcapturingを保持するが、セッション再開/中断sealの判断はhostが行う。

## 実host adapter

`createArchiveSink({archiveRoot,ffmpeg,authorize,timeoutMs,maxEncodedBytes,maxPcmBytes,clock})`は既存のrecordings rootを必須にし、その直下へ`session-*`を作る。原音は`mixed.pcm`/speaker別`.pcm`とMP3。ffmpegは既存実行器でshellなし・時間/出力上限付き。metadata/speakers/sourceChunks/receiptを同期保存後renameする。失敗stagingは調査用に残し、任意pathを削除しない。hostが既存の保持/失敗staging回収の対象へ登録すること。

既存30日raw-retentionは`metadata.json.endedAt`、`transcript.json.status=succeeded`、hash付き`knowledge-source-transcript-*.json`、`.ct202-local-grant-<session>.json.artifact_manifest`を読む。このsinkは同名manifestにPCM/MP3のref/size/sha256を記録するが、schemaはretention manifest、`authorityGranted:false`であり転送grantを偽造しない。CT202送信権限はauthorizeで別に判断する。hostは既存保持policy `kotodama.voice-retention/v2`（rawAudioDays=30、transcriptDays/derivedTextDays=null）へ同rootを設定する。既存retentionは文字起こし成功を確認できない場合削除を止めるため、ASRが永続失敗した録音と失敗stagingは保持ownerが別途処理する必要がある。このadapterだけで保持処理が稼働したとはしない。

`createWhisperArchiveAsr({sink,endpoint,authorize,language,timeoutMs})`はhost指定のCT202 `/transcribe` URLへ、検証済みMP3をmultipart `audio`/`language`でPOSTする。redirect拒否・response8MiB上限・timeout。区間start/end/textを保持し、idxは応答順、confidenceはexp(avg_logprob)、欠落時は既存clientと同じ0.8。個別speakerの名乗り不一致は拒否。URLは秘密の固定値を同梱しないのでhostがCT202 allowlistと一致を確認する。

`createLunaArchiveCorrector({command,cwd,dataDir,authorize,vocabulary})`は既存Codex CLI実行器と`gpt-5.6-luna`を使い、raw個別+mixed+語彙から型付きeditsを取得する。話者/idx/時刻/beforeは厳密照合。元の再decode品質判定とは別のLLM訂正候補であり、音響再decodeの認証済み証拠を作らない。モデル呼出しの権限と予算はhost側で束縛する。

encoder失敗は同一idempotencyKeyのstagingを残して停止し、次回も同じ場所が存在する限り明示復旧待ちとなる。retryのたびに新しい原音コピーを増やさない。既存録音/別jobを削除する復旧は実装していない。

`createArchiveIntentRecorder({store,analyzer,sink,authorize})`は既存Storeへ安定Source IDでingestし、analyzerから得た意図をsaveIntentsする。Task生成/実行は行わない。bindingにactorId/readers（本人を含む）を追加する。raw transcript、同bytesのknowledge snapshot、fused.json、意図receiptを既存session内に書く。既存receipt再送は現在scope/sourceを検査して返す。

## 確認範囲

合成試験で最後のsample、共通時刻、mixed overlap、再送、誤話者、訂正時刻、再起動再開、取消、上限を検査。実ffmpeg、実HTTP fixture、CLIモデルfixture、既存Storeを通して原音保存→journal PCM解放→後処理再起動→Intent記録を検査する。既存CT200 sourceをread-only確認して契約を参照した新規MIT候補。既存private sourceを丸ごと移植していない。実CT202/Luna応答、音声の実聴、retentionの本番削除、分散排他、public Task ownerへの実配線は未受入。rootの統合・配備作業が必要。

既存のraw-retention実装を合成sessionに対して実行し、29日目は削除対象0、31日目はPCM/MP3の6ファイルだけ削除、text削除0、再実行削除0を確認した。認証grantを発行した試験ではない。
