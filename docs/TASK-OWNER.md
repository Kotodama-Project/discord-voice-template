# Task owner

既定は`owner.kind=local`です。インストール先のSQLiteを一つのTask ownerとして使います。JSON/CLIの`task.id`は不変で、訂正と再開は同じIDの新しいrevisionになります。

`owner.kind=remote`を選ぶ場合、接続先は次のprivateサービス契約を実装してください。ローカルTaskへのfallbackや二重書込はしません。既存の組織版ownerにこの契約を接続するadapterが必要です。

`POST /v1/owner`、Bearer認証、入力`{version:1,method,args}`、成功`{version:1,ok:true,result}`。

扱うメソッドは `ingest`、`source`、`createTask`、`reviseTask`、`task`、`taskInternal`、`tasks`、`claim`、`bindContext`、`assertContext`、`finish`、`cancel`、`confirmStop`、`resume`。これは信頼済みサービス間の契約であり、一般利用者へそのまま公開するAPIではありません。

sourceはprovider/guild/channel/source ID、actor、readers、revision、本文、finalityを保持します。Taskには依頼元と実行に使用したすべてのcontext sourceを束縛します。ownerは現在の本人・権限・出典を検査し、CAS・重複抑止・取消を永続化します。

実行の候補状態はqueued/running/needs_review/failed/stopping/cancelled/stale/uncertainです。`needs_review`は利用者が成果を確認できる候補であり、会社側のTask完了やPromotionではありません。組織のlifecycleへの対応は既存ownerが担当します。

成果ファイルはworker hostが所有します。remote構成では、そのhostの認可済みartifact readerを接続する必要があり、別ホストのファイルパスをローカルの実ファイルとして扱いません。

Taskは `intentIds` と全構成操作の `requiredActions` を保持します。複合依頼の代表actionだけで認可せず、実行前・実行中に全操作を現行grantへ照合してください。直接コマンドの操作・title・受入条件もSource fingerprintに束縛し、同じ配送IDの別payloadは拒否します。
