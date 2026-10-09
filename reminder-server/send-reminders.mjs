import admin from 'firebase-admin';
import webpush from 'web-push';
import crypto from 'node:crypto';
const required=['FIREBASE_SERVICE_ACCOUNT_JSON','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT'];
for(const key of required)if(!process.env[key])throw Error('Missing secret '+key);
admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))});
const db=admin.firestore();
webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
const now=Date.now(), WINDOW_MS=12*60*1000, HORIZON_MS=5*60*1000;
const subs=await db.collection('pushSubscriptions').where('enabled','==',true).get();
const households=new Map();let sent=0;
for(const subDoc of subs.docs){
 const sub=subDoc.data();if(!sub.subscription?.endpoint||!sub.householdId||!sub.uid)continue;
 // Membership checked again server-side, including when a user leaves a household.
 const member=await db.doc(`households/${sub.householdId}/members/${sub.uid}`).get();if(!member.exists)continue;
 if(!households.has(sub.householdId))households.set(sub.householdId,await db.collection('households').doc(sub.householdId).collection('events').get());
 for(const doc of households.get(sub.householdId).docs){
  const e=doc.data();if(!Array.isArray(e.who)||!e.time)continue;
  // Account UID or a household member profile linked to this account.
  const mine=new Set([sub.uid]);const m=member.data();if(m.accountId)mine.add(m.accountId);if(m.id)mine.add(m.id);
  if(!e.who.some(w=>mine.has(w)))continue;
  const reminders=Array.isArray(e.reminders)?e.reminders:(e.remind!==undefined&&e.remind!==''?[e.remind]:[]);
  // Initial scheduler: explicit one-time event dates only. Recurrence needs separate expansion.
  if(!e.date||e.repeat&&e.repeat!=='none')continue;
  const time=String(e.time);if(!/^\d{2}:\d{2}$/.test(time))continue;
  const timezone=e.timezone||'UTC';
  // UTC-only until timezone is captured in the client; never guess user's local offset.
  if(timezone!=='UTC')continue;
  const eventAt=Date.parse(`${e.date}T${time}:00Z`);if(!Number.isFinite(eventAt))continue;
  for(const minutes of reminders){
   const offset=Number(minutes);if(!Number.isFinite(offset)||offset<0)continue;
   const due=eventAt-offset*60000;
   if(due>now+HORIZON_MS||due<now-WINDOW_MS)continue;
   const digest=crypto.createHash('sha256').update([subDoc.id,doc.id,e.date,time,offset].join('|')).digest('hex');
   const claim=db.collection('pushDeliveryClaims').doc(digest);
   try{await db.runTransaction(async tx=>{const existing=await tx.get(claim);if(existing.exists)throw Error('ALREADY_CLAIMED');tx.create(claim,{createdAt:admin.firestore.FieldValue.serverTimestamp(),subscriptionId:subDoc.id,eventId:doc.id})})}
   catch(err){if(err.message==='ALREADY_CLAIMED')continue;throw err}
   try{await webpush.sendNotification(sub.subscription,JSON.stringify({title:String(e.title||'Pocket Docket reminder').slice(0,100),body:offset?`Starts in ${offset} minutes`:'Starts now',tag:digest}),{TTL:3600});sent++}
   catch(err){console.error('Push delivery error',err.statusCode||err.message);if([404,410].includes(err.statusCode))await subDoc.ref.delete()}
  }
 }
}
console.log(`Sent ${sent} reminder(s) from ${subs.size} subscription(s).`);
