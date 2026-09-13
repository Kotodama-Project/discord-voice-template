#!/usr/bin/env node
import {parseArgs} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {check,atomicJson,errorCode} from '../src/common.mjs';
import {DEFAULT_APPLICATION_NAME,applicationName} from '../src/onboarding.mjs';

const permissions=(1n<<10n)|(1n<<11n)|(1n<<15n)|(1n<<16n)|(1n<<20n)|(1n<<21n)|(1n<<25n);
export const defaultApplicationName=DEFAULT_APPLICATION_NAME;
export const validateApplicationName=applicationName;
export function invitation(applicationId,guildId){check(/^\d{5,24}$/.test(applicationId)&&/^\d{5,24}$/.test(guildId),'DISCORD_ID_REQUIRED');return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${permissions}&guild_id=${guildId}&disable_guild_select=true`;}
export function setupSteps(){return [
  {step:'local_prepare',owner:'automation',description:'依存関係、private設定、診断、専用ブラウザを用意する。'},
  {step:'login',owner:'human',humanRequired:true,category:'identity',resumeWhen:'authenticated portal state is observed',description:'Discordへのログインは必ず本人が行う。エージェントは画面の準備・案内・完了後の読戻しまでを行い、パスワード入力やログイン確定を代行しない。求められる2FAやCAPTCHAも本人が完了する。'},
  {step:'application',owner:'automation_then_human',description:'新しいApplicationの名前と対象を用意する。規約への同意・本人操作が要求される最終操作は人が行う。'},
  {step:'token',owner:'human',description:'Bot tokenを生成する本人確認を行い、チャットを使わず実行ホストの非公開環境設定へ保存する。'},
  {step:'gateway_intents',owner:'automation_then_human',description:'Message Contentと必要な権限を具体化する。アクセス拡大への確認が必要な画面は人が確定する。'},
  {step:'invite',owner:'automation_then_human',description:'対象固定・AdministratorなしのURLを生成し、サーバー管理者が内容を確認して認証する。'},
  {step:'codex_login',owner:'human',humanRequired:true,category:'identity',description:'仕事の実行器が未認証・失効している場合は、本人がCodex CLIのブラウザログインを行う。有効な認証は再利用する。'},
  {step:'verify',owner:'automation',description:'新しいBotのID・guild・チャンネル権限を読み戻し、コマンド登録とテキストの一巡を確認する。'},
  {step:'privacy_operation',owner:'human_responsibility',humanRequired:false,category:'privacy',description:'説明・同意確認は人間側が責任を持つ。既定ではBotの同意クリックを必須にせず、設定した処理対象で接続・モード切替・停止・成果を確認する。本人の明示的な停止は尊重する。'}
];}
export async function verifyInstallation({applicationId,guildId,token,fetcher=fetch}){
  invitation(applicationId,guildId);check(token,'DISCORD_CREDENTIAL_REQUIRED');
  const get=async route=>{const response=await fetcher('https://discord.com/api/v10'+route,{headers:{authorization:'Bot '+token},redirect:'error',signal:AbortSignal.timeout(10000)});return {status:response.status,data:response.ok?await response.json():null};};
  const app=await get('/oauth2/applications/@me');check(app.status===200,'DISCORD_CREDENTIAL_NOT_VERIFIED');check(app.data.id===applicationId,'BOT_APPLICATION_MISMATCH');
  const user=await get('/users/@me');check(user.status===200&&user.data.bot===true&&user.data.id===applicationId,'BOT_TOKEN_REQUIRED');
  const result={ok:false,verifiedAt:new Date().toISOString(),applicationId,botId:user.data.id,guildId,applicationVerified:true,guildVerified:false,messageContentEnabled:Boolean(Number(app.data.flags)&((1<<18)|(1<<19))),channels:[],posted:false,voiceConnected:false};
  const guild=await get('/guilds/'+guildId);
  if([403,404].includes(guild.status))return {...result,stage:'guild_authorization',humanRequired:true,category:'access_grant',next:'新しいBotと追加先サーバーを確認し、招待ページで本人が認証してください。'};
  check(guild.status===200&&guild.data.id===guildId,'DISCORD_GUILD_READBACK_FAILED');result.guildVerified=true;
  const channels=await get('/guilds/'+guildId+'/channels');check(channels.status===200&&Array.isArray(channels.data),'DISCORD_CHANNEL_READBACK_FAILED');
  return {...result,ok:true,stage:'connected_readonly',humanRequired:false,channels:channels.data.map(c=>({id:c.id,name:c.name,type:c.type})),next:'private設定へチャンネルを反映してコマンド登録と実際の依頼を確認してください。'};
}
async function main(){
const {values:o,positionals}=parseArgs({options:{app:{type:'string'},guild:{type:'string'},output:{type:'string'},'token-env':{type:'string',default:'DISCORD_BOT_TOKEN'},json:{type:'boolean'}} ,allowPositionals:true});
const command=positionals[0]??'steps';
try{
  if(command==='steps')console.log(JSON.stringify({applicationName:validateApplicationName(defaultApplicationName),steps:setupSteps()},null,2));
  else if(command==='invite')console.log(JSON.stringify({applicationId:o.app,guildId:o.guild,permissions:permissions.toString(),administrator:false,url:invitation(o.app,o.guild)}));
  else if(command==='verify'){
    const result=await verifyInstallation({applicationId:o.app,guildId:o.guild,token:process.env[o['token-env']]});
    if(o.output)await atomicJson(path.resolve(o.output),result);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;
  }else throw new Error('UNKNOWN_SETUP_COMMAND');
}catch(e){console.log(JSON.stringify({ok:false,error:errorCode(e)}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
