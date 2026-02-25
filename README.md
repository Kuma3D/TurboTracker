# TurboTracker

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that tracks narrative state — time, location, weather, heart meter, and per-character details — across every message in your chat.

---

## Features

- **Always-visible tracker** — Time, Location, Weather, and Heart Meter are permanently displayed above each message, never hidden behind a dropdown
- **👁️ Tracker panel** — a collapsible section per message holds the Characters Present list and action buttons
- **Characters Present** — each character in the scene tracked with Description, Outfit, State, and Position
- **💘 Heart Meter** — tracks romantic interest (0–99,999) with color-coded emoji indicators; fully configurable color ranges and sensitivity
- **Regenerate Tracker** — re-ask the AI to infer tracker data for any individual message
- **Edit Tracker** — manually edit any tracker field inline directly in the chat
- **Retroactive population** — one-click button to fill in tracker data for every message in an existing chat, and fill in any blank fields in trackers that already exist
- **Clean display** — raw tracker tags are stripped from the visible message text; only the formatted UI is shown
- **First-in-context injection** — tracker instructions are injected before the system prompt so they are always prioritized in the token budget
- **Persistent** — tracker data is saved with the chat and survives page reloads

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

---

## Settings

Open **Extensions → TurboTracker** in the SillyTavern sidebar.

| Setting | Description |
|---|---|
| Enable TurboTracker | Toggle the extension on/off |
| **💘 Heart Meter** *(dropdown)* | |
| — Default Starting Heart | Heart value assigned at the start of every new chat (0–99,999) |
| — Heart Sensitivity | Controls the maximum heart shift per AI response; 1 = ±500 pts (slow), 10 = ±5,000 pts (fast) |
| — Heart Color Ranges | Set custom Min/Max thresholds for each of the 7 heart color tiers |
| Populate All Messages | Fill in tracker data for every message missing it, and fill blank fields in trackers that already exist |

---

## Tips

- **New chats** — TurboTracker starts working immediately on the first AI response
- **Existing chats** — Use **Populate All Messages** to backfill tracker data; the AI infers values from each message's surrounding context
- **Blank field fill** — Populate All Messages also scans existing trackers and fills in any blank fields (including the Description field on characters from older chats)
- **Regenerate** — use the Regenerate Tracker button on any message to re-infer its tracker state without affecting the rest of the chat
- **Edit** — use Edit Tracker to manually correct any field; characters are entered one per line in pipe-separated format: `name: Alice | description: ... | outfit: ... | state: ... | position: ...`
- **Editing messages** — if you manually edit an AI message and include a `[TRACKER]` block, TurboTracker will pick it up automatically
- **Heart Sensitivity** — lower values keep the heart meter stable for slow-burn stories; higher values allow bigger swings per exchange

---

## Author

Made by [Kuma3D](https://github.com/Kuma3D)
Inspired by [PTTracker](https://github.com/Kuma3D/PTTracker) and [SillyTavern-Tracker](https://github.com/kaldigo/SillyTavern-Tracker)
