import {check,Refused} from './common.mjs';

export function pcm24MonoWav(pcm){
  check(Buffer.isBuffer(pcm)&&pcm.length>0&&pcm.length%2===0&&pcm.length<=0xffffffff-36,'LOCAL_ASR_AUDIO_INVALID');
  const wav=Buffer.allocUnsafe(44+pcm.length);wav.write('RIFF',0);wav.writeUInt32LE(36+pcm.length,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);return wav;
}

async function boundedText(response,maxBytes=65536){
  check(response.body,'LOCAL_ASR_RESULT_INVALID');const chunks=[];let size=0;
  for await(const chunk of response.body){const value=Buffer.from(chunk);size+=value.length;if(size>maxBytes)throw new Refused('LOCAL_ASR_RESULT_LIMIT');chunks.push(value);}
  return Buffer.concat(chunks,size).toString('utf8');
}

export class LocalAsr {
  constructor({url,protocol='openai',model,language='ja',initialPrompt='',hotwords='',apiKey=null,timeoutSeconds=20,maxUtteranceSeconds=30,fetcher=fetch}){
    const endpoint=new URL(url);check(['http:','https:'].includes(endpoint.protocol)&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'LOCAL_ASR_URL_INVALID');
    check(['openai','kotodama'].includes(protocol)&&typeof model==='string'&&model.length>0&&model.length<=200&&typeof language==='string'&&language.length<=20&&initialPrompt.length<=1000&&hotwords.length<=1000,'LOCAL_ASR_CONFIG_INVALID');
    Object.assign(this,{url:endpoint,protocol,model,language,initialPrompt,hotwords,apiKey,timeoutSeconds,maxUtteranceSeconds,fetcher});
  }
  async transcribe(pcm){
    check(Buffer.isBuffer(pcm)&&pcm.length>=4800&&pcm.length<=this.maxUtteranceSeconds*48000,'LOCAL_ASR_AUDIO_INVALID');
    const form=new FormData(),file=new Blob([pcm24MonoWav(pcm)],{type:'audio/wav'});form.append(this.protocol==='kotodama'?'audio':'file',file,'utterance.wav');form.append('language',this.language);
    if(this.protocol==='openai'){form.append('model',this.model);form.append('response_format','json');if(this.initialPrompt)form.append('prompt',this.initialPrompt);}
    else {if(this.initialPrompt)form.append('initial_prompt',this.initialPrompt);if(this.hotwords)form.append('hotwords',this.hotwords);}
    let response;try{response=await this.fetcher(this.url,{method:'POST',redirect:'error',headers:this.apiKey?{authorization:`Bearer ${this.apiKey}`}:{},body:form,signal:AbortSignal.timeout(this.timeoutSeconds*1000)});}catch{throw new Refused('LOCAL_ASR_FAILED');}
    if(!response.ok)throw new Refused('LOCAL_ASR_FAILED');const length=Number(response.headers.get('content-length')??0);check(!length||length<=65536,'LOCAL_ASR_RESULT_LIMIT');
    const raw=await boundedText(response);let parsed;try{parsed=JSON.parse(raw);}catch{throw new Refused('LOCAL_ASR_RESULT_INVALID');}
    const text=typeof parsed?.text==='string'?parsed.text:this.protocol==='kotodama'&&Array.isArray(parsed?.segments)&&parsed.segments.every(segment=>typeof segment?.text==='string')?parsed.segments.map(segment=>segment.text).join(''):null;
    check(typeof text==='string'&&text.length<=16000,'LOCAL_ASR_RESULT_INVALID');return text.trim();
  }
}
