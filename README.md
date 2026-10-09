# Pocket Docket Reminders — private server prototype

This repository contains only the server-side prototype. It does not contain the PWA or Firebase credentials.

## Current status
- GitHub Actions is manual-only until verified; no scheduled delivery is enabled.
- Only explicit UTC, non-recurring event dates are supported. Existing local-time events will not produce notifications.
- The server uses a Firebase service account and VAPID secrets configured in GitHub repository Actions secrets. Never commit credentials.
- Do not run the workflow until Firestore data paths, authorization, timezone handling, and delivery behavior are reviewed.
- `pushDeliveryClaims` prevents some duplicates but failed sends can lead to missed reminders.

Next steps: inspect schema, restrict service-account permissions, add timezone and recurrence handling, set VAPID keys, then run a controlled test.
