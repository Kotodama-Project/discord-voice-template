import {Client,GatewayIntentBits,PermissionFlagsBits,ChannelType,MessageFlags} from 'discord.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {check,digest,shortText,sourceIdentity,errorCode,atomicJson} from './common.mjs';
import {voiceNotice} from './consent.mjs';
import {voiceCommand,voiceStatusText} from './voice-control.mjs';
import {NotificationQueue} from './notifications.mjs';
import {resultFiles} from './result-files.mjs';

export const commandDefinition={name:'kotodama',description:'ことだまに相談・依頼し、仕事と音声を操作します',options:[
  {type:1,name:'ask',description:'相談する',options:[{type:3,name:'text',description:'知りたいこと',required:true}]},
  {type:1,name:'do',description:'許可範囲で仕事を実行する',options:[{type:3,name:'action',description:'仕事の種類',required:true,choices:['research','summarize','write_file','develop'].map(v=>({name:v,value:v}))},{type:3,name:'text',description:'やってほしいこと',required:true}]},
  {type:1,name:'tasks',description:'自分の仕事を見る'},
  {type:1,name:'consent',description:'音声処理の運用と、自分の停止設定を確認する'},
  ...['result','stop','resume'].map(name=>({type:1,name,description:{result:'成果を読む',stop:'仕事を止める',resume:'停止した仕事を再開する'}[name],options:[{type:3,name:'task',description:'仕事のID',required:true}]})),
  {type:1,name:'voice',description:'音声モード・録音・発話を操作する',options:[{type:3,name:'mode',description:'操作',required:true,choices:['assist','minutes','join','pause','resume','stop_speech','start_conversation','end_conversation','leave','status'].map(v=>({name:v,value:v}))}]}
]};

export class DiscordAdapter {
  constructor({config,store,pipeline,policy=()=>config,onError=()=>{}}){
    Object.assign(this,{config,store,pipeline,policy,onError});this.voice=null;this.verifiedInstallation=false;
    this.notifications=store.db?new NotificationQueue(store.db,()=>this.policy().notifications?.quietHours,{onError}):null;
    this.client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates]});
    this.client.on('messageCreate',m=>this.message(m).catch(e=>onError(errorCode(e))));
    this.client.on('messageUpdate',(_old,m)=>this.message(m).catch(e=>onError(errorCode(e))));
    this.client.on('messageDelete',m=>this.withdraw(m).catch(e=>onError(errorCode(e))));
    this.client.on('interactionCreate',i=>this.interaction(i).catch(e=>onError(errorCode(e))));
    this.client.on('error',()=>onError('DISCORD_CLIENT_FAILED'));
  }
  operator(actor){check(this.policy().discord.operators.includes(actor),'OPERATOR_REQUIRED');}
  artifactRoot(){return this.config.owner.kind==='local'?path.join(this.config.dataDir,'worktrees'):null;}
  async member(actor){this.operator(actor);const guild=await this.client.guilds.fetch(this.config.discord.guildId);return guild.members.fetch({user:actor,force:true});}
  async canRead(channel,actor){
    try{channel=await this.client.channels.fetch(channel.id,{force:true});const member=await channel.guild.members.fetch({user:actor,force:true});await channel.guild.roles.fetch();const p=channel.permissionsFor(member);if(!p?.has(PermissionFlagsBits.ViewChannel)||!p.has(PermissionFlagsBits.ReadMessageHistory))return false;
      if(channel.type===ChannelType.PrivateThread&&!p.has(PermissionFlagsBits.ManageThreads))await channel.members.fetch({member:actor,force:true});
      return true;
    }catch{return false;}
  }
  async readers(channel){const readers=[];for(const actor of this.policy().discord.operators)if(await this.canRead(channel,actor))readers.push(actor);return readers;}
  async login(){const token=process.env[this.config.discord.botTokenEnv];check(token,'DISCORD_CREDENTIAL_REQUIRED');
    let timer;const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('DISCORD_READY_TIMEOUT')),30000);this.client.once('clientReady',resolve);});
    try{await Promise.all([this.client.login(token),ready]);check(this.config.discord.applicationId&&this.client.application.id===this.config.discord.applicationId,'BOT_APPLICATION_MISMATCH');await this.client.guilds.fetch(this.config.discord.guildId);this.verifiedInstallation=true;this.notifications?.start(async(kind,body)=>{
      if(!this.verifiedInstallation)return {state:'blocked'};
      const task=await this.pipeline.owner.task(body.id,body.actor);if(task.revision!==body.revision)return {state:'stale'};
      return this.deliver(task);
    });}catch(e){await this.client.destroy();throw e;}finally{clearTimeout(timer);}
  }
  async register(){
    check(this.verifiedInstallation,'BOT_INSTALLATION_NOT_VERIFIED');
    const guild=await this.client.guilds.fetch(this.config.discord.guildId);const existing=(await guild.commands.fetch()).find(c=>c.name==='kotodama'&&c.applicationId===this.client.application.id);
    const file=path.join(this.config.dataDir,'discord-command.json');let owned=null;try{owned=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(existing)check(owned?.commandId===existing.id&&owned?.guildId===guild.id,'EXISTING_COMMAND_NOT_OWNED');
    const result=existing?await guild.commands.edit(existing.id,commandDefinition):await guild.commands.create(commandDefinition);
    await atomicJson(file,{commandId:result.id,guildId:guild.id,definitionDigest:digest(commandDefinition)});return {commandId:result.id,guildId:guild.id};
  }
  async source(message,{attachments=true}={}){
    check(message.guildId===this.config.discord.guildId&&!message.author?.bot&&!message.webhookId&&!message.partial,'MESSAGE_NOT_HUMAN');
    const readers=await this.readers(message.channel);let text=message.content??'';const coverage=[];
    if(attachments)for(const a of message.attachments.values()){
      const item={id:a.id,name:a.name,read:false};coverage.push(item);
      if(a.size>4000000||!(/^(text\/|application\/(json|csv))/.test(a.contentType??'')||/\.(txt|md|csv|json)$/i.test(a.name??''))){item.reason='unsupported_or_oversize';continue;}
      try{const url=new URL(a.url);check(url.protocol==='https:'&&['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname),'ATTACHMENT_ORIGIN_REFUSED');const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});check(r.ok,'ATTACHMENT_FETCH_FAILED');
        const reader=r.body.getReader();const chunks=[];let size=0;try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;check(size<=4000000,'ATTACHMENT_SIZE_LIMIT');chunks.push(value);}}finally{await reader.cancel();}
        const bytes=Buffer.concat(chunks);text+='\n\n添付 '+a.name+'\n'+new TextDecoder('utf-8',{fatal:true}).decode(bytes);item.read=true;item.sha256=digest(bytes);
      }catch(e){item.reason=errorCode(e);}
    }
    const current=await this.readers(message.channel);check(readers.every(a=>current.includes(a)),'SOURCE_AUDIENCE_CHANGED');
    return {provider:'discord',guildId:message.guildId,channelId:message.channelId,sourceId:message.id,actorId:message.author.id,readers,revision:message.editedTimestamp??message.createdTimestamp,final:true,text,metadata:{kind:'text',url:message.url,attachments:coverage,createdAt:message.createdAt.toISOString()}};
  }
  async message(message){
    const cfg=this.policy();if(!this.verifiedInstallation||message.guildId!==cfg.discord.guildId||!cfg.discord.textChannelIds.includes(message.channelId)||message.author?.bot||message.webhookId||message.partial)return;
    const source=await this.source(message);const addressed=message.mentions.users.has(this.client.user.id)&&cfg.discord.operators.includes(message.author.id);
    source.metadata.directlyAddressed=addressed;
    await this.pipeline.ingest(source,{execute:addressed,reply:addressed});
  }
  async withdraw(message){if(!this.verifiedInstallation)return;if(message.guildId!==this.config.discord.guildId)return;const key=sourceIdentity({provider:'discord',guildId:message.guildId,channelId:message.channelId,sourceId:message.id});const old=this.store.sourceInternal(key);if(old)await this.pipeline.ingest({...old,revision:Math.max(Date.now(),old.revision+1),text:'',withdrawn:true,metadata:{...old.metadata,withdrawalActorUnknown:true}},{execute:false});}
  interactionSource(i,text){return {provider:'discord',guildId:i.guildId,channelId:i.channelId,sourceId:i.id,actorId:i.user.id,readers:[i.user.id],revision:i.createdTimestamp,final:true,text,metadata:{kind:'command'}};}
  async interaction(i){
    if(this.verifiedInstallation&&i.guildId===this.config.discord.guildId&&(i.isButton?.()&&i.customId.startsWith('kotodama-consent:')||i.isChatInputCommand()&&i.commandName==='kotodama'&&i.options.getSubcommand()==='consent')){await this.consentInteraction(i);return;}
    if(!this.verifiedInstallation||!i.isChatInputCommand()||i.commandName!=='kotodama'||i.guildId!==this.config.discord.guildId)return;
    await i.deferReply({flags:MessageFlags.Ephemeral});
    try{this.operator(i.user.id);await this.member(i.user.id);const sub=i.options.getSubcommand();let text;
      if(sub==='do'){const request=i.options.getString('text',true),action=i.options.getString('action',true);const t=await this.pipeline.request(this.interactionSource(i,request),{title:request.slice(0,120),request,action});text=`受け付けました。\n${t.id}\n結果はこの仕事の「result」で確認できます。`;}
      else if(sub==='ask'){const source=this.interactionSource(i,i.options.getString('text',true));source.metadata.operation='ask';const receipt=await this.pipeline.ingest(source,{execute:false,reply:false});for(const b of receipt.contextSources??[]){const s=this.store.source(b.key,i.user.id);check(s.revision===b.revision,'CONTEXT_CHANGED');if(s.provider==='discord'){const channel=await this.client.channels.fetch(s.channelId);check(await this.canRead(channel,i.user.id),'SOURCE_ACCESS_DENIED');}}text=receipt.answer??receipt.summary??'整理しました。';}
      else if(sub==='tasks'){const tasks=await this.pipeline.owner.tasks(i.user.id);const visible=[];for(const task of tasks)try{await this.pipeline.authorize(task,'read_result');visible.push(task);}catch{}text=visible.slice(0,15).map(t=>`${t.id} · ${{queued:'受付済み',running:'実行中',needs_review:'成果確認待ち',stale:'訂正により無効',failed:'失敗',cancelled:'停止済み',stopping:'停止処理中',uncertain:'状態確認中'}[t.state]??t.state}\n${t.title}`).join('\n')||'読取可能な仕事はまだありません。';}
      else if(sub==='result'){const result=await this.pipeline.result(i.options.getString('task',true),i.user.id);const files=await resultFiles(result,{artifactRoot:this.artifactRoot()});await i.editReply({content:shortText(result.summary),files,allowedMentions:{parse:[]}});return;}
      else if(sub==='stop'){await this.pipeline.stop(i.options.getString('task',true),i.user.id);text='停止を受け付けました。実行中の処理の終了を確認しています。';}
      else if(sub==='resume'){const t=await this.pipeline.resume(i.options.getString('task',true),i.user.id);text=`再開しました。${t.id}`;}
      else if(sub==='voice'){check(this.voice,'VOICE_NOT_CONFIGURED');const mode=i.options.getString('mode',true);
        text=voiceStatusText(await voiceCommand(this.voice,mode,{actor:i.user.id}));
      }
      await i.editReply({content:shortText(text),allowedMentions:{parse:[]}});
    }catch(e){await i.editReply({content:`実行できませんでした：${errorCode(e)}`,allowedMentions:{parse:[]}});}
  }
  async consentInteraction(i){
    await i.deferReply({flags:MessageFlags.Ephemeral});
    try{const cfg=this.policy();check(cfg.discord.voiceChannelId,'VOICE_CHANNEL_REQUIRED');const notice=voiceNotice(cfg);const revoke=i.isButton?.()&&i.customId.startsWith('kotodama-consent:revoke:');if(!revoke){const channel=await this.client.channels.fetch(cfg.discord.voiceChannelId);check(await this.canRead(channel,i.user.id),'SOURCE_ACCESS_DENIED');}
      if(i.isButton?.()){const [,action,noticeId]=i.customId.split(':');check(['agree','revoke'].includes(action)&&(action==='revoke'||noticeId===notice.id),'CONSENT_NOTICE_CHANGED');this.store.recordConsent({guild:cfg.discord.guildId,channel:cfg.discord.voiceChannelId,actor:i.user.id,notice:notice.id,granted:action==='agree',interactionId:i.id});if(action==='revoke'){await this.voice?.stopSpeech();const session=this.voice?.sessions.get(i.user.id);if(session)await this.voice.endSession(session,{drain:false});}}
      void this.voice?.control.check();
      const granted=this.store.consent(cfg.discord.guildId,cfg.discord.voiceChannelId,i.user.id,notice.id),managed=cfg.voice.consentMode==='owner_managed',optedOut=this.store.voiceOptedOut(cfg.discord.guildId,cfg.discord.voiceChannelId,i.user.id);
      const status=managed?(optedOut?'本人の希望で停止中':cfg.voice.participantIds.includes(i.user.id)?'人間側が管理する処理対象':'処理対象外'):(granted?'同意済み':'未同意');
      const buttons=managed?(optedOut?[{type:2,style:2,label:'自分の停止設定を解除する',custom_id:'kotodama-consent:agree:'+notice.id}]:[{type:2,style:2,label:'自分の音声処理を停止する',custom_id:'kotodama-consent:revoke:'+notice.id}]):[{type:2,style:1,label:'同意して音声処理を許可',custom_id:'kotodama-consent:agree:'+notice.id},{type:2,style:2,label:'音声処理の同意を取り消す',custom_id:'kotodama-consent:revoke:'+notice.id}];
      await i.editReply({content:`${managed?'プライバシーの説明・同意確認は人間側が責任を持つ運用です。Botの同意クリックは必須ではありません。\n\n':''}${notice.text}\n\nあなたの状態：${status}`,components:[{type:1,components:buttons}],allowedMentions:{parse:[]}});
    }catch(e){await i.editReply({content:`設定できませんでした：${errorCode(e)}`,components:[],allowedMentions:{parse:[]}});}
  }
  async deliver(task){
    if(this.notifications?.quiet()){this.notifications.defer(digest(['task',task.id,task.revision]),'task',{id:task.id,revision:task.revision,actor:task.actor});return {state:'deferred'};}
    await this.pipeline.authorize(task,'read_result');await this.member(task.actor);const source=this.store.source(task.source_key,task.actor);const channel=await this.client.channels.fetch(source.channelId);check(await this.canRead(channel,task.actor),'SOURCE_ACCESS_DENIED');
    const key=digest([task.id,task.revision,'result']);const text=`仕事の成果ができました（確認待ち）。\n${task.id}\n${task.result.summary}`;
    const files=await resultFiles(task.result,{artifactRoot:this.artifactRoot()});await this.pipeline.authorize(task,'read_result');
    if(!this.store.claimDelivery(key,text))return;
    try{const user=await this.client.users.fetch(task.actor);const message=await user.send({content:shortText(text),files,allowedMentions:{parse:[]}});this.store.delivered(key,message.id);}catch{this.onError('RESULT_DELIVERY_UNKNOWN');}
  }
  async reply({source,text,contextSources=[]}){
    for(const b of contextSources){const s=this.store.source(b.key,source.actorId);check(s.revision===b.revision,'CONTEXT_CHANGED');}if(source.metadata?.kind==='voice'){
      await this.voice?.speak(text,{epoch:source.metadata.voiceEpoch,actorId:source.actorId,bindings:contextSources,authorizeAudience:async actors=>{for(const actor of actors){const channels=new Set();for(const b of contextSources){const s=this.store.source(b.key,actor);check(s.revision===b.revision,'CONTEXT_CHANGED');if(s.provider==='discord')channels.add(s.channelId);}for(const channelId of channels){const channel=await this.client.channels.fetch(channelId);check(await this.canRead(channel,actor),'SOURCE_ACCESS_DENIED');}}return actors;}});return;}
    await this.member(source.actorId);
    const channel=await this.client.channels.fetch(source.channelId);check(await this.canRead(channel,source.actorId),'SOURCE_ACCESS_DENIED');const user=await this.client.users.fetch(source.actorId);await user.send({content:shortText(text),allowedMentions:{parse:[]}});
  }
  async voiceAction({source,action}){await this.voice?.applyModelAction(action,source);}
  async backfill(actor,{limit=10000,signal}={}){
    await this.member(actor);const guild=await this.client.guilds.fetch(this.config.discord.guildId);const all=await guild.channels.fetch();const channels=new Map([...all.values()].filter(c=>c?.isTextBased()&&!c.isThread()).map(c=>[c.id,c]));
    const coverage={startedAt:new Date().toISOString(),channels:[],imported:0,limit,complete:false};
    const active=await guild.channels.fetchActiveThreads();for(const c of active.threads.values())channels.set(c.id,c);
    for(const parent of [...channels.values()].filter(c=>c.threads)){
      for(const category of ['public','joined_private']){let before;
        try{while(true){check(!signal?.aborted,'CANCELLED');const route=category==='public'?`/channels/${parent.id}/threads/archived/public`:`/channels/${parent.id}/users/@me/threads/archived/private`;
          const query=new URLSearchParams({limit:'100',...(before?{before}:{})});const page=await this.client.rest.get(route,{query});
          for(const raw of page.threads){const channel=await this.client.channels.fetch(raw.id);if(channel)channels.set(channel.id,channel);}
          if(!page.has_more||!page.threads.length)break;const last=page.threads.at(-1);before=category==='public'?last.thread_metadata.archive_timestamp:last.id;
        }}catch(e){coverage.channels.push({id:parent.id,kind:category,state:'unavailable',reason:errorCode(e)});}
      }
    }
    for(const channel of channels.values()){
      check(!signal?.aborted,'CANCELLED');if(!(await this.canRead(channel,actor))){coverage.channels.push({id:channel.id,state:'not_authorized'});continue;}
      let before,count=0,state='complete';
      try{while(true){check(!signal?.aborted,'CANCELLED');if(coverage.imported>=limit){state='limit_reached';break;}const pageLimit=Math.min(100,limit-coverage.imported),page=await channel.messages.fetch({limit:pageLimit,...(before?{before}:{})});if(!page.size)break;
        for(const message of page.values()){if(message.author.bot||message.webhookId)continue;const source=await this.source(message);this.store.ingest(source);count++;coverage.imported++;}
        before=page.last().id;if(page.size<pageLimit)break;
      }}catch(e){state='failed';this.onError(errorCode(e));}
      coverage.channels.push({id:channel.id,state,count});
    }
    coverage.complete=coverage.channels.every(c=>['complete','not_authorized'].includes(c.state))&&coverage.imported<limit;coverage.finishedAt=new Date().toISOString();
    await atomicJson(path.join(this.config.dataDir,'latest-import-coverage.json'),coverage);return coverage;
  }
  async close(){this.verifiedInstallation=false;await this.notifications?.stop();await this.voice?.dispose();await this.client.destroy();}
}
