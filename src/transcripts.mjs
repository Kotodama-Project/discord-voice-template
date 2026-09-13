import {check,uid} from './common.mjs';

/** Local utterance grouping is provisional semantics, not a provider turn receipt. */
export class TranscriptTurns {
  constructor({onTurn,settleMs=1500,clock=Date.now}){this.onTurn=onTurn;this.settleMs=settleMs;this.clock=clock;this.fragments=new Map();this.turns=[];this.pending=[];this.closed=false;this.revision=0;}
  begin(startMs){check(!this.closed,'TRANSCRIPT_CLOSED');const turn={id:uid('utterance'),startMs,endMs:Infinity,revision:0,timer:null};this.turns.push(turn);return turn;}
  end(turn,endMs){turn.endMs=endMs;this.#schedule(turn);}
  fragment(f){if(this.closed)return;check(f.id&&typeof f.text==='string'&&f.endMs>=f.startMs,'TRANSCRIPT_INVALID');
    const old=this.fragments.get(f.id);if(old){check(JSON.stringify(old)===JSON.stringify(f),'TRANSCRIPT_EVENT_CONFLICT');return;}
    this.fragments.set(f.id,f);
    for(const turn of this.turns)if(Number.isFinite(turn.endMs)&&f.startMs<turn.endMs&&f.endMs>turn.startMs)this.#schedule(turn);
  }
  #schedule(turn){clearTimeout(turn.timer);turn.timer=setTimeout(()=>this.#emit(turn),this.settleMs);turn.timer.unref?.();}
  #emit(turn){if(this.closed)return;const fragments=[...this.fragments.values()].filter(f=>f.startMs<turn.endMs&&f.endMs>turn.startMs).sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs);
    const text=fragments.map(f=>f.text).join('');if(!text.trim()||turn.lastText===text)return;turn.lastText=text;turn.revision=++this.revision;
    const work=Promise.resolve(this.onTurn({id:turn.id,text,startMs:turn.startMs,endMs:turn.endMs,revision:turn.revision,final:true,finality:'vad_and_settled_transcript',providerTurnComplete:false}));this.pending.push(work);work.catch(()=>{});
  }
  async flush(){for(const turn of this.turns){clearTimeout(turn.timer);if(Number.isFinite(turn.endMs))this.#emit(turn);}await Promise.allSettled(this.pending);}
  async close(){await this.flush();this.closed=true;for(const turn of this.turns)clearTimeout(turn.timer);}
}
