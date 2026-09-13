import {check} from './common.mjs';

export const DEFAULT_APPLICATION_NAME='Kotodama Casual Template';
export function applicationName(name){check(typeof name==='string'&&name.trim().length>0&&name.length<=100,'APPLICATION_NAME_REQUIRED');check(!name.toLowerCase().includes('discord'),'APPLICATION_NAME_RESERVED');return name.trim();}
export function humanBoundary(url,{text='',type=null,role=null,dialogText='',coordinate=false}={}){
  const pathname=new URL(url).pathname;
  if(/\/(?:login|signin|register|auth)(?:\/|$)/i.test(pathname))return {required:true,category:'identity',code:'HUMAN_LOGIN_REQUIRED'};
  if(/log.?in|sign.?in|ログイン|サインイン/i.test(dialogText)&&/password|email|メール|verification|認証|コード/i.test(dialogText))return {required:true,category:'identity',code:'HUMAN_LOGIN_REQUIRED'};
  if(/\/oauth2\/authorize/i.test(pathname))return {required:true,category:'access_grant',code:'HUMAN_AUTHORIZATION_REQUIRED'};
  if(/reset.?token|トークン.*(?:リセット|生成)/i.test(text))return {required:true,category:'credential',code:'HUMAN_CREDENTIAL_REQUIRED'};
  const legal=/作成をクリックすると[\s\S]*同意|(?:clicking|by clicking)[\s\S]*agree|terms of service/i.test(dialogText);
  if(legal&&(coordinate||type==='checkbox'||role==='checkbox'||/^(?:作成|Create)$/i.test(text.trim())))return {required:true,category:'terms',code:'HUMAN_TERMS_REQUIRED'};
  return {required:false,category:'automation',code:null};
}
