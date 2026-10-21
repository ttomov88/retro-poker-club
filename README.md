# Retro Poker Club

A personal-use, offline-first PWA for tracking private poker events: buy-ins (with rebuys), per-player results, all-time player stats, and a chip reference sheet. No backend, no server — everything lives in IndexedDB on your phone.

## Deploy to GitHub Pages

1. Create a new repo, e.g. `retro-poker-club`, under your GitHub account.
2. Push all files in this folder to the repo root (`index.html`, `styles.css`, `app.js`, `db.js`, `sw.js`, `manifest.json`, `icons/`).
3. In the repo settings, enable **GitHub Pages** from the `main` branch, root folder.
4. Visit `https://<your-username>.github.io/retro-poker-club/` — it should load and be installable (Chrome menu → "Add to Home screen" / "Install app").

## Data & backups

- All data is stored locally on your phone (IndexedDB). Nothing is sent anywhere.
- Auto-backup (on by default, toggle in Backup): a JSON file is saved to your Downloads folder every time you close an event.
- The app asks Chrome for persistent storage, so the data isn't evicted when the phone runs low on space.
- Clearing Chrome's "Cookies and site data" still wipes the app's data. If the app opens empty, it offers a one-tap restore from your latest backup file in Downloads.
- Safe way to clear Chrome: in Delete browsing data → Advanced, untick "Cookies and site data".

## Notes

- Buy-ins are entered directly in euros; the Chips tab is a reference sheet only (denomination → euro value, and how many of each you own) and doesn't affect calculations.
- An event can be reopened after closing, in case you need to fix a mistake.
- Tap the logo/name in the header from anywhere to jump back to the Events list.
- Players are archived, never deleted: archived players are hidden from new events but keep their stats. Adding the same name again restores them.
- Quick buy-ins: +€20 on each player row, and €20 / €40 buttons in the Add buy-in popup.
