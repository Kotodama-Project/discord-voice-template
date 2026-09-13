import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {NotificationQueue,isQuiet} from '../src/notifications.mjs';
const policy={enabled:true,startHour:22,endHour:9,timeZone:'Asia/Tokyo'};
test('JST quiet hours include 22:00 and exclude 09:00',()=>{
  assert(isQuiet(policy,new Date('2026-09-13T13:00:00Z')));assert(isQuiet(policy,new Date('2026-09-13T23:59:59Z')));assert(!isQuiet(policy,new Date('2026-09-14T00:00:00Z')));assert(!isQuiet(policy,new Date('2026-09-13T12:59:59Z')));
});
test('deferred notifications survive queue reconstruction and send once after quiet hours',async()=>{
  const db=new DatabaseSync(':memory:');let date=new Date('2026-09-13T14:00:00Z'),sent=0;
  const first=new NotificationQueue(db,()=>policy,{now:()=>date});first.defer('one','task',{id:'task',actor:'owner',revision:1});first.defer('one','task',{id:'task',actor:'owner',revision:1});await first.flush(async()=>sent++);assert.equal(sent,0);
  const resumed=new NotificationQueue(db,()=>policy,{now:()=>date});date=new Date('2026-09-14T00:00:00Z');await resumed.flush(async()=>{sent++;return {state:'sent'};});await resumed.flush(async()=>sent++);assert.equal(sent,1);db.close();
});
