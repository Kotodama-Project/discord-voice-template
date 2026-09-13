// Synthetic process fixture. This file never contacts a model or a provider.
import {readFile,writeFile} from 'node:fs/promises';
if(process.argv.includes('--version')){console.log('synthetic-cli-fixture 1');process.exit(0);}
const schemaPath=process.argv[process.argv.indexOf('--output-schema')+1];const schema=JSON.parse(await readFile(schemaPath,'utf8'));
let input='';for await(const chunk of process.stdin)input+=chunk;
let text;
if(schema.properties.intents)text=JSON.stringify({summary:'合成会話の整理',intents:[{kind:'proposal',title:'合成ToDo',request:'資料を作る案',action:'write_file',explicit:false,complete:true,acceptance:['本文'],targetTaskId:null}],replyRequested:false,reply:''});
else if(process.argv.includes('--fixture-write')){await writeFile('created.mjs','export const answer = 42;\n');text=JSON.stringify({summary:'合成fixtureがファイルを作成しました。',files:[]});}
else text=JSON.stringify({summary:'実プロセスを経由した合成の調査結果です。',files:[]});
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
