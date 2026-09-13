import test from 'node:test';
import assert from 'node:assert/strict';
import {addressed} from '../src/voice.mjs';
const config={voice:{wakeWords:['ことだま','エージェント']}};
test('Japanese wake accepts omitted punctuation and greeting filler',()=>{
  for(const text of ['ことだまこんにちは','テスト ことだまあこんにちは聞こえてる','エージェント聞こえる？'])assert(addressed(text,config),text);
  for(const text of ['昨日ことだまが話した','ことだまの資料','これはことだまこんにちはという例'])assert(!addressed(text,config),text);
});
