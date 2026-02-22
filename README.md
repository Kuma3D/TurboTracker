# TurboTracker

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that tracks narrative state — time, location, weather, heart meter, and per-character details — across every AI message in your chat.

---

## Features

- **Per-message tracker** — a collapsible "📊 Tracker" panel appears below each AI message
- **Characters Present** — a nested dropdown listing every character in the scene with their current Outfit, State, and Position
- **Heart Meter** — tracks romantic interest (0–69,999) with emoji indicators
- **Clean display** — raw tracker tags are hidden from the chat; only the formatted UI is shown
- **Retroactive population** — one-click button to use the AI to fill in tracker data for older messages that are missing it
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

The extension parses this block, stores the data with the message, and renders it as a collapsible UI. The raw tags are stripped from the visible message text.

---

## Tracker UI

Each AI message gets a **📊 Tracker** dropdown containing:

| Field | Description |
|---|---|
| ⏰ Time | In-world date and time |
| 📍 Location | Current scene location |
| 🌤️ Weather | Weather conditions and temperature |
| Heart Meter | Romantic interest level with emoji |

Inside the **Characters Present** sub-dropdown, each character listed by the AI shows:
- **Outfit** — what they're currently wearing
- **State** — emotional or physical state
- **Position** — where they are in the scene

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
| Prompt scan depth | How many recent messages the injected prompt covers (default: 5) |
| Populate All Messages | Ask the AI to retroactively generate tracker data for messages that are missing it |

---

## Tips

- **New chats** — TurboTracker starts working immediately on the first AI response
- **Existing chats** — Use **Populate All Messages** to backfill tracker data; the AI will infer values from each message's surrounding context
- **Editing messages** — If you manually edit an AI message and include a `[TRACKER]` block, TurboTracker will pick it up automatically

---

## Author

Made by [Kuma3D](https://github.com/Kuma3D)
Inspired by [PTTracker](https://github.com/Kuma3D/PTTracker) and [SillyTavern-Tracker](https://github.com/kaldigo/SillyTavern-Tracker)
