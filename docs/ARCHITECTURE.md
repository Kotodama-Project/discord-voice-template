# 構成

Discordのテキスト・音声 → 出典と版 → 意図・ToDo → 明示依頼 → CLI実行器 → 検証済み成果。

既定の `assist` / `naturalConversation: true` は発話開始時にGPT-Live会話を開き、その話者との複数ターンで同じWebSocketを使います。GPT-Liveは自然会話を担当し、Luna backendは状態・資料・終了判断などを委譲で扱います。`naturalConversation: false` ではLunaの確認済み結果を同じLiveセッションのcommentaryへ返します。`minutes` はVADと専用文字起こしを使い、音声を返しません。いずれも意図抽出器とTask ownerへの明示依頼経路は会話出力から分離します。

`voice.transcriptSource: "live"` はGPT-Liveの入力transcriptを低遅延会話に使います。`"local"` ではDiscordの話者別PCMをローカルASRへ渡し、その確定した日本語テキストをSource Evidenceにします。呼びかけ前の発話は保存だけを行い、Live・Luna・Task実行を開始しません。呼びかけ時は確定テキストをLiveの開始履歴へ入れ、その後の音声は同じ話者のLiveセッションへ流します。どちらを選んでも、録音を有効にすれば別の48kHz archive経路へ原音を送り、Live transcript deltaをWhisper全文の代用にはしません。

単体構成はNode.jsとSQLiteで動きます。組織構成ではremote Task ownerを選びます。

参照した既存候補：Kotodama-project PR #69の部屋別契約、#71の発話制御、#59の文脈と入力の束縛、#67のCLI実行証拠。大きなPR stackやprivate runtimeのソースを丸ごとコピーせず、このテンプレートのコードを新規作成します。参照PRの未受入部分を配備済みと表示しません。

原音の永続保存は既定で行いません。有効時は参加者別track、再生queueへ受け入れたGPT-Live返答のassistant track、全trackのmixedを同じtimelineに保存します。Whisper原文、時刻順の訂正文、資料と仕事の履歴はインストール先のprivate data directoryに保持します。録音・外部処理への同意、閲覧範囲、モデルと費用上限を初回に設定し、停止・取消を実行時に照合します。assistant trackは生成済み・再生受付済み音声の証拠で、割り込み時の実聴完了receiptではありません。全文Sourceには全trackを時系列で残しますが、Intent候補の解析入力は`archive.actorId`本人のtrackだけに限定し、他参加者やassistantの発話を本人の依頼へ変換しません。

固定VCの自動入退室は、一つの直列化した音声制御が扱います。起動時、対象VCの入退室イベント、10秒間隔で人間の在室と現在の対象範囲を照合します。Botは人数に含めません。対象外の参加者がいる間は、新しい音声処理・再生を止めて退出します。手動停止の設定はSQLite内のVC別設定で保持し、仕事の台帳を増やしません。

接続待ちと復旧待ちは接続個体に結び付けます。停止・設定取消・終了後に遅い接続が復活したり、新しい接続を古い失敗処理が破棄したりしません。終了時の文字起こしは旧epochの出典として確定し、その出典から実行・音声回答を再開しません。

Discord再生はLive出力と別の世代・閲覧許可・source revisionに束縛します。利用者の発話開始、権限変更、mode変更、queue overflowではplayerと未再生PCMを先に破棄します。Liveには停止指示を送りますが、そのACKを再生停止の証明には使いません。音声会話終了はLiveセッションだけを閉じ、既に許可されたTaskは取り消しません。
