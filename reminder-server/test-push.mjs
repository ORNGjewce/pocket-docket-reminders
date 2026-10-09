import { createECDH } from 'node:crypto';
import admin from 'firebase-admin';
import webpush from 'web-push';

const subscriptionId = process.env.TEST_SUBSCRIPTION_ID;

if (!subscriptionId) {
  throw new Error('Missing TEST_SUBSCRIPTION_ID');
}

for (const key of [
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT'
]) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`);
  }
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'pocket-docket-82820'
});
import { createECDH } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.setPrivateKey(
  Buffer.from(process.env.VAPID_PRIVATE_KEY, 'base64url')
);

const derivedPublicKey = ecdh.getPublicKey().toString('base64url');

if (derivedPublicKey !== process.env.VAPID_PUBLIC_KEY) {
  throw new Error('VAPID public and private keys DO NOT MATCH');
}

if (!/^(mailto:|https:\/\/)/.test(process.env.VAPID_SUBJECT)) {
  throw new Error('VAPID_SUBJECT must begin with mailto: or https://');
}

console.log('VAPID key pair matches.');
console.log('VAPID subject format is valid.');
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const db = admin.firestore();

const doc = await db
  .collection('pushSubscriptions')
  .doc(subscriptionId)
  .get();

if (!doc.exists) {
  throw new Error('Subscription document not found');
}

const data = doc.data();

if (!data.enabled || !data.subscription?.endpoint) {
  throw new Error('Subscription is not enabled or is invalid');
}

await webpush.sendNotification(
  data.subscription,
  JSON.stringify({
    title: 'Pocket Docket Test',
    body: 'Your iPhone background notifications are working!',
    tag: 'pocket-docket-test'
  }),
  { TTL: 300 }
);

console.log('Test push accepted by push service.');
