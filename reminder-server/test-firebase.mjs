
import admin from 'firebase-admin';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'pocket-docket-82820'
});

const db = admin.firestore();

console.log('Testing Pocket Docket Firebase connection...');

try {
  const subscriptions = await db
    .collection('pushSubscriptions')
    .limit(1)
    .get();

  console.log('SUCCESS: Connected to Firestore!');
  console.log('Subscription sample count:', subscriptions.size);
  console.log('No data was modified.');
} catch (error) {
  console.error('FAILED: Could not access Firestore.');
  console.error(error.message);
  process.exitCode = 1;
}
