import admin from 'firebase-admin';
import webpush from 'web-push';
import crypto from 'node:crypto';

const DEFAULT_ZONE = 'America/New_York';
const VALID_ZONES = new Set(['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','America/Anchorage','Pacific/Honolulu']);
const formatters = new Map();
function formatter(zone){if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));return formatters.get(zone);}
const DRY_RUN = process.env.DRY_RUN !== 'false';
const NOW = Date.now();
const LOOKBACK_MS = 12 * 60_000;
const LOOKAHEAD_MS = 60_000;
const LEASE_MS = 3 * 60_000;
function parts(ms,zone){return Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));}
function localDate(ms,zone){const p=parts(ms,zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
function dateAt(k){return new Date(`${k}T12:00:00Z`);}
function addDays(k,n){const d=dateAt(k);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function occurs(e,k){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(e.date||'')||k<e.date||e.until&&k>e.until||Array.isArray(e.skip)&&e.skip.includes(k))return false;
 if(k===e.date)return true;
 const a=dateAt(e.date),b=dateAt(k),dow=b.getUTCDay();
 switch(e.repeat||'none'){
 case 'daily':return true;
 case 'weekdays':return dow>0&&dow<6;
 case 'weekly':return Array.isArray(e.repeatDays)&&e.repeatDays.length?e.repeatDays.map(Number).includes(dow):dow===a.getUTCDay();
 case 'monthly':return b.getUTCDate()===a.getUTCDate();
 case 'yearly':return b.getUTCMonth()===a.getUTCMonth()&&b.getUTCDate()===a.getUTCDate();
 default:return false;
 }
}
// Find real UTC instants matching a New York wall-clock time. DST gaps yield none;
// fall-back ambiguous times use the first occurrence, to avoid double reminders.
function instant(k,time,zone){
 const [h,m]=time.split(':').map(Number);if(!/^\d{2}:\d{2}$/.test(time)||h>23||m>59)return null;
 const nominal=Date.parse(`${k}T${time}:00Z`);if(!Number.isFinite(nominal))return null;
 const matches=[];
 for(let offset=-12;offset<=12;offset++){
   const t=nominal+offset*3600_000,p=parts(t,zone);
   if(localDate(t,zone)===k&&p.hour===h&&p.minute===m)matches.push(t);
 }
 return matches.length?Math.min(...matches):null;
}
function reminders(e){return (Array.isArray(e.reminders)?e.reminders:(e.remind!==''&&e.remind!=null?[e.remind]:[])).map(Number).filter(n=>Number.isFinite(n)&&n>=0&&n<=10080);}
function recipientIds(member,uid){return new Set([uid,member?.id,member?.accountId,member?.userId].filter(Boolean));}
function eligible(e,ids){return Array.isArray(e.who)&&e.who.some(w=>ids.has(w));}
function safeReason(error){let reason='unknown';try{reason=JSON.parse(error.body||'{}').reason||reason;}catch{}return reason;}

if(!DRY_RUN){for(const key of ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT'])if(!process.env[key])throw Error(`Missing ${key}`);
 webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);}
admin.initializeApp({credential:admin.credential.applicationDefault(),projectId:'pocket-docket-82820'});
const db=admin.firestore();
const subscriptions=await db.collection('pushSubscriptions').where('enabled','==',true).get();
const householdCache=new Map();
const zoneCache=new Map();
let dueCount=0,sent=0,failed=0,skipped=0;
for(const subDoc of subscriptions.docs){
 const sub=subDoc.data();if(!sub.subscription?.endpoint||!sub.uid||!sub.householdId){skipped++;continue;}
 const memberDoc=await db.doc(`households/${sub.householdId}/members/${sub.uid}`).get();
 if(!memberDoc.exists){skipped++;continue;}
 if(!householdCache.has(sub.householdId))householdCache.set(sub.householdId,await db.collection('households').doc(sub.householdId).collection('events').get());
 if(!zoneCache.has(sub.householdId)){
   const householdDoc=await db.doc(`households/${sub.householdId}`).get();
   const configured=householdDoc.data()?.timezone;
   if(configured&&!VALID_ZONES.has(configured)){console.warn(`Invalid timezone for household ${sub.householdId}; skipping reminders`);zoneCache.set(sub.householdId,null);}
   else zoneCache.set(sub.householdId,configured||DEFAULT_ZONE);
 }
 const zone=zoneCache.get(sub.householdId);if(!zone){skipped++;continue;}
 const ids=recipientIds(memberDoc.data(),sub.uid);
 for(const eventDoc of householdCache.get(sub.householdId).docs){
  const e=eventDoc.data();if(!eligible(e,ids)||!e.time||!e.date)continue;
  const offsets=reminders(e);if(!offsets.length)continue;
  // A reminder may fall up to seven days before the event.
  const today=localDate(NOW,zone);
  for(let d= -1;d<=8;d++){
   const day=addDays(today,d);if(!occurs(e,day))continue;
   const start=instant(day,String(e.time),zone);if(start===null)continue;
   for(const offset of new Set(offsets)){
    const due=start-offset*60_000;
    if(due>NOW+LOOKAHEAD_MS||due<NOW-LOOKBACK_MS)continue;
    const id=crypto.createHash('sha256').update([subDoc.id,eventDoc.id,day,e.time,offset].join('|')).digest('hex');
    const ref=db.collection('pushDeliveryClaims').doc(id);
    dueCount++;
    if(DRY_RUN){console.log(`DRY RUN: due reminder event=${eventDoc.id} date=${day} offset=${offset}m`);continue;}
    const claimed=await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);const old=snap.data();
      if(old?.status==='sent'||old?.status==='sending'&&old.leaseUntil?.toMillis()>Date.now())return false;
      tx.set(ref,{status:'sending',leaseUntil:admin.firestore.Timestamp.fromMillis(Date.now()+LEASE_MS),subscriptionId:subDoc.id,eventId:eventDoc.id,occurrenceDate:day,offset,attempts:admin.firestore.FieldValue.increment(1),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return true;
    });
    if(!claimed)continue;
    try{
      await webpush.sendNotification(sub.subscription,JSON.stringify({title:String(e.title||'Pocket Docket reminder').slice(0,100),body:offset?`Starts in ${offset} minutes`:'Starts now',tag:id}),{TTL:3600});
      await ref.set({status:'sent',sentAt:admin.firestore.FieldValue.serverTimestamp(),leaseUntil:admin.firestore.Timestamp.fromMillis(0)},{merge:true});sent++;
    }catch(err){failed++;console.error(`Push error status=${err.statusCode||'unknown'} reason=${safeReason(err)}`);
      if([404,410].includes(err.statusCode))await subDoc.ref.update({enabled:false});
      await ref.set({status:'failed',lastErrorCode:err.statusCode||null,updatedAt:admin.firestore.FieldValue.serverTimestamp(),leaseUntil:admin.firestore.Timestamp.fromMillis(0)},{merge:true});
    }
   }
  }
 }
}
console.log(`Mode=${DRY_RUN?'DRY_RUN':'LIVE'} subscriptions=${subscriptions.size} due=${dueCount} sent=${sent} failed=${failed} skipped=${skipped}`);
if(failed)process.exitCode=1;
