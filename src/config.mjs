import path from 'node:path';
import {z} from 'zod';
import {readJson, check, inside} from './common.mjs';

const id = z.string().regex(/^\d{5,24}$/);
const envName=z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const privateHostname=hostname=>{const host=hostname.toLowerCase(),v4=host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);return ['localhost','127.0.0.1','::1','[::1]'].includes(host)||host.endsWith('.ts.net')||Boolean(v4&&(v4[0]===10||v4[0]===127||v4[0]===192&&v4[1]===168||v4[0]===172&&v4[1]>=16&&v4[1]<=31||v4[0]===100&&v4[1]>=64&&v4[1]<=127));};
const commandBase = z.object({executable:z.string().min(1),args:z.array(z.string()).default([]),model:z.string().optional(),codexHome:z.string().min(1).optional(),ignoreUserConfig:z.boolean().default(true),timeoutSeconds:z.number().int().min(5).max(3600).default(300)}).strict();
const command=commandBase.extend({model:z.string().default('gpt-5.6-luna'),fallback:commandBase.extend({model:z.string().min(1)}).optional()});
const analyzerContext={maxContextSources:z.number().int().min(1).max(30).default(12),maxContextChars:z.number().int().min(1000).max(120000).default(24000),maxTaskContextItems:z.number().int().min(0).max(10).default(5),maxTaskContextChars:z.number().int().min(0).max(40000).default(12000)};
const analyzerConfig=z.union([
  command.extend({kind:z.literal('codex_cli').default('codex_cli'),...analyzerContext}),
  z.object({kind:z.literal('responses'),model:z.string().default('gpt-5.6-luna'),apiKeyEnv:envName.default('OPENAI_API_KEY'),baseUrl:z.string().url().default('https://api.openai.com/v1'),timeoutSeconds:z.number().int().min(5).max(300).default(60),maxOutputTokens:z.number().int().min(256).max(8000).default(3000),reasoningEffort:z.enum(['low','medium','high']).default('low'),...analyzerContext}).strict()
]);
const voice=z.object({mode:z.enum(['assist','minutes']).default('assist'),autoJoin:z.boolean().default(false),apiKeyEnv:envName.default('OPENAI_API_KEY'),
  consentMode:z.enum(['owner_managed','participant_opt_in']).default('owner_managed'),participantIds:z.array(id).default([]),
  assistModel:z.literal('gpt-live-1').default('gpt-live-1'),minutesModel:z.literal('gpt-live-transcribe').default('gpt-live-transcribe'),
  transcriptSource:z.enum(['live','local']).default('live'),contextCorrection:z.boolean().default(false),naturalConversation:z.boolean().default(true),conversationStart:z.enum(['wake','speech']).default('wake'),wakeWords:z.array(z.string().min(1).max(40)).min(1).max(20).default(['ことだま','ことたま','コトダマ','コトタマ','言霊','kotodama','エージェント']),localAsr:z.object({url:z.string().url(),protocol:z.enum(['openai','kotodama']).default('openai'),model:z.string().min(1).max(200),language:z.string().min(1).max(20).default('ja'),initialPrompt:z.string().max(1000).default(''),hotwords:z.string().max(1000).default(''),apiKeyEnv:envName.optional(),timeoutSeconds:z.number().int().min(5).max(120).default(20),maxUtteranceSeconds:z.number().int().min(3).max(120).default(30)}).strict().optional(),
  maxSessionSeconds:z.number().int().min(10).max(14400).default(1200),maxDailyAudioSeconds:z.number().int().min(0).max(86400).default(0),
  maxTotalAudioSeconds:z.number().int().min(0).max(10000000).optional(),
  vadSilenceMs:z.number().int().min(300).max(3000).default(1000),conversationIdleSeconds:z.number().int().min(30).max(600).default(120),replySeconds:z.number().int().min(3).max(60).default(30),outputPrefillMs:z.number().int().min(0).max(500).default(120),maxOutputQueueMs:z.number().int().min(200).max(2000).default(500),storeAudio:z.boolean().default(false)}).strict().superRefine((value,ctx)=>{if(value.transcriptSource==='local'&&!value.localAsr)ctx.addIssue({code:'custom',path:['localAsr'],message:'LOCAL_ASR_CONFIG_REQUIRED'});if(value.outputPrefillMs>value.maxOutputQueueMs)ctx.addIssue({code:'custom',path:['outputPrefillMs'],message:'VOICE_PREFILL_EXCEEDS_QUEUE'});}).prefault({});
export const Config = z.object({
  version:z.literal(1), installation:z.string().regex(/^[a-z0-9-]{1,64}$/), dataDir:z.string().default('data'),
  agentBinding:z.object({agentId:z.string().regex(/^[a-z0-9-]{1,64}$/),vmId:z.string().regex(/^[a-zA-Z0-9-]{1,64}$/)}).strict().optional(),
  discord:z.object({guildId:id,applicationId:id.optional(), textChannelIds:z.array(id).min(1), voiceChannelId:id.optional(), resultChannelId:id,
    operators:z.array(id).min(1), consentingUsers:z.array(id).default([]),unattributedUsers:z.array(id).default([]),botTokenEnv:z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('DISCORD_BOT_TOKEN')}).strict(),
  voice,
  archive:z.object({enabled:z.boolean(),archiveRoot:z.string(),journalPath:z.string(),retentionPolicyRef:z.string(),sourceRef:z.string(),actorId:id,readers:z.array(id).min(1),captureAssistantAudio:z.boolean().default(true),assistantSpeakerId:z.string().regex(/^[A-Za-z0-9_-]{1,96}$/).default('kotodama-assistant'),ffmpeg:z.string().default('ffmpeg'),whisperEndpoint:z.string().url(),whisperProtocol:z.enum(['local','openai']).default('local'),whisperModel:z.string().min(1).max(200).default('whisper-1'),whisperApiKeyEnv:envName.optional(),whisperTimeoutMs:z.number().int().min(5000).max(600000).default(120000),batchMs:z.number().int().min(20).max(250).default(250),rotationMs:z.number().int().min(1000).max(60000).default(55000),maxPendingSessions:z.number().int().min(1).max(128).default(16),maxJournalPcmBytes:z.number().int().min(1000000).max(1073741824).default(536870912),maxPcmBytes:z.number().int().min(1000000).max(134217728).default(134217728),vocabulary:z.array(z.string().max(100)).max(100).default([])}).strict().optional(),
  notifications:z.object({quietHours:z.object({enabled:z.boolean().default(false),startHour:z.number().int().min(0).max(23).default(22),endHour:z.number().int().min(0).max(23).default(9),timeZone:z.literal('Asia/Tokyo').default('Asia/Tokyo')}).prefault({})}).prefault({}),
  analyzer:analyzerConfig.prefault({kind:'codex_cli',executable:'codex',args:[],model:'gpt-5.6-luna',timeoutSeconds:120}),
  worker:command.extend({workspace:z.string(),actions:z.array(z.enum(['research','summarize','write_file','develop'])).default(['research','summarize']),
    verify:z.array(z.object({executable:z.string().min(1),args:z.array(z.string())}).strict()).default([]),maxArtifactBytes:z.number().int().min(1000).max(50000000).default(5000000)}).strict(),
  owner:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('local')}).strict(),
    z.object({kind:z.literal('remote'),url:z.string().url(),tokenEnv:z.string().min(1)}).strict()
  ]).default({kind:'local'}),
}).strict();

export async function loadConfig(filename) {
  const config=Config.parse(await readJson(filename));check(Boolean(config.archive?.enabled)===config.voice.storeAudio,'ARCHIVE_RECORDING_CONFIG_REQUIRED');if(config.archive?.enabled){check(config.voice.consentMode==='owner_managed'&&config.agentBinding&&config.owner.kind==='local','ARCHIVE_BINDING_REQUIRED');check(config.archive.assistantSpeakerId!=='mixed'&&!config.voice.participantIds.includes(config.archive.assistantSpeakerId),'ARCHIVE_ASSISTANT_ID_INVALID');const endpoint=new URL(config.archive.whisperEndpoint);check(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'ARCHIVE_ASR_HOST_MISMATCH');
    if(config.archive.whisperProtocol==='openai'){check(endpoint.protocol==='https:'&&endpoint.hostname==='api.openai.com'&&!endpoint.port&&endpoint.pathname==='/v1/audio/transcriptions','ARCHIVE_ASR_HOST_MISMATCH');check(config.archive.whisperApiKeyEnv,'ARCHIVE_ASR_CREDENTIAL_REQUIRED');}
    else check(['http:','https:'].includes(endpoint.protocol)&&privateHostname(endpoint.hostname),'ARCHIVE_ASR_HOST_MISMATCH');}
  const root=path.dirname(path.resolve(filename));
  config.dataDir=path.resolve(root,config.dataDir);if(config.archive?.enabled)check(path.isAbsolute(config.archive.archiveRoot)&&path.isAbsolute(config.archive.journalPath)&&inside(config.dataDir,config.archive.journalPath),'ARCHIVE_PATH_SCOPE');config.worker.workspace=path.resolve(root,config.worker.workspace);
  const commandAdapters=[config.worker,config.worker.fallback,...(config.analyzer.kind==='codex_cli'?[config.analyzer,config.analyzer.fallback]:[])];for(const adapter of commandAdapters)if(adapter?.codexHome)adapter.codexHome=path.resolve(root,adapter.codexHome);
  check(new Set(config.discord.operators).size===config.discord.operators.length,'DUPLICATE_OPERATOR');
  if(config.voice.localAsr){const u=new URL(config.voice.localAsr.url),host=u.hostname.toLowerCase(),v4=host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);const privateHost=['localhost','127.0.0.1','::1','[::1]'].includes(host)||host.endsWith('.ts.net')||Boolean(v4&&(v4[0]===10||v4[0]===127||v4[0]===192&&v4[1]===168||v4[0]===172&&v4[1]>=16&&v4[1]<=31||v4[0]===100&&v4[1]>=64&&v4[1]<=127));check(u.protocol==='https:'||u.protocol==='http:'&&privateHost,'LOCAL_ASR_TRANSPORT_REFUSED');check(!u.username&&!u.password&&!u.search&&!u.hash,'LOCAL_ASR_URL_INVALID');}
  if(config.analyzer.kind==='responses'){const u=new URL(config.analyzer.baseUrl);check(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)),'ANALYZER_TRANSPORT_REFUSED');check(!u.username&&!u.password&&!u.search&&!u.hash,'ANALYZER_URL_INVALID');}
  return config;
}
export function exampleConfig({guildId='100000000000000001',applicationId,operatorId='100000000000000002',channelId='100000000000000003',workspace='.'}={}) {
  return Config.parse({version:1,installation:'my-kotodama',discord:{guildId,applicationId,textChannelIds:[channelId],resultChannelId:channelId,operators:[operatorId]},voice:{consentMode:'owner_managed',participantIds:[operatorId]},worker:{executable:'codex',model:'gpt-5.6-luna',workspace}});
}
