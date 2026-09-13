import {readProjectContext} from './project-context.mjs';
import {SpeechAdmission} from './speech-admission.mjs';
import {Readable} from 'node:stream';
import OpusScript from 'opusscript';
import {joinVoiceChannel,entersState,VoiceConnectionStatus,EndBehaviorType,createAudioPlayer,createAudioResource,StreamType,NoSubscriberBehavior} from '@discordjs/voice';
import {VoiceProvider,pcm48StereoTo24Mono,pcm24MonoTo48Stereo,pcm48StereoToMono} from './voice-providers.mjs';
import {LocalAsr} from './local-asr.mjs';
import {TranscriptTurns} from './transcripts.mjs';
import {voiceNotice} from './consent.mjs';
import {check,uid,errorCode} from './common.mjs';
import {VoiceControl} from './voice-control.mjs';

const voiceBinding=config=>JSON.stringify({installation:config.installation,agentBinding:config.agentBinding,applicationId:config.discord.applicationId,workspace:config.worker.workspace,owner:config.owner,storeAudio:config.voice.storeAudio,archive:config.archive,naturalConversation:config.voice.naturalConversation,conversationStart:config.voice.conversationStart,transcriptSource:config.voice.transcriptSource,assistModel:config.voice.assistModel,minutesModel:config.voice.minutesModel,localAsr:config.voice.transcriptSource==='local'?config.voice.localAsr:null});
function audible(pcm){for(let i=0;i<pcm.length;i+=2)if(Math.abs(pcm.readInt16LE(i))>96)return true;return false;}
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function addressed(text,config){return config.voice.wakeWords.some(word=>new RegExp(`(?:^|[、,。.!！?？\\s])${escaped(word)}(?:[、,。.!！?？\\s]|$|(?:あ|ねえ|えっと)?(?:こんにちは|こんばんは|おはよう|聞こえ|きこえ|教えて|おしえて|お願い|調べて|確認して|どう思う))`,'i').test(text));}

export class VoiceRoom {
  constructor({client,config,store,pipeline,policy=()=>config,onError=()=>{},sourceReaders=async()=>[],providerFactory=o=>new VoiceProvider(o),localAsrFactory=o=>new LocalAsr(o),connectionFactory=joinVoiceChannel,waitForState=entersState}){
    Object.assign(this,{client,config,store,pipeline,policy,onError,sourceReaders,providerFactory,localAsrFactory,connectionFactory,waitForState});
    this.target=Object.freeze({guildId:config.discord.guildId,voiceChannelId:config.discord.voiceChannelId});this.voiceBinding=voiceBinding(config);
    this.sessions=new Map();this.draining=new Set();this.localCaptures=new Map();this.localStates=new Map();this.localAsrTail=Promise.resolve();this.localAsrPending=0;this.mode=config.voice.mode;this.connection=null;this.paused=false;this.reply=null;this.generation=0;this.epoch=0;this.controlGeneration=0;this.modeChange=null;
    if(config.voice.transcriptSource==='local'&&config.voice.localAsr.apiKeyEnv)check(process.env[config.voice.localAsr.apiKeyEnv],'LOCAL_ASR_CREDENTIAL_REQUIRED');
    this.localAsr=config.voice.transcriptSource==='local'?this.localAsrFactory({...config.voice.localAsr,apiKey:config.voice.localAsr.apiKeyEnv?process.env[config.voice.localAsr.apiKeyEnv]:null}):null;
    this.player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Pause}});
    this.control=new VoiceControl({room:this});
    this.accessChanged=()=>{void this.stopSpeech();};
    for(const event of ['voiceStateUpdate','channelUpdate','guildMemberUpdate','guildMemberRemove','roleUpdate','roleDelete','threadMembersUpdate'])client.on?.(event,this.accessChanged);
  }
  targetMatches(){const cfg=this.policy();return cfg.discord.guildId===this.target.guildId&&cfg.discord.voiceChannelId===this.target.voiceChannelId&&voiceBinding(cfg)===this.voiceBinding;}
  allowed(actor){const cfg=this.policy();if(!this.targetMatches()||this.store.voiceOptedOut(cfg.discord.guildId,cfg.discord.voiceChannelId,actor))return false;return cfg.voice.consentMode==='owner_managed'?cfg.voice.participantIds.includes(actor):this.store.consent(cfg.discord.guildId,cfg.discord.voiceChannelId,actor,voiceNotice(cfg).id);}
  audience(){const channel=this.client.channels.cache.get(this.target.voiceChannelId);return channel?.guildId===this.target.guildId&&channel.id===this.target.voiceChannelId?[...channel.members.values()].filter(m=>m.user?.bot!==true).map(m=>m.id):[];}
  audienceAllowed(){const actors=this.audience();return actors.length>0&&actors.every(actor=>this.allowed(actor));}
  connectionReady(){return this.connection?.state.status===VoiceConnectionStatus.Ready;}
  privacyMatches(s){const cfg=this.policy();return s.privacyBasis===cfg.voice.consentMode&&s.privacyNoticeId===voiceNotice(cfg).id;}
  current(s){return this.connectionReady()&&!s.stopped&&!this.paused&&!this.recovering&&this.audienceAllowed()&&this.audience().includes(s.actor)&&s.epoch===this.epoch&&this.sessions.get(s.actor)===s&&this.allowed(s.actor)&&this.privacyMatches(s);}
  assertBudget(){const cfg=this.policy().voice;this.store.assertAudioAvailable(cfg.maxDailyAudioSeconds,cfg.maxTotalAudioSeconds);}
  reserveAudio(ms,cfg){try{return this.store.reserveAudio(ms,cfg.maxDailyAudioSeconds,undefined,cfg.maxTotalAudioSeconds);}catch(e){if(['AUDIO_BUDGET_EXHAUSTED','AUDIO_TOTAL_BUDGET_EXHAUSTED'].includes(e.code)){this.control.suspend('budget');void this.pause();}throw e;}}
  providerError(code){
    this.onError(code);if(code!=='VOICE_API_CREDITS_EXHAUSTED')return false;
    this.control.suspend('provider_credit');void this.close().catch(e=>this.onError(errorCode(e)));return true;
  }
  async join({shouldJoin=()=>true}={}){
    check(!this.connection&&!this.joining,'VOICE_ALREADY_CONNECTED');check(this.config.discord.voiceChannelId,'VOICE_CHANNEL_REQUIRED');this.assertBudget();
    const attempt={abort:new AbortController()};this.joining=attempt;this.controlGeneration++;let connection;
    const valid=()=>this.joining===attempt&&!attempt.abort.signal.aborted&&this.targetMatches()&&shouldJoin();
    try{
      await this.closing;check(valid(),'VOICE_JOIN_SUPERSEDED');
      const channel=await this.client.channels.fetch(this.config.discord.voiceChannelId);check(valid(),'VOICE_JOIN_SUPERSEDED');check(channel?.guildId===this.config.discord.guildId&&channel.isVoiceBased(),'VOICE_TARGET_MISMATCH');
      connection=this.connectionFactory({channelId:channel.id,guildId:channel.guildId,adapterCreator:channel.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false,group:this.config.installation});
      this.connection=connection;this.paused=false;
      // Error listeners exist during the Ready wait as well as after attachment.
      connection.on('error',()=>{if(this.connection===connection){this.onError('DISCORD_VOICE_FAILED');void this.recover(connection);}});
      connection.on(VoiceConnectionStatus.Destroyed,()=>{if(this.connection===connection){this.onError('VOICE_DESTROYED');void this.close().catch(e=>this.onError(errorCode(e)));}});
      await this.waitForState(connection,VoiceConnectionStatus.Ready,AbortSignal.any([attempt.abort.signal,AbortSignal.timeout(20000)]));
      check(valid()&&this.connection===connection,'VOICE_JOIN_SUPERSEDED');
      connection.subscribe(this.player);
      connection.receiver.speaking.on('start',actor=>{if(this.connection===connection)this.capture(actor).catch(e=>{if(!e.voiceProviderReported)this.onError(errorCode(e));});});
      connection.on(VoiceConnectionStatus.Disconnected,()=>{if(this.connection===connection)void this.recover(connection);});
      this.policyTimer=setInterval(()=>{
        if(this.reply&&!this.canPlay(this.reply))void this.stopSpeech();
        if(!this.targetMatches()||this.audience().some(actor=>!this.allowed(actor))){void this.close();return;}
        if([...this.sessions.values()].some(s=>!this.privacyMatches(s))){void this.pause();return;}
        for(const s of this.sessions.values())if(s.readers&&this.audience().some(id=>!s.readers.includes(id)))void this.endSession(s,{drain:false});else if(!this.allowed(s.actor))void this.endSession(s,{drain:false});else if(!this.audience().includes(s.actor))void this.endSession(s);
      },250);this.policyTimer.unref();
    }catch(e){if(connection){if(this.connection===connection)this.connection=null;if(connection.state?.status!==VoiceConnectionStatus.Destroyed)connection.destroy();}throw e;}
    finally{if(this.joining===attempt)this.joining=null;}
  }
  async recover(connection){
    if(this.recovering||this.connection!==connection)return;
    const recovery={abort:new AbortController()};this.recovering=recovery;this.epoch++;
    // Stop new input immediately; retain the last transcripts during the grace.
    const drain=Promise.allSettled([this.stopSpeech({interruptProvider:false}),...[...this.sessions.values()].map(s=>this.endSession(s))]);
    try{await this.waitForState(connection,VoiceConnectionStatus.Ready,AbortSignal.any([recovery.abort.signal,AbortSignal.timeout(5000)]));await drain;}
    catch{await drain;if(this.connection===connection){this.onError('VOICE_DISCONNECTED');await this.close();}}
    finally{if(this.recovering===recovery)this.recovering=null;}
  }
  async session(actor,{initialHistory=[]}={}){
    const existing=this.sessions.get(actor);if(existing){await existing.ready;return existing;}
    check(this.connectionReady()&&!this.paused&&!this.recovering&&this.allowed(actor)&&this.audienceAllowed(),'VOICE_CONSENT_REQUIRED');const cfg=this.policy();check(process.env[cfg.voice.apiKeyEnv],'OPENAI_CREDENTIAL_REQUIRED');
    this.reserveAudio(1000,cfg.voice);
    const s={id:uid('voice'),actor,ms:0,started:Date.now(),stream:null,turn:null,revision:0,chain:Promise.resolve(),lastInput:Date.now(),ready:null,mode:this.mode,epoch:this.epoch,privacyBasis:cfg.voice.consentMode,privacyNoticeId:voiceNotice(cfg).id,stopped:false,conversationActive:false,delegations:[],providerUsageSeconds:0,lastUsageRecorded:0};
    const emit=turn=>{
      s.chain=s.chain.then(async()=>{
        if(!this.allowed(actor))return;
        const readers=await this.sourceReaders();if(!this.allowed(actor))return;const cfgNow=this.policy();const identified=!cfgNow.discord.unattributedUsers.includes(actor);
        const source={provider:'discord',guildId:cfg.discord.guildId,channelId:cfg.discord.voiceChannelId,sourceId:turn.id,actorId:identified?actor:null,revision:turn.revision??++s.revision,text:turn.text,final:true,readers,metadata:{kind:'voice',sessionId:s.id,startMs:turn.startMs??null,endMs:turn.endMs??null,createdAt:new Date().toISOString(),mode:s.mode,voiceEpoch:s.epoch,privacyBasis:s.privacyBasis==='owner_managed'?'owner_managed_scope':'participant_opt_in_record',privacyNoticeId:s.privacyNoticeId,attribution:identified?'discord_input_track':'unknown_speaker',inputAccountId:actor,finality:turn.finality??'transcription_completed'}};
        const called=addressed(turn.text,cfgNow);if(called)s.conversationActive=true;const active=this.current(s)&&identified&&s.conversationActive;
        return this.pipeline.ingest(source,{execute:active&&cfgNow.discord.operators.includes(actor),reply:active&&s.mode==='assist',analyze:s.mode==='minutes'||active});
      }).catch(e=>{if(!e.voiceProviderReported)this.onError(errorCode(e));});return s.chain;
    };
    s.turns=new TranscriptTurns({onTurn:emit});s.readers=this.audience().filter(actor=>this.allowed(actor));if(cfg.voice.naturalConversation)s.conversationActive=true;
    s.provider=this.providerFactory({mode:s.mode,naturalConversation:cfg.voice.naturalConversation,onContext:async query=>{check(this.current(s)&&this.policy().discord.operators.includes(actor),'SOURCE_ACCESS_DENIED');if(this.audience().some(id=>id!==actor))return {status:'individual_conversation_required'};const result=await readProjectContext(cfg.worker.workspace,query);check(this.current(s)&&this.policy().discord.operators.includes(actor)&&this.audience().every(id=>id===actor),'SOURCE_ACCESS_DENIED');s.readers=[actor];if(this.reply?.naturalSession===s)this.reply.readers=s.readers;return result;},onStatus:async()=>{check(this.current(s),'VOICE_SESSION_SUPERSEDED');return {scope:'current_installation',recordingEnabled:Boolean(this.archive),recordingHealthy:!this.archiveFailure,configuredAgent:cfg.agentBinding??null,...this.control.status()};},onPark:()=>{void this.endSession(s).catch(e=>this.onError(errorCode(e)));},onEvent:(type,data)=>{if(type==='native.response.usage')this.store.event('voice.native_usage',data);},model:cfg.voice.assistModel,initialHistory,apiKey:process.env[cfg.voice.apiKeyEnv],onFragment:f=>{if(cfg.voice.transcriptSource!=='local')s.turns.fragment(f);},onCompleted:t=>{if(cfg.voice.transcriptSource!=='local')emit({...t,revision:++s.revision});},
      onAudio:(pcm,sessionId,outputGeneration)=>this.receiveReplyAudio(s,pcm,sessionId,outputGeneration),onDelegation:d=>s.delegations.push(d),onUsage:usage=>{s.providerUsageSeconds=usage.seconds;if(usage.final||usage.seconds-s.lastUsageRecorded>=5){s.lastUsageRecorded=usage.seconds;this.store.event('voice.usage_snapshot',{voiceSession:s.id,seconds:usage.seconds,contextUsageRatio:usage.contextUsageRatio,final:usage.final});}},onError:code=>{
      if(s.stopped||s.epoch!==this.epoch||this.sessions.get(actor)!==s)return;
      if(!this.providerError(code))void this.endSession(s,{drain:false});
    }});
    this.sessions.set(actor,s);
    s.ready=s.provider.start().then(()=>{
      check(this.current(s),'VOICE_SESSION_SUPERSEDED');
      s.budgetTimer=setInterval(()=>{
        if(s.mode==='assist'&&!cfg.voice.naturalConversation&&Date.now()-(this.localAsr?s.lastHumanInput??s.started:s.lastInput)>=this.policy().voice.conversationIdleSeconds*1000){void this.endSession(s);return;}
        try{check(this.current(s),'VOICE_PAUSED');check(Date.now()-s.started<cfg.voice.maxSessionSeconds*1000,'VOICE_SESSION_LIMIT');this.reserveAudio(1000,this.policy().voice);}
        catch(e){this.onError(errorCode(e));if(!['AUDIO_BUDGET_EXHAUSTED','AUDIO_TOTAL_BUDGET_EXHAUSTED'].includes(e.code))void this.endSession(s,{drain:this.allowed(s.actor)&&this.privacyMatches(s)});}
      },1000);s.budgetTimer.unref();
      if(s.mode==='assist'&&!cfg.voice.naturalConversation){
        s.silenceTimer=setInterval(()=>{if(s.provider.active&&this.current(s)&&Date.now()-s.lastInput>=100){try{s.provider.append(Buffer.alloc(4800));s.ms+=100;}catch{}}},100);s.silenceTimer.unref();
      }
      return s;
    }).catch(e=>{s.stopped=true;clearInterval(s.budgetTimer);clearInterval(s.silenceTimer);s.provider.abort();if(this.sessions.get(actor)===s)this.sessions.delete(actor);throw e;});
    await s.ready;return s;
  }
  async capture(actor){
    if(!this.connectionReady()||this.paused||this.recovering||!this.audienceAllowed()||!this.allowed(actor)||!this.audience().includes(actor))return;
    if(this.policy().voice.naturalConversation&&this.reply)await this.stopSpeech();
    if(this.reply&&!this.policy().voice.naturalConversation)void this.stopSpeech();
    if(this.localAsr)return this.captureLocal(actor);
    const connection=this.connection,s=await this.session(actor);
    if(s.stream||!s.provider.active||!this.current(s)||this.connection!==connection)return;
    const decoder=new OpusScript(48000,2,OpusScript.Application.AUDIO);
    const stream=connection.receiver.subscribe(actor,{end:{behavior:EndBehaviorType.AfterSilence,duration:this.config.voice.vadSilenceMs}});
    s.stream=stream;s.turn=s.turns.begin(s.ms);let bytes=0,finished=false;
    const finish=()=>{
      if(finished)return;finished=true;if(s.stream===stream)s.stream=null;decoder.delete();
      if(bytes>=4800&&s.provider.active){if(s.mode==='minutes')s.provider.commit({id:s.turn.id,startMs:s.turn.startMs,endMs:s.ms});else s.turns.end(s.turn,s.ms);}
    };
    s.finishInput=()=>{finish();stream.destroy();};
    stream.on('data',packet=>{
      try{if(!this.current(s)){s.finishInput();return;}const pcm=pcm48StereoTo24Mono(Buffer.from(decoder.decode(packet)));s.provider.append(pcm);s.ms+=pcm.length/48;s.lastInput=Date.now();bytes+=pcm.length;}
      catch(e){s.finishInput();this.onError(errorCode(e));}
    });
    stream.once('end',finish);stream.once('close',finish);stream.once('error',()=>this.onError('VOICE_INPUT_FAILED'));
  }
  localState(actor){
    const current=this.localStates.get(actor);if(current?.epoch===this.epoch)return current;
    const cfg=this.policy(),state={id:uid('voice-local'),actor,epoch:this.epoch,revision:0,ms:0,chain:Promise.resolve(),privacyBasis:cfg.voice.consentMode,privacyNoticeId:voiceNotice(cfg).id};this.localStates.set(actor,state);return state;
  }
  async transcribeLocal(pcm){
    check(this.localAsrPending<2,'LOCAL_ASR_BUSY');this.localAsrPending++;
    const queuedAt=Date.now(),run=this.localAsrTail.then(async()=>{const startedAt=Date.now();try{return await this.localAsr.transcribe(pcm);}finally{this.store.event('voice.local_asr_timing',{audioMs:pcm.length/48,queueMs:startedAt-queuedAt,elapsedMs:Date.now()-startedAt});}});this.localAsrTail=run.catch(()=>{});
    try{return await run;}finally{this.localAsrPending--;}
  }
  queueLocalTurn(state,turn){
    state.chain=state.chain.then(async()=>{
      if(!turn.text||!this.allowed(state.actor))return;const readers=await this.sourceReaders();if(!this.allowed(state.actor))return;
      const cfg=this.policy(),identified=!cfg.discord.unattributedUsers.includes(state.actor);let transcriptCorrection=null;
      if(cfg.voice.contextCorrection&&identified&&typeof this.pipeline.analyzer?.correctTranscript==='function'){
        try{const context=this.store.sources(state.actor).filter(s=>s.guildId===cfg.discord.guildId&&s.channelId===cfg.discord.voiceChannelId&&s.actorId===state.actor).slice(-3);transcriptCorrection=await this.pipeline.analyzer.correctTranscript(turn.text,context,cfg.voice.wakeWords);}
        catch{this.onError('TRANSCRIPT_CORRECTION_FAILED');}
      }
      if(!this.allowed(state.actor))return;
      const called=addressed(turn.text,cfg)||Boolean(transcriptCorrection&&!transcriptCorrection.uncertain&&addressed(transcriptCorrection.text,cfg));
      const eligible=()=>identified&&state.epoch===this.epoch&&this.connectionReady()&&!this.paused&&!this.recovering&&this.audienceAllowed()&&this.audience().includes(state.actor);
      let session=this.sessions.get(state.actor),startError;
      if(session?.ready&&eligible())try{await session.ready;}catch(error){startError=error;session=null;}
      if(called&&this.mode==='assist'&&eligible()&&(!session||!this.current(session))){
        try{session=await this.session(state.actor,{initialHistory:[{role:'user',text:turn.text}]});}catch(error){startError=error;}
      }
      this.store.event('voice.local_turn',{voiceSession:state.id,wakeDetected:called,eligible:eligible(),liveActive:Boolean(session?.provider.active),textChars:turn.text.length});
      if(session&&eligible())session.lastHumanInput=Date.now();
      if(called&&session)session.conversationActive=true;const active=Boolean(session&&this.current(session)&&session.conversationActive&&identified);
      const source={provider:'discord',guildId:cfg.discord.guildId,channelId:cfg.discord.voiceChannelId,sourceId:turn.id,actorId:identified?state.actor:null,revision:++state.revision,text:turn.text,final:true,readers,metadata:{kind:'voice',sessionId:session?.id??state.id,startMs:turn.startMs,endMs:turn.endMs,createdAt:new Date().toISOString(),mode:this.mode,voiceEpoch:state.epoch,privacyBasis:state.privacyBasis==='owner_managed'?'owner_managed_scope':'participant_opt_in_record',privacyNoticeId:state.privacyNoticeId,attribution:identified?'discord_input_track':'unknown_speaker',inputAccountId:state.actor,finality:'local_asr_completed',transcriptOrigin:'local_asr',nativeConversation:Boolean(cfg.voice.naturalConversation),archiveSessionRefs:turn.archiveSessionRefs??[],conversationActive:active,transcriptCorrection}};
      const result=await this.pipeline.ingest(source,{execute:active&&eligible()&&cfg.discord.operators.includes(state.actor),reply:active&&eligible()&&this.mode==='assist'&&!cfg.voice.naturalConversation,analyze:this.mode==='minutes'||active&&eligible()});
      if(startError&&!startError.voiceProviderReported)this.onError(errorCode(startError));
      return result;
    }).catch(e=>{if(!e.voiceProviderReported)this.onError(errorCode(e));});return state.chain;
  }
  async captureLocal(actor){
    if(this.localCaptures.has(actor))return;const connection=this.connection,state=this.localState(actor);let live=this.sessions.get(actor);const admission=new SpeechAdmission();let starting=false;if(live&&(!this.current(live)||live.mode!=='assist'))return;
    const decoder=new OpusScript(48000,2,OpusScript.Application.AUDIO),stream=connection.receiver.subscribe(actor,{end:{behavior:EndBehaviorType.AfterSilence,duration:this.config.voice.vadSilenceMs}});const chunks=[],archiveRefs=new Set();let bytes=0,finished=false,rejected=false,startMs=state.ms;const capture={stream,stop:({seal=false}={})=>{rejected=!seal;stream.destroy();if(seal)finish();}},limit=this.policy().voice.localAsr.maxUtteranceSeconds*48000;this.localCaptures.set(actor,capture);
    const finish=()=>{
      if(finished)return;finished=true;if(this.localCaptures.get(actor)===capture)this.localCaptures.delete(actor);decoder.delete();
      if(rejected||bytes<4800)return;const pcm=Buffer.concat(chunks,bytes),turn={id:uid('utterance'),startMs,endMs:state.ms,archiveSessionRefs:[...archiveRefs]};
      const work=this.transcribeLocal(pcm).then(text=>this.queueLocalTurn(state,{...turn,text})).catch(e=>this.onError(errorCode(e)));this.draining.add(work);work.finally(()=>this.draining.delete(work));
    };
    stream.on('data',packet=>{
      try{if(this.connection!==connection||this.paused||!this.allowed(actor)){rejected=true;stream.destroy();return;}const decoded=Buffer.from(decoder.decode(packet));if(this.archive&&!this.archiveFailure){try{const receipt=this.archive.append(actor,pcm48StereoToMono(decoded),Date.now());if(receipt?.sessionId)archiveRefs.add(receipt.sessionId);}catch{this.archiveFailure=true;this.onError('ARCHIVE_CAPTURE_FAILED');}}const pcm=pcm48StereoTo24Mono(decoded);if(bytes+pcm.length>limit){rejected=true;this.onError('VOICE_UTTERANCE_LIMIT');stream.destroy();return;}chunks.push(pcm);bytes+=pcm.length;state.ms+=pcm.length/48;
        if(!live&&!starting&&this.mode==='assist'&&this.policy().voice.conversationStart==='speech'&&this.policy().discord.operators.includes(actor)&&admission.push(pcm)){
          starting=true;
          void this.session(actor).then(session=>{
            if(this.connection!==connection||!this.current(session))return;
            session.conversationActive=true;
            for(const buffered of chunks){session.provider.append(buffered);session.ms+=buffered.length/48;}
            session.lastInput=Date.now();live=session;
          }).catch(e=>{if(!e.voiceProviderReported)this.onError(errorCode(e));});
        }if(live?.provider.active&&this.current(live)){live.provider.append(pcm);live.ms+=pcm.length/48;live.lastInput=Date.now();}}
      catch(e){rejected=true;stream.destroy();this.onError(errorCode(e));}
    });
    stream.once('end',finish);stream.once('close',finish);stream.once('error',()=>{rejected=true;this.onError('VOICE_INPUT_FAILED');});
  }
  async endSession(s,{drain=true}={}){
    if(s.ending)return s.ending;
    s.stopped=true;clearInterval(s.budgetTimer);clearInterval(s.silenceTimer);s.finishInput?.();
    if(this.sessions.get(s.actor)===s)this.sessions.delete(s.actor);
    s.ending=(async()=>{
      try{if(this.reply?.provider===s.provider)await this.stopSpeech({interruptProvider:false});if(drain&&s.provider.active)await s.provider.close();else s.provider.abort();}
      finally{await s.turns.close();await s.chain;}
    })();this.draining.add(s.ending);s.ending.then(()=>this.draining.delete(s.ending),()=>this.draining.delete(s.ending));return s.ending;
  }
  canPlay(reply){
    if(reply.naturalSession&&!this.current(reply.naturalSession))return false;
    if(!this.connectionReady()||this.mode!=='assist'||this.paused||this.recovering||reply.epoch!==this.epoch||Date.now()>reply.accessExpires||!this.audienceAllowed())return false;
    try{for(const actor of this.audience()){if(!reply.readers.includes(actor))return false;for(const b of reply.bindings){const source=this.store.source(b.key,actor);if(source.revision!==b.revision)return false;}}return true;}catch{return false;}
  }
  startReplyPlayback(reply){
    if(reply.started||this.reply!==reply)return;if(!this.canPlay(reply)){void this.stopSpeech();return;}reply.started=true;clearTimeout(reply.prefillTimer);this.player.play(createAudioResource(reply.stream,{inputType:StreamType.Raw}));
  }
  receiveReplyAudio(s,pcm,sessionId,outputGeneration){
    if(!this.reply&&this.policy().voice.naturalConversation&&this.current(s)){
      const stream=new Readable({read(){}});this.reply={naturalSession:s,generation:++this.generation,epoch:s.epoch,bindings:[],readers:s.readers,stream,accessExpires:Infinity,provider:s.provider,sessionId,outputGeneration};
    }
    const reply=this.reply;if(!reply||reply.provider!==s.provider||reply.sessionId!==sessionId||reply.outputGeneration!==outputGeneration||!this.canPlay(reply))return;
    const output=pcm24MonoTo48Stereo(pcm),cfg=this.policy().voice,maxBytes=cfg.maxOutputQueueMs*192,prefillBytes=cfg.outputPrefillMs*192;if(reply.stream.readableLength+output.length>maxBytes){this.onError('VOICE_OUTPUT_QUEUE_OVERFLOW');void this.stopSpeech();return;}
    reply.stream.push(output);if(audible(pcm)&&!reply.naturalSession){reply.audible=true;clearTimeout(reply.silenceTimer);reply.silenceTimer=setTimeout(()=>{if(this.reply===reply)void this.stopSpeech();},1000);reply.silenceTimer.unref();}if(!reply.started&&reply.stream.readableLength>=prefillBytes)this.startReplyPlayback(reply);
  }
  async speak(text,{epoch,actorId,bindings=[],authorizeAudience}={}){
    if(!this.connectionReady()||this.mode!=='assist'||this.paused||epoch!==this.epoch||!this.audienceAllowed()||!text.trim())return;
    check(bindings.length>0&&typeof authorizeAudience==='function'&&typeof actorId==='string','VOICE_REPLY_SOURCE_BINDING_REQUIRED');
    const generation=++this.generation;await this.stopSpeech({invalidate:false});
    const readers=await authorizeAudience(this.audience());if(generation!==this.generation||epoch!==this.epoch)return;
    const s=this.sessions.get(actorId);if(!s||!this.current(s)||s.mode!=='assist'||!s.provider.active)return;
    const cfg=this.policy(),stream=new Readable({read(){}});const reply={generation,epoch,bindings,readers,stream,accessExpires:Date.now()+2000};
    if(!this.canPlay(reply)){stream.destroy();return;}
    reply.provider=s.provider;reply.sessionId=s.provider.sessionId;this.reply=reply;reply.refreshAccess=async()=>{if(reply.checkingAccess||this.reply!==reply)return;reply.checkingAccess=true;try{const actors=await authorizeAudience(this.audience());if(this.reply===reply){reply.readers=actors;reply.accessExpires=Date.now()+2000;}}catch{if(this.reply===reply)await this.stopSpeech();}finally{reply.checkingAccess=false;}};reply.accessTimer=setInterval(reply.refreshAccess,500);reply.accessTimer.unref();
    try{const sent=await s.provider.respond(text);reply.outputGeneration=sent.outputGeneration;}catch(e){if(this.reply===reply)await this.stopSpeech();throw e;}
    if(this.reply!==reply||!this.canPlay(reply)){stream.destroy();return;}
    reply.prefillTimer=setTimeout(()=>{if(reply.stream.readableLength)this.startReplyPlayback(reply);},cfg.voice.outputPrefillMs);reply.prefillTimer.unref();
    reply.timer=setTimeout(()=>this.stopSpeech(),cfg.voice.replySeconds*1000);reply.timer.unref();
  }
  async stopSpeech({invalidate=true,interruptProvider=true}={}){const old=this.reply;this.reply=null;if(invalidate)this.generation++;this.player.stop(true);if(old){clearInterval(old.accessTimer);clearTimeout(old.prefillTimer);clearTimeout(old.silenceTimer);clearTimeout(old.timer);old.stream.destroy();if(interruptProvider)old.provider.interrupt?.();}}
  async applyModelAction(action,source){
    check(['stop_speech','end_conversation'].includes(action)&&source?.metadata?.kind==='voice','VOICE_ACTION_INVALID');if(source.metadata.voiceEpoch!==this.epoch||!source.actorId)return;
    const currentSession=this.sessions.get(source.actorId);if(!currentSession||currentSession.id!==source.metadata.sessionId)return;
    await this.stopSpeech({interruptProvider:action==='stop_speech'});if(action==='end_conversation'){const session=this.sessions.get(source.actorId);if(session&&session.epoch===this.epoch){session.conversationActive=false;await this.endSession(session);}}
  }
  async pause({sealLocal=false}={}){
    this.controlGeneration++;this.paused=true;this.epoch++;const attempt=this.joining;this.joining=null;attempt?.abort.abort();
    for(const [actor,capture] of this.localCaptures)capture.stop({seal:sealLocal&&this.allowed(actor)});const speech=this.stopSpeech({interruptProvider:false});for(const s of this.sessions.values())void this.endSession(s).catch(e=>this.onError(errorCode(e)));await Promise.allSettled([speech,...this.draining]);
  }
  async setMode(mode){
    check(['assist','minutes'].includes(mode),'VOICE_MODE_INVALID');
    const paused=this.modeChange?.generation===this.controlGeneration?this.modeChange.paused:this.paused;
    const drain=this.pause(),change={generation:this.controlGeneration,paused};this.modeChange=change;this.mode=mode;
    await drain;if(this.controlGeneration===change.generation)this.paused=paused||Boolean(this.control.suspension);if(this.modeChange===change)this.modeChange=null;
  }
  async resume(){this.controlGeneration++;this.paused=false;}
  async close(){
    if(this.closing)return this.closing;
    clearInterval(this.policyTimer);const connection=this.connection;this.connection=null;this.recovering?.abort.abort();this.recovering=null;
    this.closing=this.pause({sealLocal:true}).finally(()=>{this.closing=null;});
    // A sealed transcript may finish after departure; it must not keep the Bot in the VC.
    if(connection&&connection.state?.status!==VoiceConnectionStatus.Destroyed)connection.destroy();
    try{this.archive?.seal();}catch{this.onError('ARCHIVE_SEAL_FAILED');}
    return this.closing;
  }
  async dispose(){await this.control.stop();for(const event of ['voiceStateUpdate','channelUpdate','guildMemberUpdate','guildMemberRemove','roleUpdate','roleDelete','threadMembersUpdate'])this.client.off?.(event,this.accessChanged);}
}
