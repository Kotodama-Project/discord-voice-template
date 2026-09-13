#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {loadConfig} from '../src/config.mjs';
import {check} from '../src/common.mjs';
import {workerEnv} from '../src/command.mjs';
const {values:o}=parseArgs({options:{config:{type:'string',default:'.kotodama/config.json'},adapter:{type:'string',default:'worker'}}});
check(process.stdin.isTTY,'HUMAN_TERMINAL_REQUIRED');check(['analyzer','worker'].includes(o.adapter),'ADAPTER_INVALID');
const config=await loadConfig(o.config),adapter=config[o.adapter];
check(adapter.codexHome,'DEDICATED_CODEX_HOME_REQUIRED');await mkdir(adapter.codexHome,{recursive:true,mode:0o700});
console.log('本人がブラウザでログインしてください。表示されたコードや認証情報をチャットへ貼る必要はありません。');
const child=spawn(adapter.executable,['login','--device-auth'],{cwd:config.worker.workspace,env:workerEnv({CODEX_HOME:adapter.codexHome}),stdio:'inherit',shell:false});
child.on('error',()=>{console.error('Codex CLIを起動できませんでした。');process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
