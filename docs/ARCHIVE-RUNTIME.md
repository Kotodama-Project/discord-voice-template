# ArchiveRuntime初期化と呼出し

VoiceRoomの48kHz受信とGPT-Liveの再生受付音声に接続済み。archiveを明示設定しvoice.storeAudioを有効にしたlocal ownerで使用する。`voice.transcriptSource` は `live` / `local` のどちらでもよく、既定のLive会話に録音を足すためだけにリアルタイム用ローカルASRを要求しない。journalPathはdataDir内の絶対path、archiveRootは既存保存先の絶対pathに限定する。既定では録音しない。

保存用Whisperの送り先は `whisperProtocol` で選ぶ。`local`（既定）はloopback、private LAN、またはtailnet hostに束縛する。`openai`は `https://api.openai.com/v1/audio/transcriptions` 固定で、`whisperModel`（既定 `whisper-1`）と `whisperApiKeyEnv` が指す環境変数のキーを使い、multipart `file`・`response_format=verbose_json`・segment timestampsで呼ぶ。segmentが省略され全文textだけ返った場合も、録音区間全体の一segmentとして保持する。それ以外の外部送信先は設定できない。`whisperTimeoutMs` で1回あたりの上限を調整する。

```js
import {ArchiveRuntime} from './archive-runtime.mjs';

// hostが既存outputDir、identity、現在のACLと利用上限から組み立てる。
const archiveConfig = {
  ...config,
  owner: {kind: 'local'}, // remote ownerへ強制変更してはいけない
  archive: {
    enabled: true,
    archiveRoot: existingRecordingsOutputDir,
    journalPath: existingPrivateStagingJournalPath,
    retentionPolicyRef: currentRetentionPolicyRef,
    sourceRef: currentCaptureSourceRef,
    actorId: operatorId,
    readers: authorizedReaders,
    captureAssistantAudio: true,
    assistantSpeakerId: 'kotodama-assistant',
    ffmpeg: installedFfmpegExecutable,
    whisperProtocol: 'local',
    whisperEndpoint: privateWhisperTranscribeUrl,
    batchMs: 250,
    rotationMs: 55000,
    maxPendingSessions: 16,
    maxPcmBytes: 128 * 1024 * 1024,
    canProcess: false,
  },
};
const archive = new ArchiveRuntime({
  config: archiveConfig,
  policy: () => ({
    ...currentConfig,
    archive: {...archiveConfig.archive, ...currentArchivePolicy,
      canProcess: roomIsEmpty || hostLoadIsLow},
  }),
  store: existingLocalStore,
  analyzer: existingAnalyzer,
  authorize: (binding, phase) => currentSynchronousArchiveGrant(binding, phase),
  readEnv: name => process.env[name],
  onError: code => recordArchiveDiagnostic(code),
  onUsage: usage => recordArchiveUsage(usage),
});

// 既存receiverが検証した話者ID。元の48kHz mono PCM16を使う。
archive.append(speakerId, pcm48Mono, packetWallTimeMs);

// 在室/負荷が後処理可能へ変わったとき。内部で並列1へまとめる。
void archive.processPending().catch(handleArchiveError);

// receiver停止/drain後、最後のbatchをflushし永続queueへseal。
archive.stopCapture();
// 退出してもpending workerのobjectは保持して後処理を継続できる。
// 次回captureは新しいRuntimeを作る前に旧Runtime.close完了を待つ。
await archive.close();
```

必須の通常configは`installation`、`agentBinding.agentId/vmId`、`discord.guildId/voiceChannelId/operators`、`voice.participantIds`、`analyzer`、`worker.workspace`、`dataDir`、`owner.kind=local`。archive.actorIdはoperatorsに含め、readersはactorを含む。既定の`captureAssistantAudio:true`では、参加者IDと重複しない`assistantSpeakerId`をGPT-Live返答trackに使う。このIDは参加者の音声処理・資料閲覧・実行権限を付与しない。policyは同じconfig形状を返し、現在のspeaker/readers/actor・保存先・保持policy・source・VM/agentを再照合する。`authorize`は同期booleanで、Promiseを権限として認めない。30日保持の既存owner登録もrootが行う。

Responses訂正はconfig.analyzerのkind=responses/model=gpt-5.6-luna/apiKeyEnv/baseUrl/timeoutSeconds/maxOutputTokensを再利用。API keyは呼出時にreadEnvで読む。strict JSON、reasoning low、store false、retry0、truncation disabled、出力256〜8000tokensの上限。SDKfixtureで検証し実API利用はしていない。CLI設定の場合は既存CLI経路も保持する。

appendは受信を所有せず、最大1秒分のpacketを受け、最大250ms分ずつjournalへまとめる。同speakerのwallTime逆行は拒否、共通session開始から48k sample位置へ変換する。イベントループが動いている間のbatch目標であり、電源断では未flushの最大約250msが失われ得る。正常退出の最後batchはstopCapture/closeで必ずflushする。

通常55秒、設定最大60秒でrotation。packetが境界をまたぐ場合は最大packet分だけ旧区間へ含め、次packetで新sessionへ移る。captureは後処理をawaitしない。無人/低負荷はhostのcanProcessがtrueのときだけで、省略はfalse扱い。負荷が再び高くなったら次の後処理段階/次jobを停止し、すでに送信したHTTP/model処理は取消済みと偽らない。startupはqueuedだけを再開する。crash時capturingはhostが最終durable frameを照合してsealするまで保持。

maxPendingSessionsは未完だけを数える。doneは上限から外れ、raw PCMはsink検証後journalから解放する。1人sessionは個別とmixedが同一で、ASRは個別1回だけ、`mixedDerivedFromIndividual:true`をraw snapshotへ保持。digital silenceの新規sessionを作らず、保存trackが全zeroの場合もASRを呼ばない。空rawは訂正もIntentモデルも呼ばない。

remote ownerは明示エラーで停止する。第二のIntent ownerへ書かない。既存Store/analyzerを使い、sourceとIntentだけを記録し、このmoduleからTaskを実行しない。

実装は未完のqueue数とjournal PCMを別に制限する。1jobの展開PCM上限とは別にjournal上限を設定できる。正常退出では即座に切断して保存を続け、再起動時capturingは最後の永続frameまでsealする。未flush音声を存在したと主張しない。既存の記録は削除せず、会話コンテクストでは対応する保存版が揃った速報文字起こしを重複投入しない。
