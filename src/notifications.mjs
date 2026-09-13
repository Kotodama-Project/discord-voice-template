import {check,digest} from './common.mjs';

export function isQuiet(policy,date=new Date()){
  if(!policy?.enabled)return false;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:policy.timeZone,hour:'2-digit',hourCycle:'h23'}).format(date));
  return policy.startHour>policy.endHour?hour>=policy.startHour||hour<policy.endHour:hour>=policy.startHour&&hour<policy.endHour;
}
// Delivery scheduling only; task state and content remain with the existing owner.
export class NotificationQueue {
  constructor(db,policy,{now=()=>new Date(),onError=()=>{}}={}){
    Object.assign(this,{db,policy,now,onError});this.busy=false;
    db.exec('CREATE TABLE IF NOT EXISTS deferred_notifications(key TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL)');
  }
  quiet(){return isQuiet(this.policy(),this.now());}
  defer(key,kind,body){
    const bytes=JSON.stringify(body),hash=digest(bytes);check(bytes.length<=20000,'NOTIFICATION_SIZE_LIMIT');
    const prior=this.db.prepare('SELECT digest FROM deferred_notifications WHERE key=?').get(key);if(prior){check(prior.digest===hash,'NOTIFICATION_REPLAY_CONFLICT');return;}
    check(this.db.prepare("SELECT count(*) AS n FROM deferred_notifications WHERE state='pending'").get().n<1024,'NOTIFICATION_QUEUE_LIMIT');
    this.db.prepare('INSERT INTO deferred_notifications VALUES(?,?,?,?,?)').run(key,kind,bytes,hash,'pending');
  }
  async flush(send){
    if(this.busy||this.quiet())return;this.busy=true;
    try{for(const row of this.db.prepare("SELECT * FROM deferred_notifications WHERE state='pending' ORDER BY rowid LIMIT 20").all()){
      if(this.quiet())break;
      const result=await send(row.kind,JSON.parse(row.body));if(result?.state==='blocked'||result?.state==='deferred')continue;
      this.db.prepare("UPDATE deferred_notifications SET state='done' WHERE key=?").run(row.key);
    }}finally{this.busy=false;}
  }
  start(send){const tick=()=>{if(!this.pending)this.pending=this.flush(send).catch(()=>this.onError('NOTIFICATION_DELIVERY_BLOCKED')).finally(()=>{this.pending=null;});};this.timer=setInterval(tick,60000);this.timer.unref();tick();}
  async stop(){clearInterval(this.timer);await this.pending;}
}
