# Dashboard V10.1 — Evening Reset, push reminders, nutrition improvements

## What was built
**Evening Reset (highest priority)**
- Full-screen dark overlay, reachable from a Home card, the notification, an optional in-app prompt, or `?reset=1` deep link. Works every night including weekends; Android Back and Esc close it.
- Check-in "איך הערב שלך?": *על המסלול* (confirm + exit), *קצת מבולגן* (one suggested action, pick another, or skip), *לילה קשה* (3 tiny steps: eat/important → one prep → soft bedtime with optional 1-min breathing). After midnight (00:00–05:00) it collapses to one action → bedtime. No scores, streaks or progress bars; the only record is a tiny private per-night log.
- Recovery actions: 8 built-in, each can be switched off, plus your own (max 12). Completing one is enough.

**Reminders (works with the app closed)**
- Settings: Home card ⚙️ → enable, time, one repeat on/off, repeat interval (10–60 min), "skip tonight", test notification, status panel (support / permission / installed / server / subscription / last sync). Everything persists in the app data (and JSON backup) and is synced to the server.
- Server: Netlify Functions + Netlify Blobs + VAPID Web Push (own zero-dependency RFC 8291 implementation, verified against the RFC test vector). A scheduled function runs every minute, evaluates each subscription in *your* timezone (DST-safe) and sends: 1 reminder, then at most 1 repeat. Tapping the notification, or opening the reset after it, cancels the repeat. Same notification tag + `renotify` means the repeat replaces the first (no duplicates).
- Permission is only requested from an explicit tap after an explanation card, and never again after "denied" (instead: Android steps).
- Auto check-in (Feature 4): once per session, only during the evening window (default from 21:00), not when typing, not if you already used the reset tonight, dismissible, switchable off.

**Nutrition**
- Weekly averages: already shipped in v10.0 (logged days only; "—" ≠ 0). Re-verified.
- Label scanner (Nutrition tab): photo/gallery → AI reads label → fills the *existing* food form (per-100 g, converting per-serving when the serving is in g/ml) → you review against the photo and press "שמור מזון". Unreadable labels, implausible values and macro/calorie mismatches are flagged; nothing is auto-saved; the photo is never stored.
- Catch-up: offered when yesterday/the day before has no nutrition entries (dismissible), or any time from "השלמה בדיעבד". Dictate (🎤) or type, AI organises into meals (+ workout / sleep / study activities), your own food library values override AI guesses, every row is editable, and nothing is saved until "אשר והוסף".

## Files
Changed: `index.html` (new CSS + JS layer appended; no existing function removed), `sw.js` (v10.1.0: push + click handlers, `/api/` never cached), `ai-proxy/worker.js` (+`label`, `catchup` modes; legacy `{text}` unchanged), `ai-proxy/README.md`, `AUDIT-AND-DEPLOY.md`.
New: `netlify.toml`, `package.json`, `netlify/functions/push-api.mjs`, `netlify/functions/push-tick.mjs`, `netlify/lib/{webpush,schedule,store,core}.mjs`, `scripts/generate-vapid-keys.mjs`, `tests/*.test.mjs`, this file.
Dependency: `@netlify/blobs` (the only one; Netlify's own storage).

## Setup (one time, ~10 min)
1. **Deploy with functions.** Plain drag-and-drop of the folder publishes only static files (I could not confirm functions are supported there). Use either: connect the folder to a Git repo on Netlify (build command empty, publish dir `.`), or CLI: `npm install && npx netlify-cli deploy --prod` from this folder. Keep the same site/origin so your data stays.
2. **Create VAPID keys:** `node scripts/generate-vapid-keys.mjs` and add in Netlify → Site configuration → Environment variables: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:you@example.com`). Redeploy. Keep the private key secret; changing keys later requires turning reminders off/on once per device.
3. **Update the AI Worker** (for scanner/catch-up): paste the new `ai-proxy/worker.js` into your Cloudflare Worker and deploy. Variables unchanged. Until updated, those two features show a clear "update the Worker" message; everything else is unaffected.
4. **On the phone:** open the app → Home → Evening Reset ⚙️ → enable → allow notifications → "שלח לי התראת בדיקה". Then set the sound (below). Optional: Chrome menu → Install app.
5. Scheduled functions run only on published (production) deploys; ~43k invocations/month at every-minute cadence. To reduce, change `schedule` in `netlify/functions/push-tick.mjs` (e.g. `*/2 * * * *`).

## Limitations (honest)
- **Sound cannot be chosen from a web page.** Android plays the sound of the notification channel Chrome creates for the site (or your TWA app). Pick it in Android Settings → Apps → Chrome / "לוח היום" → Notifications → site category → Sound. The settings screen explains this and the test button lets you listen. I did not add a fake in-page sound picker: it would not play when the app is closed.
- Delivery depends on Android/Chrome: battery restrictions, Do Not Disturb, silenced channel or blocked notifications can delay or hide it. Typical latency is up to ~1 min after the chosen time; a missed tick is retried for 15 min, never fired hours late.
- Swiping the notification away does NOT cancel the repeat (that is the "ignored" case); tapping it, or opening the reset, does.
- If Chrome rotates/expires the push subscription, it is re-created next time the app is opened (until then reminders can't arrive).
- Server stores only: push endpoint/keys, time, repeat settings, timezone, and tonight's send state. No dashboard content.
- iOS needs "Add to Home Screen" (16.4+) for any push; not tested.

## Testing done
- Node: 28 tests pass (`npm test`): RFC 8291 byte-exact vector, independent decrypt round-trip, VAPID JWT signature, endpoint allow-list, schedule logic (once, grace window, single repeat, cancel before/after first, midnight crossing, DST days, time change, disabled/skipped), full tick with fake push service (dedupe, 410 cleanup, transient-failure retry), API routes (same-origin, caps, lifecycle), service-worker push/click handlers, AI worker modes + validation.
- Browser (Chromium 390×844 and 320×560, mocked push stack + mocked AI): 41 checks pass: home card, all three check-ins and recovery flows, night mode, back/Esc, settings persistence across reload, permission onboarding (no prompt before tap, never after denied), sync payloads, cancel on open, test/skip, backend-missing message, auto check-in (once/session, daytime off, switch off), deep link incl. PIN unlock, weekly averages (2000/1000/0 → 1000; protein missing excluded), label scanner (conversion, not saved until confirm, unreadable), catch-up (offer/dismiss, library beats AI, edit recalculates, date, confirm), all existing tabs render, backup keeps `eveningReset`.
- **Not tested** (needs your phone/accounts): real FCM delivery and sound, Netlify Blobs/scheduler in production, Gemini with real labels/speech, real microphone, TWA behaviour, light-theme polish of the new cards.

## Remaining issues / ideas
- The scanner and catch-up depend on the Gemini free tier and the Worker; accuracy of label reading on curved/glossy packs will vary — that is why review is mandatory.
- Quiet nights (skip specific weekdays) shipped in v10.5.

## v10.2 — Home
Original home order restored (hero, Evening Reset, today, ...). Habit tracking ("מעקב הרגלים") moved up right after "today". Press ✏️ ערוך to reorder habits by dragging ⠿ (or ▲▼); order is saved (`state.homeOrder`, included in backup). Cards (habits, note, calendar, reminders, mood, insights, tools) are collapsible; open/closed state is remembered. Reminders, insights and tools start collapsed.
Home blocks: "↕️ סדר את דף הבית" (under the greeting) opens a compact list of all blocks (Evening Reset, today, habits, note, calendar, reminders, mood, insights, tools). Drag ⠿ or use ▲▼; "↺" restores the default. Saved as `state.homeBlocks`.

## v10.3 — UI polish (apple-design + ui-ux-pro-max + frontend-design)
Drag now tracks the finger 1:1, lifts the row, animates neighbours (FLIP spring), auto-scrolls at the edges, settles with a spring and gives light haptics; keyboard: focus ⠿ and press ↑/↓. Cards animate open/close (Chrome `::details-content`), collapsed cards show a one-glance summary (habit %, mood, note start, counts). 44px targets for edit/arrows/handles/link buttons, press-down feedback everywhere, soft fade under the bottom bar, reduced-motion / reduced-transparency / high-contrast variants. ui-ux-pro-max had no search scripts in this environment, so its priority checklist was applied manually.


## v10.3 → v10.5 merge
`index.html` now includes everything from the v10.5 preview:
- **v10.4**: quick-fill chips (sleep / studies / workout / content), duplicate last entry, 7-day averages.
- **v10.4b**: nutrition evening summary (one record per day), workout quick-log, sleep bed/wake with auto-calculated hours, sleep goal + progress + 7-day bars.
- **v10.4c**: FX layer (ripples, success bursts, goal confetti, count-up) – all disabled under `prefers-reduced-motion`.
- **v10.5 gamification** (Home card): XP, levels + titles, streak with one forgiven rest day per week, 3 daily quests, 9 badges. Derived from entries; not shown inside Evening Reset.
- **Quiet nights**: weekday chips in reminder settings. Server side: `quietDays` accepted by `cleanSettings` and honoured by `decide` (suppresses the first reminder on those weekdays; test added).
`sw.js` VERSION → v10.5.0 so installed apps pick up the update.


## v10.6 — gamification 2.0, feature tour, full feature check
**Gamification 2.0 (Home card)** - all derived from your entries, so re-adding or deleting cannot inflate it.
- New XP: +20 bonus when all 3 daily quests are done, +50 per completed **weekly challenge**, +10 per goal step marked done, +20 per written weekly review.
- **Weekly challenge**: one per week (Sun-Sat) from a pool of 6 (5 active days, 3 workouts, 150 study minutes, sleep goal 4 nights, 4 areas, 2 content days) with a progress bar.
- **Mastery per area**: separate level for workout / nutrition / sleep / studies / content / sales.
- **33 badges** (was 9) with progress on locked ones (e.g. 4/5); tap a badge for its requirement. Includes streaks 3-60, 10/25/50 workouts, study hours, sales, goals, weekly reviews, comeback, all-rounder week, backup, explorer and tour badges.
- Stats: XP this week, best streak, perfect days, challenges. Titles now go up to level 25+.
- Level-ups and new badges show a non-blocking celebration card (auto-closes, never traps taps). Existing progress and badges are granted silently on first run, so no toast flood after updating.
- Streak is now calculated forward through your history (adds "best streak"); one missed day per 7 is still forgiven. The "rest day" note only shows when a streak exists.
- Still not shown inside Evening Reset, and nothing rewards calorie numbers.

**Feature tour** (Home: "🎓 סיור בכל התכונות")
- 22 stops covering every feature (home, game, quick-fill, workout, nutrition summary/library/AI/catch-up, sleep, studies, content, sales, goals, weekly, results, history, habits, notes/mood/insights, Evening Reset, reminders/calendar, backup, customization).
- Each stop explains, gives tips, shows ✅ "tried" / 💡 "not tried yet" (from your data + light usage tracking stored in `game.used`), and has "קח אותי לשם" which jumps to the feature and leaves a "חזרה לסיור" pill.
- Feature map (☰) lists everything with status; the intro suggests what to try first. Android Back/Esc close it. Finishing unlocks a badge.

**Checked in a real browser (Chromium, mobile viewport)**: entry add/edit/delete/undo on every tab, quick chips, duplicate, sleep bed/wake calc, nutrition summary update-not-duplicate, food library + weight calculator, sales (session/roleplay/outreach), goals + step done, weekly review, results (grades/skills/plan), mood/notes, theme, export + backup validation, Evening Reset (all 3 paths + close), home customization, calendar day panel. No console errors.
Changed: `index.html`, `sw.js` (v10.6.0), `package.json`, `netlify/lib/schedule.mjs` (quiet nights, from v10.5), notes.


## v10.7 — home-page reminders as real push notifications
- Home → 🔔 תזכורות יומיות: each reminder now has weekday chips (א-ש; none selected = every day) and a button **"שלח אותן כהתראות לטלפון"**. When on, reminders arrive as real notifications **even when the app is closed**, using the same push setup as Evening Reset (no new keys or env vars). "בדיקה" sends a test.
- Works independently of Evening Reset (you can have either, both, or neither).
- Server (`netlify/lib/schedule.mjs`, `core.mjs`): `settings.reminders` (max 12; id/time/message/days validated), `decideReminders` fires each reminder once per local day inside the same 15-min grace window (never hours late), per-reminder retry on transient failure, a new/edited reminder whose time already passed today does NOT fire late, empty message -> one of the app's coach lines.
- `sw.js` v10.7.0: tapping a reminder opens the app (it no longer cancels/opens Evening Reset).
- Tests: 34 pass (new: validation, weekdays, once-per-day, grace, no-late-fire, retry, payload, SW click).
- Update steps (Node and keys are already set up): unzip, `npm install`, `npx netlify-cli deploy --prod`, link to `elyada-life-dashboard`, then open the app once and turn the new button on.
- Not testable here: real FCM delivery (same as v10.1).


## v10.9 — Weight + progress photos, accounts, cloud sync (Supabase)
**Workout tab:** a collapsible "⚖️ משקל גוף" section sits directly under the consistency (weekly bars) card. Open/closed is remembered. Inside: latest weight, 7-day change, streak, 30-day smooth chart with 7-day average, log/edit today, and progress photos (camera/gallery, grid, full view, delete, before/after compare).

**Menu (☰, top-left):** avatar, name/email, sync status + "sync now", account & profile (name, photo, change password), dark/light, notifications, PIN lock, backup to file, restore from file, restore a previous cloud version (daily snapshots, 14 days), log in / log out.

**Account:** email + password via Supabase Auth. One-time login per device: the session is stored on the device and the refresh token renews silently, so you only log in again if you log out or the session is revoked. Forgot-password and email-confirmation links are handled by the app.

**Sync:** the whole app state is stored as one JSON row per user (`user_data`). Every save is pushed ~2.5s later; the app also pulls on open, when it returns to the foreground, when the connection comes back, and every 60s. Edits made offline are kept and sent later. If two phones edit at the same time they are merged (3-way merge by record id), so neither overwrites the other, and deletions are respected. Logging into a different account never mixes in the previous account's data.

**Photos:** stored on the device (IndexedDB) and uploaded to a private Storage bucket `progress-photos/<user id>/<photo id>.jpg`; other phones download them when the gallery opens.

**Database (already applied to your project):** tables `user_data`, `user_data_history`, row-level security so each user only sees their own rows, triggers (version bump, owner lock, one history snapshot per day, 14-day retention) and the storage bucket + policies. `push_subscriptions` has RLS on and no policies on purpose: only the server (service key) touches it.

**Dashboard settings you still need to check (Authentication):**
1. URL Configuration → Site URL = your deployed address (otherwise reset/confirm emails link to the wrong place).
2. Providers → Email → decide whether "Confirm email" stays on. On = new sign-ups must click a link first (the default mail sender is limited to a few emails per hour). Off = instant sign-up.
3. Consider turning on leaked-password protection and a minimum password length of 8.
