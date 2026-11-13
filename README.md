# Haze Tracker

A progressive web app that shows Singapore's haze levels by region and sends a notification when the PSI reaches a threshold you set.

- **24-hr PSI**: NEA's official reading, from the data.gov.sg real-time PSI API.
- **1-hr PSI (est.)**: NEA does not publish a 1-hr PSI. This is estimated from NEA's 1-hr PM2.5 reading using the PSI PM2.5 breakpoints.
- **Alerts**: pick a region, a measure and a threshold. You are notified when the value rises to the threshold from below.
- **Installable**: add to your home screen from the browser menu (iPhone: Share, then Add to Home Screen).

No build step. Host the repo root as static files over HTTPS (for example GitHub Pages: Settings, Pages, deploy from `main` / root).

## Notification limits

There is no push server, so alerts are checked while the app is open, and in the background only where the browser supports Periodic Background Sync (installed app on Android Chrome). On iPhone, notifications work only after the app is added to the Home Screen (iOS 16.4+). Reliable alerts when the app is closed would need a small server that sends Web Push.

Data: NEA via data.gov.sg, Singapore Open Data Licence v1.0.
