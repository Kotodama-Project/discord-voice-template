#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {startCompatibleProxy} from '../src/compatible-proxy.mjs';
import {check} from '../src/common.mjs';
const args=process.argv.slice(2);
function take(name){const i=args.indexOf(name);check(i>=0&&args[i+1]&&!args[i+1].startsWith('--'),'COMPAT_ARGUMENT_REQUIRED');const value=args[i+1];args.splice(i,2);return value;}
const baseUrl=take('--base-url'),codex=take('--codex');
const proxy=await startCompatibleProxy({baseUrl,onError:code=>console.error(code)});
const overrides=['model_provider="compatible_local"','model_providers.compatible_local.name="Configured local model"',`model_providers.compatible_local.base_url="${proxy.baseUrl}"`,'model_providers.compatible_local.wire_api="responses"','model_providers.compatible_local.requires_openai_auth=false','model_providers.compatible_local.request_max_retries=0','model_providers.compatible_local.stream_max_retries=0'];
const child=spawn(codex,[...overrides.flatMap(v=>['-c',v]),...args],{stdio:'inherit',shell:false,windowsHide:true});
child.once('error',async()=>{await proxy.close();process.exitCode=1;});child.once('exit',async code=>{await proxy.close();process.exitCode=code??1;});
