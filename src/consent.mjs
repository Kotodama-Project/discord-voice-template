import {digest} from './common.mjs';
export function voiceNotice(config){
  const text=(config.voice.transcriptSource==='local'?'音声の文字起こしはローカルWhisperで行い、会話応答と訂正・意図整理にはOpenAIを使います。':'音声をOpenAIへ送って文字起こしし、意図・議事録・ToDoを整理します。')+(config.voice.storeAudio?'話者別の原音と全体音声を30日保存し、原文と訂正文を区別します。':'原音は保存しません。')+'文字起こしと仕事の記録は実行ホストに保存し、管理者が保存期間を運用します。閲覧できる参加者・操作者と、許可したCLI実行器が内容を扱います。同意はいつでも取り消せます。仕事の実行権限は別です。'+` 1入力の接続上限は${config.voice.maxSessionSeconds}秒、1日の全体枠は${config.voice.maxDailyAudioSeconds}秒相当です。`+(config.voice.maxTotalAudioSeconds===undefined?'':` このインストールの累計枠は${config.voice.maxTotalAudioSeconds}秒相当です。日付や再起動では増えません。`)+ ' AIの回答用接続も同じ枠に含めます。';
  return {text,id:digest({version:1,text,guild:config.discord.guildId,channel:config.discord.voiceChannelId,operators:[...config.discord.operators].sort(),models:[config.voice.assistModel,config.voice.minutesModel]})};
}
