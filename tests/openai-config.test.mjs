import test from 'node:test';
import assert from 'node:assert/strict';
import {Config,exampleConfig} from '../src/config.mjs';

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
