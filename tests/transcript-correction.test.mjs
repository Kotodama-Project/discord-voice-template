import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionCandidate} from '../src/transcript-correction.mjs';
test('context correction preserves provenance and never claims confirmed audio or intent',()=>{
  const raw='おとだまこんにちは';const candidate=correctionCandidate(raw,{text:'ことだま、こんにちは',uncertain:false},'fixture');
  assert.equal(raw,'おとだまこんにちは');assert.equal(candidate.text,'ことだま、こんにちは');assert.equal(candidate.audioVerified,false);assert.equal(candidate.humanConfirmed,false);assert(candidate.rawDigest);
  assert.equal(correctionCandidate(raw,{text:'推測',uncertain:true},'fixture').text,raw);
  assert.throws(()=>correctionCandidate(raw,{text:'x'.repeat(1000),uncertain:false},'fixture'),{code:'TRANSCRIPT_CORRECTION_LIMIT'});
});
