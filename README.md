# TurboTracker

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that tracks narrative state — time, location, weather, heart meter, and per-character details — across every AI message in your chat.

---

## Features

- **Always-visible tracker** — Time, Location, Weather, and Heart Meter are permanently displayed above each AI message, never hidden behind a dropdown
- **👁️ Tracker panel** — a collapsible section per message holds the Characters Present list and action buttons
- **Characters Present** — a nested dropdown listing every character in the scene with their current Outfit, State, and Position
- **💘 Heart Meter** — tracks romantic interest (0–69,999) with color-coded emoji indicators
- **Regenerate Tracker** — re-ask the AI to infer tracker data for any individual message
- **Edit Tracker** — manually edit any tracker field inline directly in the chat
- **Retroactive population** — one-click button to fill in tracker data for every message in an existing chat
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
- name: Alice | outfit: Blue dress | state: Happy | position: Near the fountain
- name: Bob   | outfit: Casual jeans | state: Nervous | position: Sitting on a bench
[/TRACKER]
```

The extension parses this block, stores the data with the message, and renders it as a UI panel above the message text. The raw tags are stripped from the visible message.

---

## Tracker UI

Each AI message displays a permanent info bar followed by a collapsible **👁️ Tracker** panel.

**Always visible:**

| Field | Description |
|---|---|
| ⏰ Time | In-world date and time |
| 🗺️ Location | Current scene location |
| 🌤️ Weather | Weather conditions and temperature |
| 💘 Heart Meter | Romantic interest level with emoji indicator |

**Inside the 👁️ Tracker dropdown:**

- **Characters Present** — a nested sub-dropdown; each character shows their Outfit, State, and Position
- **Regenerate Tracker** — asks the AI to re-infer the tracker data for that specific message based on surrounding context
- **Edit Tracker** — opens an inline edit form so you can manually adjust any field; supports all tracker fields and character entries

---

## Heart Meter Levels

| Range | Emoji |
|---|---|
| 0 – 4,999 | 🖤 |
| 5,000 – 19,999 | 💜 |
| 20,000 – 29,999 | 💙 |
| 30,000 – 39,999 | 💚 |
| 40,000 – 49,999 | 💛 |
| 50,000 – 59,999 | 🧡 |
| 60,000+ | ❤️ |

The AI can shift the heart meter by a maximum of **10,000 points per message**.

---

## Settings

Open **Extensions → TurboTracker** in the SillyTavern sidebar:

| Setting | Description |
|---|---|
| Enable TurboTracker | Toggle the extension on/off |
| Populate All Messages | Ask the AI to retroactively generate tracker data for all messages missing it |

---

## Tips

- **New chats** — TurboTracker starts working immediately on the first AI response
- **Existing chats** — Use **Populate All Messages** to backfill tracker data; the AI infers values from each message's surrounding context
- **Regenerate** — use the Regenerate Tracker button on any message to re-infer its tracker state without affecting the rest of the chat
- **Edit** — use Edit Tracker to manually correct any field; characters are entered one per line in the same pipe-separated format the AI uses
- **Editing messages** — if you manually edit an AI message and include a `[TRACKER]` block, TurboTracker will pick it up automatically

---

## Author

Made by [Kuma3D](https://github.com/Kuma3D)
Inspired by [PTTracker](https://github.com/Kuma3D/PTTracker) and [SillyTavern-Tracker](https://github.com/kaldigo/SillyTavern-Tracker)
