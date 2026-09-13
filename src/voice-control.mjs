import {check,errorCode} from './common.mjs';

const states={disabled:'自動接続オフ',empty:'参加者待ち',empty_grace:'無人退出待ち',scope:'対象範囲を確認できないため待機',joining:'接続中',connected:'接続済み',recovering:'接続復旧待ち',paused:'録音停止中',leave:'手動退出中',budget:'利用上限で停止中',provider_credit:'音声APIの残高補充待ち',stopped:'終了済み',retry:'次の接続確認待ち'};

// This controller owns occupancy and operator preference, never tasks or grants.
export class VoiceControl {
  constructor({room,now=()=>Date.now()}){
    this.room=room;this.now=now;this.emptySince=null;this.stopped=false;this.running=null;this.dirty=false;this.state='disabled';this.managed=false;
    const {guildId,voiceChannelId}=room.target;
    this.suspension=room.store.voiceSuspension(guildId,voiceChannelId);
    if(this.suspension)room.paused=true;
    this.onOccupancy=(oldState,newState)=>{
      if([oldState,newState].some(s=>s?.guild?.id===guildId&&s.channelId===voiceChannelId))void this.check();
    };
  }
  suspend(reason){const {guildId,voiceChannelId}=this.room.target;this.suspension=reason;this.emptySince=null;this.room.store.setVoiceSuspension(guildId,voiceChannelId,reason);}
  status(){
    const room=this.room,autoJoin=Boolean(room.policy().voice.autoJoin),connected=room.connectionReady()&&!room.joining&&!room.recovering;
    const idleState=['connected','joining','recovering'].includes(this.state)?'retry':this.state;
    const connectionState=room.joining?'joining':room.recovering?'recovering':connected?this.state==='empty_grace'?'empty_grace':'connected':room.connection?'recovering':autoJoin?idleState:'disabled';
    const waiting=this.stopped?'stopped':this.suspension==='pause'?'paused':this.suspension??connectionState;
    return {mode:room.mode,connected,paused:room.paused,autoJoin,suspended:Boolean(this.suspension),suspension:this.suspension,waiting,waitingText:states[waiting]??states.retry,transcriptSource:room.config.voice.transcriptSource,liveSessions:room.sessions.size};
  }
  start(){if(this.timer||this.stopped)return;this.room.client.on('voiceStateUpdate',this.onOccupancy);this.timer=setInterval(()=>{void this.check();},10000);this.timer.unref();void this.check();}
  check(){
    if(this.stopped)return Promise.resolve();this.dirty=true;
    if(this.running)return this.running;
    this.running=(async()=>{while(this.dirty&&!this.stopped){this.dirty=false;try{await this.tick();}catch(e){this.state='retry';this.room.onError(errorCode(e));}}})().finally(()=>{this.running=null;});
    return this.running;
  }
  async tick(){
    const room=this.room,cfg=room.policy();
    if(this.suspension){this.state=this.suspension==='pause'?'paused':this.suspension;return;}
    if(!room.targetMatches()){this.state='scope';this.emptySince=null;await room.close();return;}
    const actors=room.audience();
    if(actors.some(actor=>!room.allowed(actor))){this.state='scope';this.emptySince=null;await room.close();return;}
    if(!cfg.voice.autoJoin){this.state='disabled';if(this.managed){this.managed=false;await room.close();}return;}
    try{room.assertBudget();}catch(e){if(e.code!=='AUDIO_BUDGET_REQUIRED')this.suspend('budget');this.state='budget';await room.close();return;}
    if(!actors.length){
      if(!room.connection&&!room.joining){this.state='empty';this.emptySince=null;return;}
      this.emptySince??=this.now();this.state='empty_grace';
      if(this.now()-this.emptySince>=15000){await room.close();this.state='empty';this.emptySince=null;}
      return;
    }
    this.emptySince=null;
    if(room.connection||room.joining){this.state=room.joining?'joining':room.recovering||!room.connectionReady()?'recovering':'connected';return;}
    this.state='joining';this.managed=true;
    await room.join({shouldJoin:()=>!this.stopped&&!this.suspension&&room.policy().voice.autoJoin&&room.audienceAllowed()});
    this.state='connected';
  }
  async command(mode,{actor}={}){
    check(['join','pause','resume','leave','stop_speech','assist','minutes','status','start_conversation','end_conversation'].includes(mode),'VOICE_MODE_INVALID');
    check(!this.stopped||mode==='status','RUNTIME_STOPPING');const room=this.room;
    if(mode==='start_conversation'||mode==='end_conversation'){
      check(typeof actor==='string'&&room.policy().discord.operators.includes(actor)&&room.allowed(actor)&&room.audience().includes(actor),'VOICE_CONVERSATION_ACTOR_REQUIRED');
      if(mode==='start_conversation'){
        check(room.mode==='assist'&&!this.suspension,'VOICE_CONVERSATION_UNAVAILABLE');
        const session=await room.session(actor);session.conversationActive=true;session.lastHumanInput=Date.now();
      }else{const session=room.sessions.get(actor);if(session)await room.endSession(session);}
    }else if(mode==='pause'||mode==='leave'){
      this.suspend(mode); // Invalidate before awaiting any pending connection or drain.
      if(mode==='leave'||room.joining)await room.close();else await room.pause();
    }else if(mode==='join'||mode==='resume'){
      room.assertBudget();check(room.targetMatches(),'VOICE_TARGET_MISMATCH');this.suspend(null);this.managed=false;
      if(room.connection)await room.resume();else if(mode==='join')await room.join({shouldJoin:()=>!this.stopped&&!this.suspension});else {await room.resume();await this.check();}
    }else if(mode==='stop_speech')await room.stopSpeech();
    else if(mode==='assist'||mode==='minutes')await room.setMode(mode);
    return this.status();
  }
  async stop(){this.stopped=true;clearInterval(this.timer);this.room.client.off('voiceStateUpdate',this.onOccupancy);await this.room.close();await this.running;}
}

export async function voiceCommand(room,mode,options){return room.control.command(mode,options);}
export function voiceStatusText(status){const live=status.liveSessions?`Live会話 ${status.liveSessions}件`:status.transcriptSource==='local'?'ローカル聞き役':'Live聞き役';return `音声: ${status.mode} / ${status.connected?'接続中':'未接続'} / ${status.paused?'録音停止中':'受付中'} / ${live} / 自動接続${status.autoJoin?'オン':'オフ'} / ${status.waitingText}`;}
