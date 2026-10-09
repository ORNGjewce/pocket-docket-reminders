
import admin from 'firebase-admin';
import webpush from 'web-push';
import crypto from 'node:crypto';

// Check that the required notification secrets are available.
const required = [
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT'
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error('Missing secret ' + key);
  }
}

// Authenticate with temporary Google Cloud credentials.
// No permanent Firebase service-account JSON key is needed.
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'pocket-docket-82820'
});

const db = admin.firestore();

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const now = Date.now();
const WINDOW_MS = 12 * 60 * 1000;
const HORIZON_MS = 5 * 60 * 1000;

const subs = await db
  .collection('pushSubscriptions')
  .where('enabled', '==', true)
  .get();

const households = new Map();
let sent = 0;

for (const subDoc of subs.docs) {
  const sub = subDoc.data();

  if (!sub.subscription?.endpoint || !sub.householdId || !sub.uid) {
    continue;
  }

  // Verify the subscriber still belongs to the household.
  const member = await db
    .doc(`households/${sub.householdId}/members/${sub.uid}`)
    .get();

  if (!member.exists) {
    continue;
  }

  // Cache household events to avoid unnecessary repeated reads.
  if (!households.has(sub.householdId)) {
    const events = await db
      .collection('households')
      .doc(sub.householdId)
      .collection('events')
      .get();

    households.set(sub.householdId, events);
  }

  for (const doc of households.get(sub.householdId).docs) {
    const e = doc.data();

    if (!Array.isArray(e.who) || !e.time) {
      continue;
    }

    // Match the account or linked household member profile.
    const mine = new Set([sub.uid]);
    const m = member.data();

    if (m.accountId) mine.add(m.accountId);
    if (m.id) mine.add(m.id);

    if (!e.who.some(w => mine.has(w))) {
      continue;
    }

    const reminders = Array.isArray(e.reminders)
      ? e.reminders
      : e.remind !== undefined && e.remind !== ''
        ? [e.remind]
        : [];

    // Currently supports only one-time events.
    // Recurring events need separate handling.
    if (!e.date || (e.repeat && e.repeat !== 'none')) {
      continue;
    }

    const time = String(e.time);

    if (!/^\d{2}:\d{2}$/.test(time)) {
      continue;
    }

    // Only explicitly UTC events are supported for now.
    // Never guess the user's local timezone.
    const timezone = e.timezone || 'UTC';

    if (timezone !== 'UTC') {
      continue;
    }

    const eventAt = Date.parse(`${e.date}T${time}:00Z`);

    if (!Number.isFinite(eventAt)) {
      continue;
    }

    for (const minutes of reminders) {
      const offset = Number(minutes);

      if (!Number.isFinite(offset) || offset < 0) {
        continue;
      }

      const due = eventAt - offset * 60000;

      if (due > now + HORIZON_MS || due < now - WINDOW_MS) {
        continue;
      }

      // Generate a unique delivery identifier.
      const digest = crypto
        .createHash('sha256')
        .update([
          subDoc.id,
          doc.id,
          e.date,
          time,
          offset
        ].join('|'))
        .digest('hex');

      const claim = db.collection('pushDeliveryClaims').doc(digest);

      // Prevent duplicate reminder deliveries.
      try {
        await db.runTransaction(async tx => {
          const existing = await tx.get(claim);

          if (existing.exists) {
            throw new Error('ALREADY_CLAIMED');
          }

          tx.create(claim, {
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            subscriptionId: subDoc.id,
            eventId: doc.id
          });
        });
      } catch (err) {
        if (err.message === 'ALREADY_CLAIMED') {
          continue;
        }

        throw err;
      }

      // Send the push notification.
      try {
        await webpush.sendNotification(
          sub.subscription,
          JSON.stringify({
            title: String(e.title || 'Pocket Docket reminder').slice(0, 100),
            body: offset
              ? `Starts in ${offset} minutes`
              : 'Starts now',
            tag: digest
          }),
          {
            TTL: 3600
          }
        );

        sent++;
      } catch (err) {
        console.error(
          'Push delivery error',
          err.statusCode || err.message
        );

        // Remove expired or invalid push subscriptions.
        if ([404, 410].includes(err.statusCode)) {
          await subDoc.ref.delete();
        }
      }
    }
  }
}

console.log(
  `Sent ${sent} reminder(s) from ${subs.size} subscription(s).`
);
