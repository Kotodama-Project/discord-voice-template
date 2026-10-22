import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Config,exampleConfig,loadConfig} from '../src/config.mjs';

test('new installations use official OpenAI ASR, Responses and App Server with audio disabled until budgeted',()=>{
  const config=exampleConfig();
  assert.equal(config.voice.transcriptSource,'openai');
  assert.equal(config.voice.openaiAsr.model,'gpt-transcribe');
  assert.equal(config.voice.maxDailyAudioSeconds,0);
  assert.equal(config.analyzer.kind,'responses');
  assert.equal(config.worker.kind,'codex_app_server');
  assert.equal(config.worker.apiKeyEnv,'OPENAI_API_KEY');
  config.voice.openaiAsr.url='https://other.example/v1/audio/transcriptions';
  assert.throws(()=>Config.parse(config));
});

test('old CLI settings remain explicit while non-OpenAI fallback settings are refused',()=>{
  const config=exampleConfig();
  config.worker={executable:'codex',workspace:'.'};
  assert.equal(Config.parse(config).worker.kind,'codex_cli');
  config.worker.fallback={executable:'other-provider'};
  assert.throws(()=>Config.parse(config));
});

test('App Server auth cannot write API credentials into a saved subscription home',()=>{
  const config=exampleConfig();
  config.worker.codexHome='private-codex';
  assert.throws(()=>Config.parse(config),/API_KEY_HOME_MUST_BE_ISOLATED/);
  delete config.worker.apiKeyEnv;
  assert.equal(Config.parse(config).worker.codexHome,'private-codex');
  delete config.worker.codexHome;
  assert.throws(()=>Config.parse(config),/DEDICATED_CODEX_HOME_REQUIRED/);
  config.worker.kind='codex_cli';
  config.worker.apiKeyEnv='OPENAI_API_KEY';
  assert.throws(()=>Config.parse(config),/API_KEY_REQUIRES_APP_SERVER/);
});


test('legacy ASR permits private endpoints and official OpenAI but not arbitrary public HTTPS uploads',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ktdm-asr-config-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=exampleConfig();config.voice.transcriptSource='local';
  const file=path.join(dir,'config.json');
  for(const url of ['http://127.0.0.1:9000/v1/audio/transcriptions','https://10.0.0.2/v1/audio/transcriptions','https://api.openai.com/v1/audio/transcriptions']){
    config.voice.localAsr={url,protocol:'openai',model:'gpt-transcribe'};
    await writeFile(file,JSON.stringify(config));assert.equal((await loadConfig(file)).voice.localAsr.url,url);
  }
  for(const url of ['https://public.example/v1/audio/transcriptions','https://api.openai.com.example/v1/audio/transcriptions','https://api.openai.com/unexpected']){
    config.voice.localAsr.url=url;await writeFile(file,JSON.stringify(config));
    await assert.rejects(loadConfig(file),/LOCAL_ASR_TRANSPORT_REFUSED/);
  }
});
