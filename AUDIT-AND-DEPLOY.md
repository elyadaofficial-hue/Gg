# Life Dashboard v9: audit, fixes, deploy

## Tested (Chromium via Playwright, 390x844, served from localhost)
All 7 tabs + goals / review / results / history open · data survives reload · CSV import (quoted commas, escaped quotes, duplicates, bad rows) · JSON export -> wipe -> import restores · invalid backup rejected · corrupted storage keeps a copy and shows a banner · service worker installs, caches the shell, and the app starts offline · RTL and light/dark toggle · no unexpected console errors.

## NOT tested (needs a real device or setup)
Android/iOS install prompt and standalone mode · SW update toast on a second deploy · Google Calendar login, token expiry and reminder sync (needs your OAuth origin) · maskable icon appearance (generated, not seen on a launcher) · iOS Safari storage eviction · visual QA on tablets.

## Audit findings
- **sw.js was empty** (v8): no offline start. Now: versioned shell cache, network-first navigation with 4s timeout and cache fallback, runtime cache for Google Fonts only, Calendar/Google APIs never cached, old caches deleted on activate, update applied only after the user taps "refresh".
- **Storage:** everything is one JSON blob in localStorage (`life-dashboard-v2`) plus small keys (`dash-mode`, `dash-pin`, `quote-*`). It is ~tens of KB, far below quota, so IndexedDB is not needed yet. Risks fixed: corrupt JSON used to be overwritten by the next save (now copied to `life-dashboard-corrupt-*`, never pruned); blocked storage / quota errors were silent (now a banner and a toast); added `navigator.storage.persist()` to reduce eviction risk.
- **Backup:** now a versioned envelope `{app, schema, exportedAt, data}`. Import accepts old raw backups, validates structure, refuses newer schemas, shows record counts, and auto-snapshots current data first.
- **CSV:** old parser used `split(',')` (broke on commas in names) and silently capped rows. Replaced with a quote-aware parser (escaped quotes, `;` delimiter, BOM, newlines in quotes), header validation, duplicate skipping against existing data, and a result summary.
- **Firebase:** placeholder config removed, scripts removed, cloud buttons removed. Nothing initializes. **Firebase is not needed now**: JSON backup covers data safety.
- **PIN:** it only hides the UI. The PIN is stored in plain localStorage, so anyone with browser access can read or bypass it. Relabelled "screen lock (not encryption)" with a warning in the setup prompt.
- **Google Calendar:** a client ID exists, but it only works from origins you authorised in Google Cloud. Expired tokens (401) now clear the session and show "reconnect"; failed reminder sync is reported instead of claiming success.
- **PWA:** manifest got `id` and categories; icon-512 has white corners so a real maskable icon was generated (`icon-maskable-512.png`).
- **UX/UI:** Emoji icons kept (nav converted to SVG then reverted at your request), 44px touch targets, no text under 12px, toasts replace native `alert()`, keyboard/ARIA support, focus rings, light theme softened, tablet/desktop width, reduced-motion/transparency/contrast respected.

## Remaining limitations
- `confirm()`/`prompt()` are still native (used for destructive confirmations and goal "next step").
- Workflow simplification beyond the above was not done. No new features were added, as requested.
- No cross-device sync. Use export/import.

## Future integrations (not built)
Shared data worth exposing later: sleep (`entries.sleep`), workouts (`entries.workout`), nutrition (`entries.nutrition`), goals. The backup envelope (`schema` + `data`) is the stable contract. Easiest path: each app exports the same kind of JSON and this app imports a named section; no shared database needed.

## Deploy
Upload the folder contents (keep `.well-known/`) to any HTTPS host (GitHub Pages, Netlify, Cloudflare Pages). Service workers need HTTPS. To ship an update: change `VERSION` in `sw.js`, upload; users see "new version available".
Keep your existing origin so existing data (per-origin localStorage) is preserved.

## Backup / restore
Home -> "גיבוי נתונים" downloads `life-dashboard-backup-DATE.json`. Restore: "שחזור מגיבוי", choose the file, confirm the counts. An automatic snapshot of current data is kept (last 3) under Results -> backup.

## v9.1 (step 1 of the V9 master prompt)
Implemented and browser-tested:
- **Daily reflection (Home):** autosaves 0.5s after typing and on leaving the page or screen, stored per date, never touches other days, empty text removes the entry (no blank records). Past days are editable from History (tap a day).
- **Clickable history:** every module's month calendar is now tappable. A day opens its real records with edit, delete (with undo) and "add record to this day". Month back/forward and tappable 12-month bars. Future days are disabled. Unified History screen: day panel lists records, jump buttons to each module, and an editable reflection.
- **Date field** on every module form (edit moves a record to another date). Future dates are refused.
- **Workout types:** Push / Pull / Legs / אחריי / Other. Other shows a custom-name field. Old records ("כוח" etc.) are kept as they were and still display and edit. אחריי sessions are not counted toward the weekly gym target.
- **Hideable modules:** Home -> "התאמה אישית ומודולים". Data is never deleted, the setting is saved in backups. Navigation keeps equal counts on both sides of Home; with an odd number visible a Settings button fills the gap. If everything is hidden only Home remains; Settings is reachable from the Home screen.
Not tested: Sales day panel (it has no edit, only delete); real touch devices; iOS keyboard behavior.
Not yet done (next steps): Home redesign, Weekly Review tab (the existing review screen is unchanged), nutrition, Calendar persistence.

## v9.2 (step 2: Home refinement + Weekly Review)
- **Home:** one restrained purple glass style for all cards (lighter gradient, softer border, consistent 16px padding and 22px radius), 2-column quick buttons, 44px controls. Same information as before; no new widgets.
- **Weekly Review (new screen, Home -> "שבועי"):** the 8 sections from your sheet (לשמור, לזרוק, מה מעכב אותי?, בדיקת מטרות, נקודה אחת לשיפור, ממה אני צריך להפסיק?, מחשבות ורפלקציה, דברים שאני צריך לעשות). Autosaves 0.5s after typing and on leaving. Stored per week (`state.weekly[weekStart]`), included in JSON backup. Previous/next week, date jump, list of past weeks, delete with confirmation. Future weeks are refused. Empty sections are not saved.
- The older "סיכום" screen (`review`) is untouched and still reachable; its Home button was replaced by the new one.
- Tested in Chromium 390x844: 8 sections render, autosave, survives reload, week navigation keeps weeks separate, next-week disabled on the current week, data present in localStorage. Not tested: real phone keyboard, light theme on Home, import of a backup containing `weekly` (normalize keeps it, not exercised).
- SW version bumped to v9.2.0 so installed copies show the update prompt.

## v9.3 (step 3: nutrition foundation)
- **Food library:** name, kcal/protein/carbs/fat/cholesterol per 100g (all optional except name + one value), source note, edit, delete (confirm; existing log entries are kept). Most-used foods first.
- **Gram calculator:** pick food, type grams, live result; "add to log" saves an entry. Deterministic: per100 x grams / 100, 1 decimal (calories whole). Example: 400 kcal/20P/50C/10F per 100g x 300g = 1200 / 60 / 150 / 30 (tested).
- **Daily totals:** choose which of the 5 values show (at least one stays on); saved in settings and backups. Goal bar kept (optional, unchanged).
- **Entry form** gained optional carbs, fat, cholesterol. Old entries (name, calories, protein) are untouched. Entries store date + time, newest first, editable/deletable, and appear in History day panels.
- Not built yet (step 4): text/voice parsing, barcode, photo, Gemini. The calculator's single add path is where they will plug in.

## v9.4 (step 4: Google Calendar login)
**Why it asked every time:** the app uses Google Identity Services' browser-only token flow. That gives an access token that lasts about 1 hour and NO refresh token, and the app kept it in sessionStorage, which is erased when the tab/PWA closes. So every launch started logged out.
**What changed:** the token still lives only in memory/sessionStorage (never in localStorage). The app remembers a non-secret flag that you connected once, and on launch or on expiry (401) it re-requests a token silently (`prompt:''`). If Google needs a click (popup blocked, Google session ended) the card shows "חבר מחדש". Revoked access clears the flag and says so. New "נתק" button revokes the token.
**Unavoidable limit:** a true refresh token requires the OAuth code flow with a client secret, i.e. a small backend/serverless function. Silent re-auth works only while you are signed in to Google in that browser; Chrome may block it in some installed-PWA/third-party-cookie setups. Not tested against real Google (needs your authorised origin).
**Needs your decision:** the scope is `calendar.readonly`, but reminder sync creates/edits/deletes events, which that scope does not allow. Writing needs `calendar.events` (read + write events). Not changed without your approval; it will trigger one new consent screen.

## v9.5 (step 5: barcode + research)
**Built: barcode lookup (Nutrition tab).** Type a barcode (8-14 digits) or, where the browser has `BarcodeDetector` (Chrome on Android), tap 📷 to scan. It queries Open Food Facts (`/api/v2/product/{code}`; no key, CORS enabled, community data under ODbL, attribution kept in the food's source field). The result only PRE-FILLS the food form (per 100g, cholesterol converted g -> mg); you check it against the label, edit, save to your library, then use the gram calculator. Not found / offline / bad code each give a clear message and manual entry still works. Tested with mocked responses only (no internet in my sandbox): found, not found (404 and status 0), offline, short code, cholesterol conversion. NOT tested: real Open Food Facts, camera scanning, iOS (Safari lacks BarcodeDetector; manual entry only).
**Voice:** keyboard dictation (Android mic key) already works in every text field. In-app speech recognition not added.
**Text parsing ("300g rice and 150g chicken"):** not built. Reliable no-AI version = match words against your library and grams, show a preview, save after confirmation. Possible next step.
**Photo recognition:** not built.

### Gemini API (research, based on third-party pricing pages from mid-late 2026; verify on ai.google.dev before deciding)
- A Gemini app subscription does not include API access. The API has a separate free tier (Google AI Studio, no card) for Flash / Flash-Lite models; Pro-class models are paid-only. Free limits are modest and change often.
- Free-tier content may be used by Google to improve its products; paid-tier content is not. Food photos and diary text are personal, so paid tier is the safer choice if you adopt it.
- Suited to: reading nutrition labels, parsing free text/voice transcripts, rough photo estimates. Photo portion estimates stay approximate and must be confirmed.
- Security: the key cannot live in this front-end. It needs a tiny serverless proxy (e.g. Cloudflare Worker / Netlify function, both have free tiers) that holds the key and limits requests. That is a new service, so it needs your approval. Until then the app stays fully usable without AI.
### StrongUp
I found nothing about an official API or export for "StrongUp". Search results were about the different app "Strong" (strong.app), which has a CSV export; unofficial API scrapers exist but are not public/official. Next step for you: check StrongUp's settings for an export. If a CSV exists, a CSV import into Workouts is feasible; no integration was built.
### Firebase
Removed earlier (placeholder config). Local storage + JSON backup is enough now. Cloud sync only becomes worthwhile for multi-device use; it would need a real Firebase project (free Spark tier exists) and your approval.
### Future compatibility
Backup envelope `{app, schema, exportedAt, data}` is the contract; `foods`, `entries.nutrition`, `weekly`, `reflect` are plain JSON, so your separate tracking and food-diary apps can read/write the same shapes by import/export.

## v9.6 (step 6: text entry + final test pass)
- **Free-text entry (Nutrition):** "300 גרם אורז ו150 גרם חזה עוף" or "I ate 300g rice and 150g chicken". Split into items, grams extracted, each matched ONLY to foods in your library (no invented values). Preview with editable food + grams per row; nothing is saved until you tap "אשר והוסף"; unmatched rows are skipped and reported. Limits: a food whose name starts with the letter ו may be split wrongly; items without grams need the grams typed in the preview.
- **Final checks run (Chromium 390x844, localhost):** weekly review save/reload/week switching; gram calculator (400/20/50/10 x 300g = 1200/60/150/30) and decimals; library add/edit; totals chips; barcode (mocked Open Food Facts: found/not found/offline/short code); text parser (Hebrew, English, unmatched row, nothing saved before confirm); Calendar state logic (linked/reconnect/revoked); JSON backup -> wipe -> import restores reflections, weekly reviews, foods, nutrition view, hidden modules and workout types (אחריי, Other + custom name); hidden module keeps nav balanced (5 modules + Home + Settings filler); service worker installs, caches v9.6.0, app starts offline with data intact; no page errors.
- **Not tested anywhere:** real touch devices and phone keyboards, iOS, real Google login, real Open Food Facts, camera scanning, SW update toast on a second deploy, light theme on the new screens, Sales day-panel edit (does not exist).

## v9.7 (microphone button)
Nutrition -> free-text card: a 🎤 button next to "פענח". Tap to start (he-IL), the transcript is typed into the text box (appended to existing text), tap ⏹️ to stop. Nothing is saved or parsed automatically: you review the text, tap "פענח", review the preview, then confirm. Shown only where the browser supports the Web Speech API (Chrome/Edge/Samsung Internet on Android; Safari partial; Firefox no). Clear messages for denied permission, no speech, no network, no microphone. Privacy: in Chrome the audio is sent to Google's speech service by the browser (needs internet); the app itself sends nothing anywhere and uses no API key. Tested with a mocked speech API only (start, transcript, stop, status, parse); NOT tested with a real microphone or on a phone. The keyboard's own mic key keeps working as a fallback.

## v9.8 (food-log flow: speak -> total)
- **Speak and it is logged:** when dictation ends the app parses automatically. If every item matches a library food and has grams, it is added to today's total immediately (no preview, no extra tap). Matching is exact library data, so no estimates are involved. Mistakes: "מחק" on the last-entry card.
- **Last entry only:** a "הרשומה האחרונה" card shows the latest entry's calories/protein/carbs/fat/cholesterol; the running daily total sits above it. Earlier entries stay in the history list below, not in this card.
- **End the day:** say or type "סיים את היום" (or "end the day"), or tap the button, for a summary of all five values and the entry count. Values missing from an entry are not counted.
- **Food not in the library:** the preview lists it with "הוסף ... לספרייה". Enter its per-100g values once; it is saved and the dictated amount is added to today automatically. Next time it is matched at once.
- **Limit vs. a chat AI:** values come only from your library/labels/barcode, never guessed. Instant "tell it any food" needs an AI service (Gemini via a small server-side proxy) and your approval.
- Tested with a mocked speech API: auto-add of two items (638 kcal, 54.6 g protein, hand-checked), unmatched food -> add to library -> auto-added (532 kcal), end-day summary (1170 kcal over 3 entries). Not tested with a real microphone.

## v9.9 (any food, instantly — optional AI)
- Speak/type a food that is NOT in your library -> if "חיבור AI" is configured, it is looked up, saved to the library (marked as an AI estimate), and added to today at once, labelled "(הערכה)". Next time it matches the library with no AI call. Editing a food in the library clears its estimate flag.
- Arithmetic stays deterministic: the AI only returns per-100g values and a weight; the app multiplies. Implausible AI numbers (e.g. 5000 kcal/100g) are rejected; any failure falls back to the preview with "add to library".
- Toggle "בדוק לפני הוספה": AI items show in the preview first so you can fix the food/grams before they are added. Any entry can be edited or deleted afterwards.
- Without AI configured nothing changes, plus a hint to connect it.
- Setup: `ai-proxy/README.md` + `ai-proxy/worker.js` (Cloudflare Worker, key kept as a secret, only your site's origin allowed). Use the Gemini FREE tier, no billing. Tested against a mocked proxy only; the worker was syntax-checked but NOT run against real Gemini/Cloudflare. Free-tier prompts may be used by Google; the model name default (`gemini-flash-latest`) must be checked in AI Studio.

## v10.0 (first V10 item: weekly nutrition averages)
Weekly Review now has a "תזונה השבוע" card: average daily calories and protein, a 7-day strip, and how many days the average is based on. Only days with a recorded value count; a day with no entries (or no protein value) shows "—" and is excluded, while an explicitly entered 0 counts as 0. Future days show "·". Tested: calories 2000/1000/0 -> avg 1000 over 3 days; protein 120/missing/0 -> avg 60 over 2 days; empty week message.
Not yet built from the V10 doc (details undecided, see chat): AI label scanner, late-night catch-up, evening reset/shutdown checklist, sleep target, calendar reminder.

## v10.1 (Evening Reset, push reminders, label scanner, catch-up)
See `V10-NOTES.md` for features, setup (Netlify Functions + VAPID keys + updated AI Worker), limitations and test results. SW version v10.1.0.
