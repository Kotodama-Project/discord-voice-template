import {check} from './common.mjs';

// Ported from the private Live runtime's Peer.pump_audio 20 ms PCM cadence, with bounded startup buffering.
export class LiveAudioClock {
  constructor(send,{now=()=>performance.now(),onError=()=>{}}={}){this.send=send;this.now=now;this.onError=onError;this.chunks=[];this.bytes=0;this.offset=0;}
  append(pcm){check(this.bytes+pcm.length<=480000,'VOICE_INPUT_QUEUE_LIMIT');this.chunks.push(pcm);this.bytes+=pcm.length;}
  frame(){
    const output=Buffer.alloc(960);let written=0;
    while(written<output.length&&this.chunks.length){const head=this.chunks[0],size=Math.min(head.length-this.offset,output.length-written);head.copy(output,written,this.offset,this.offset+size);written+=size;this.offset+=size;this.bytes-=size;if(this.offset===head.length){this.chunks.shift();this.offset=0;}}
    return output;
  }
  start(){
    if(this.timer)return;this.deadline=this.now()+20;
    const tick=()=>{try{check(this.now()-this.deadline<=1000,'VOICE_INPUT_PACING_OVERRUN');this.send(this.frame());this.deadline+=20;this.timer=setTimeout(tick,Math.max(0,this.deadline-this.now()));this.timer.unref();}catch{this.stop();this.onError('VOICE_INPUT_PACING_FAILED');}};
    this.timer=setTimeout(tick,20);this.timer.unref();
  }
  stop(){clearTimeout(this.timer);this.timer=null;this.chunks=[];this.bytes=0;this.offset=0;}
}
