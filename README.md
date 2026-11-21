# Retro Poker Club

A small PWA for tracking private poker events: buy-ins (with rebuys), per-player results, all-time player stats, and a chip reference sheet. The app is hosted on GitHub Pages; the club data lives in a shared Supabase database so friends can follow along.

## How it works

- **Hosting:** GitHub Pages serves the app (this repo). Every push to `main` goes live in about a minute.
- **Data:** Supabase (project `retro-poker-club`, Frankfurt). Events, players and chips are stored as JSON documents with a version number, so two admins editing the same event at once can't overwrite each other.
- **Sign-in:** email + password. Admins and the owner also enter a code from Google Authenticator. Viewers can turn that on in Settings.
- **Roles:**
  - **Owner:** full access; can't be demoted or removed by anyone.
  - **Admin:** edits everything and manages members.
  - **Viewer:** sees events and stats only.

  The database enforces these rules itself (row-level security), not just the buttons.
- **Joining:** an admin adds the email in Settings → Members. The person opens the app, taps *First time here? Set your password*, and signs in. Only listed emails can create a login.
- **Forgot password / lost phone:** an admin taps the member → *Reset login*, and the person sets a new password the same way.
- **Offline:** the last loaded data stays on the phone, so the app opens and shows everything without a signal. Saving needs a connection.
- **Live updates:** changes by other members appear automatically.
- **Keep-alive:** `.github/workflows/keep-alive.yml` pings the database daily, because free Supabase projects pause after 7 days without activity.

## Data & backups

- **Automatic:** every night at 01:00 UTC the database saves a full copy of players, events, chips and members into its own `backups` table (not reachable from the app). Copies older than 30 days are deleted. A copy is also taken right before any import. Restoring is a single database call (`restore_backup(id)`), which first saves the current state too.
- **Manual:** Export backup (Settings) downloads all club data as a JSON file to the phone, only when you tap it. Nothing is saved to phones automatically.
- **Import backup** (admins only) replaces all club data with a file, in one transaction: if the file is bad, nothing changes.

## Notes

- Buy-ins are entered directly in euros; the Chips tab is a reference sheet only (denomination → euro value, and how many of each you own) and doesn't affect calculations.
- An event can be reopened after closing, in case you need to fix a mistake. Date, location and notes can be edited anytime (pencil next to the title).
- Players added to an event without any buy-in are removed when you close it (after a confirmation), so they don't count as having played.
- Back gesture: steps back one screen; on the Events screen, press back twice within 2 seconds to close the app.
- Tap the logo/name in the header from anywhere to jump back to the Events list.
- Players are archived, never deleted: archived players are hidden from new events but keep their stats. Adding the same name again restores them.
- Share: closed events have a Share button (results image), and the Players screen has Share (all-time stats image incl. ROI and win rate, sorted by net result). Images open Android's share sheet, or download if sharing isn't available.
- Close-out shows a live counter (cashed out / total buy-ins) and each player's result as you type.
- Quick buy-ins: +€20 on each player row, and €20 / €40 buttons in the Add buy-in popup.
