import test from 'node:test';
import assert from 'node:assert/strict';
import {ResponsesAnalyzer,modelExecution} from '../src/llm.mjs';
import {exampleConfig} from '../src/config.mjs';

test('Responses analyzer uses Luna with strict intent output and no provider storage',async t=>{
  let clientOptions,request,requestOptions;process.env.KOTODAMA_TEST_ANALYZER_KEY='synthetic';t.after(()=>delete process.env.KOTODAMA_TEST_ANALYZER_KEY);
  class Client{
    constructor(options){
      clientOptions=options;
      this.responses={create:async(body,options)=>{request=body;requestOptions=options;return {status:'completed',model:'gpt-5.6-luna',usage:{input_tokens:100,input_tokens_details:{cached_tokens:60},output_tokens:20,total_tokens:120},output_text:JSON.stringify({summary:'質問',intents:[],replyRequested:true,reply:'確認します。',voiceAction:'none'})};}};
    }
  }
  const config=exampleConfig();config.analyzer={kind:'responses',model:'gpt-5.6-luna',apiKeyEnv:'KOTODAMA_TEST_ANALYZER_KEY',baseUrl:'https://api.openai.com/v1',timeoutSeconds:30,maxOutputTokens:2000,reasoningEffort:'low',maxContextSources:12,maxContextChars:24000,maxTaskContextItems:5,maxTaskContextChars:12000};const signal=new AbortController().signal;
  const result=await new ResponsesAnalyzer(config,{sdk:{OpenAI:Client}}).analyze({text:'ことだま、確認して',metadata:{kind:'voice'}},[],{signal,tasks:[]});
  assert.equal(clientOptions.apiKey,'synthetic');assert.equal(clientOptions.maxRetries,0);assert.equal(request.model,'gpt-5.6-luna');assert.equal(request.store,false);assert.equal(request.max_output_tokens,2000);assert.equal(request.reasoning.effort,'low');assert.equal(request.truncation,'disabled');assert.equal(typeof request.prompt_cache_key,'string');assert.equal(request.text.format.strict,true);assert(request.text.format.schema.required.includes('voiceAction'));assert(request.input.includes('ことだま、確認して'));assert.equal(requestOptions.signal,signal);assert.equal(result.reply,'確認します。');assert.deepEqual(modelExecution(result),{model:'gpt-5.6-luna',adapter:'responses_api',fallback:false,usage:{inputTokens:100,cachedInputTokens:60,outputTokens:20,totalTokens:120}});
});

test('Responses analyzer classifies provider errors without exposing their body',async t=>{process.env.KOTODAMA_TEST_ANALYZER_KEY='synthetic';t.after(()=>delete process.env.KOTODAMA_TEST_ANALYZER_KEY);class Client{constructor(){this.responses={create:async()=>{throw {status:500,error:{message:'private provider diagnostic'}};}}}}const config=exampleConfig();config.analyzer={kind:'responses',model:'gpt-5.6-luna',apiKeyEnv:'KOTODAMA_TEST_ANALYZER_KEY',baseUrl:'https://api.openai.com/v1',timeoutSeconds:30};await assert.rejects(new ResponsesAnalyzer(config,{sdk:{OpenAI:Client}}).analyze({text:'x'},[]),{code:'MODEL_API_FAILED',message:'MODEL_API_FAILED'});});
