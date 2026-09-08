# TurboTracker

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that tracks narrative state — time, location, weather, heart meter, and per-character details — across every message in your chat.

---

## Features

- **Always-visible tracker** — Time, Location, Weather, and Heart Meter are permanently displayed above each message, never hidden behind a dropdown
- **👁️ Tracker panel** — a collapsible section per message holds the Characters Present list and action buttons
- **Characters Present** — each character in the scene tracked with Description, Outfit, State, and Position
- **💘 Heart Meter** — tracks romantic interest (0–99,999) with color-coded emoji indicators; fully configurable color ranges, sensitivity, and a customizable meaning for each tier that's injected into the prompt so the AI portrays the character at the right emotional level
- **Group-chat support** — in group chats each character carries their own heart value; only the speaking character's heart shifts per response, everyone else's carries forward
- **Regenerate Tracker** — re-ask the AI to infer tracker data for any individual message
- **Regenerate All Trackers** — clear and rebuild every tracker in the chat from scratch in one click
- **Edit Tracker** — manually edit any tracker field inline directly in the chat
- **Retroactive population** — one-click button to fill in tracker data for every message in an existing chat, and fill in any blank fields in trackers that already exist
- **Minimum time advance** — optionally enforce a floor on how much time advances per Regenerate
- **Clean display** — raw tracker tags are stripped from the visible message text; only the formatted UI is shown
- **First-in-context injection** — tracker instructions are injected before the system prompt so they are always prioritized in the token budget
- **Persistent** — tracker data is saved with the chat and survives page reloads
- **Debug log** — optional in-panel log to help diagnose tracker generation and regeneration

---

## Installation

### Option A — Install from URL (recommended)
1. In SillyTavern, open **Extensions → Manage Extensions → Install from URL**
2. Paste: `https://github.com/Kuma3D/TurboTracker`
3. Click **Install** and reload the page

### Option B — Manual install
1. Download or clone this repository
2. Copy the `TurboTracker` folder into:
   ```
   SillyTavern/data/default-user/extensions/TurboTracker/
   ```
3. Reload SillyTavern

---

## How It Works

TurboTracker injects a system prompt that instructs the AI to append a structured block at the end of every response:

```
[TRACKER]
time: 10:30 AM; 05/21/2001 (Monday)
location: Central Park, New York
weather: Sunny, 72°F
heart: 15000
characters:
- name: Alice | description: Brown hair, blue eyes, 5'7, 145 lbs | outfit: Blue dress | state: Happy | position: Near the fountain
- name: Bob   | description: Black hair, brown eyes, 6'1, 190 lbs | outfit: Casual jeans | state: Nervous | position: Sitting on a bench
[/TRACKER]
```

The extension parses this block, stores the data with the message, and renders it as a UI panel above the message text. The raw tags are stripped from the visible message.

---

## Tracker UI

Each message displays a permanent info bar followed by a collapsible **👁️ Tracker** panel.

**Always visible:**

| Field | Description |
|---|---|
| ⏰ Time | In-world date and time |
| 🗺️ Location | Current scene location |
| 🌤️ Weather | Weather conditions and temperature |
| 💘 Heart Meter | Romantic interest level with emoji indicator |

**Inside the 👁️ Tracker dropdown:**

- **Characters Present** — each character listed with four fields: Description, Outfit, State, and Position
- **Regenerate Tracker** — asks the AI to re-infer the tracker data for that specific message based on surrounding context
- **Edit Tracker** — opens an inline edit form so you can manually adjust any field; characters are entered one per line in pipe-separated format

---

## Heart Meter

Tracks the AI character's romantic interest in the user. Range: **0–99,999**.

**Default color ranges** (fully customizable in settings):

| Range | Emoji |
|---|---|
| 0 – 4,999 | 🖤 |
| 5,000 – 19,999 | 💜 |
| 20,000 – 29,999 | 💙 |
| 30,000 – 39,999 | 💚 |
| 40,000 – 49,999 | 💛 |
| 50,000 – 59,999 | 🧡 |
| 60,000 – 99,999 | ❤️ |

The AI is constrained to shift the heart by at most **±N points per response**, where N is controlled by the Heart Sensitivity setting (default ±2,500; max ±5,000).

### Heart level meanings

Each color tier carries a **meaning** — a short description of how the character feels about the user at that level, how receptive they are to advances, how they treat the user, and how stable the stage is. These meanings are injected into the tracker prompt so the AI roleplays the character at the emotional level matching their current heart value, and uses the stability notes to pace how readily the value shifts. Every tier's text is fully editable.

**Defaults** (editable in **Extensions → TurboTracker → Heart Meter → Heart Color Ranges**):

| Tier | Range | Meaning (summary) |
|---|---|---|
| 🖤 Black | 0–4,999 | Neutral — no romantic feelings; not receptive to advances; treats the user as a stranger or new acquaintance. Volatile. |
| 💜 Purple | 5,000–19,999 | Friendly, first interest — starting to warm; mildly receptive; seeks small exchanges. Still volatile. |
| 💙 Blue | 20,000–29,999 | Comfortable and fond — genuine fondness; receptive to light flirting; treats the user as a trusted friend. Moderately stable. |
| 💚 Green | 30,000–39,999 | Warmly attached — clearly attached; receptive and encouraged; seeks the user out, drops subtle hints. Moderately stable. |
| 💛 Yellow | 40,000–49,999 | Smitten — open romantic interest; welcomes advances; actively flirts, seeks one-on-one time. Stable. |
| 🧡 Orange | 50,000–59,999 | Infatuated — strongly enamored; eagerly reciprocates and initiates; bold, protective. Very stable. |
| ❤️ Red | 60,000–99,999 | Devoted — deeply in love; takes the romantic lead; the user is top priority. Highly stable. |

### Group chats

In group chats, every character carries their **own** heart value. Only the character currently speaking may have their heart shift on a given response; every other present character's heart carries forward unchanged. Each character's heart badge is shown inside their card in the tracker panel.

---

## Settings

Open **Extensions → TurboTracker** in the SillyTavern sidebar.

| Setting | Description |
|---|---|
| Enable TurboTracker | Toggle the extension on/off |
| Min Time Advance | Minimum minutes time advances per Regenerate; if the AI returns less, the floor is applied. Set 0 to disable. |
| **💘 Heart Meter** *(dropdown)* | |
| — Default Starting Heart | Heart value assigned at the start of every new chat (0–99,999) |
| — Heart Sensitivity | Controls the maximum heart shift per AI response; 1 = ±500 pts (slow), 10 = ±5,000 pts (fast) |
| — Heart Color Ranges | Set custom Min/Max thresholds for each of the 7 heart color tiers, plus an editable meaning for each tier |
| Populate All Messages | Fill in tracker data for every message missing it, and fill blank fields in trackers that already exist |
| Regenerate All Trackers | Clear and rebuild every tracker in the chat from scratch |
| **🔧 Debug Log** *(dropdown)* | |
| — Enable debug logging | Capture an in-panel log of tracker generation and regeneration for troubleshooting |

---

## Tips

- **New chats** — TurboTracker starts working immediately on the first AI response
- **Existing chats** — Use **Populate All Messages** to backfill tracker data; the AI infers values from each message's surrounding context
- **Blank field fill** — Populate All Messages also scans existing trackers and fills in any blank fields (including the Description field on characters from older chats)
- **Regenerate** — use the Regenerate Tracker button on any message to re-infer its tracker state without affecting the rest of the chat
- **Edit** — use Edit Tracker to manually correct any field; characters are entered one per line in pipe-separated format: `name: Alice | description: ... | outfit: ... | state: ... | position: ...`
- **Editing messages** — if you manually edit an AI message and include a `[TRACKER]` block, TurboTracker will pick it up automatically
- **Heart Sensitivity** — lower values keep the heart meter stable for slow-burn stories; higher values allow bigger swings per exchange
- **Heart meanings** — edit each tier's meaning text to tune how the AI portrays affection at that level; the current tier is marked in the injected prompt, and changes apply to the next generation
- **Regenerate All** — use **Regenerate All Trackers** to rebuild every tracker from scratch when you've changed settings (e.g. sensitivity, meanings) and want the whole chat to reflect them

---

## Author

Made by [Kuma3D](https://github.com/Kuma3D)
Inspired by [PTTracker](https://github.com/Kuma3D/PTTracker) and [SillyTavern-Tracker](https://github.com/kaldigo/SillyTavern-Tracker)
