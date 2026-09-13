// A bounded energy gate for explicitly configured private conversation rooms.
// This is not ASR or speaker recognition. Discord track identity supplies attribution.
export class SpeechAdmission {
  constructor(){this.voicedMs=0;this.silentMs=0;}
  push(pcm){
    let energy=0;for(let i=0;i<pcm.length;i+=2){const v=pcm.readInt16LE(i)/32768;energy+=v*v;}
    const duration=pcm.length/48,rms=Math.sqrt(energy/Math.max(1,pcm.length/2));
    if(rms>=0.003){this.voicedMs+=duration;this.silentMs=0;}else{this.silentMs+=duration;if(this.silentMs>=300)this.voicedMs=0;}
    return this.voicedMs>=500;
  }
}
