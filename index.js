import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    generateQuietPrompt,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

const EXT_NAME = 'turbo-tracker';

const DEFAULT_SETTINGS = {
    enabled: true,
    heartPoints: 0,
    heartSensitivity: 5,
};

// ── Heart meter ───────────────────────────────────────────────

function getHeartEmoji(points) {
    if (points < 5000)  return '🖤';
    if (points < 20000) return '💜';
    if (points < 30000) return '💙';
    if (points < 40000) return '💚';
    if (points < 50000) return '💛';
    if (points < 60000) return '🧡';
    return '❤️';
}

/**
 * Clamp a new heart value so it cannot shift more than maxShift from prevHeart.
 * Enforced in code regardless of what the AI outputs.
 * All inputs are coerced to safe integers to guard against NaN from bad settings.
 */
function clampHeart(rawValue, prevHeart, maxShift) {
    const val   = parseInt(rawValue,  10);
    const prev  = parseInt(prevHeart, 10) || 0;
    const shift = Math.max(1, parseInt(maxShift, 10) || 2500);
    if (isNaN(val)) return prev;
    const lo = Math.max(0,     prev - shift);
    const hi = Math.min(69999, prev + shift);
    return Math.max(lo, Math.min(hi, val));
}

/**
 * Advance the H:MM AM/PM portion of a tracker time string by the given minutes.
 * Leaves the date/era suffix (e.g. "; 01/20/31 BBY (Monday)") unchanged.
 * If the format isn't recognised, the original string is returned unmodified.
 */
function advanceTimeString(timeStr, minutes) {
    if (!timeStr) return timeStr;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)(.*)/i);
    if (!m) return timeStr;

    let hours = parseInt(m[1], 10);
    let mins  = parseInt(m[2], 10);
    const period = m[3].toUpperCase();
    const rest   = m[4]; // everything after "AM/PM" (date, era, etc.)

    // Convert to 24-hour
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours  = 0;

    // Advance
    mins  += minutes;
    hours += Math.floor(mins / 60);
    mins   = mins  % 60;
    hours  = hours % 24;

    // Convert back to 12-hour
    const newPeriod = hours >= 12 ? 'PM' : 'AM';
    let   newHours  = hours % 12;
    if (newHours === 0) newHours = 12;

    return `${newHours}:${String(mins).padStart(2, '0')} ${newPeriod}${rest}`;
}

// ── Tag parsing ───────────────────────────────────────────────

/**
 * Parse a [TRACKER]...[/TRACKER] block from raw message text.
 * Returns null if no block is found.
 */
function parseTrackerBlock(text) {
    const match = text.match(/\[TRACKER\]([\s\S]*?)\[\/TRACKER\]/i);
    if (!match) return null;

    const result = { time: null, location: null, weather: null, heart: null, characters: [] };
    const lines = match[1].split('\n');
    let inChars = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (/^characters\s*:/i.test(line)) {
            inChars = true;
            continue;
        }

        if (inChars && line.startsWith('-')) {
            const parts = line.slice(1).trim().split('|').map(p => p.trim());
            const char = { name: '', outfit: '', state: '', position: '' };
            for (const part of parts) {
                const sep = part.indexOf(':');
                if (sep === -1) continue;
                const k = part.slice(0, sep).trim().toLowerCase();
                const v = part.slice(sep + 1).trim();
                if      (k === 'name')     char.name     = v;
                else if (k === 'outfit')   char.outfit   = v;
                else if (k === 'state')    char.state    = v;
                else if (k === 'position') char.position = v;
            }
            if (char.name) result.characters.push(char);
            continue;
        }

        if (!line.startsWith('-')) inChars = false;

        const sep = line.indexOf(':');
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim().toLowerCase();
        const val = line.slice(sep + 1).trim();
        if      (key === 'time')     result.time     = val;
        else if (key === 'location') result.location = val;
        else if (key === 'weather')  result.weather  = val;
        else if (key === 'heart')    result.heart    = val;
    }

    return result;
}

// ── SillyTavern-Tracker import ────────────────────────────────

/**
 * Convert a SillyTavern-Tracker data object to our tt_tracker format.
 */
function convertSTTrackerToTT(stData) {
    if (!stData || typeof stData !== 'object') return null;

    const result = {
        time:       stData.Time     || stData.time     || null,
        location:   stData.Location || stData.location || null,
        weather:    stData.Weather  || stData.weather  || null,
        heart:      null,
        characters: [],
    };

    const charNames = Array.isArray(stData.CharactersPresent) ? stData.CharactersPresent
                    : Array.isArray(stData.charactersPresent) ? stData.charactersPresent
                    : [];

    const charDetails = (stData.Characters && typeof stData.Characters === 'object' && !Array.isArray(stData.Characters))
                      ? stData.Characters
                      : (stData.characters && typeof stData.characters === 'object' && !Array.isArray(stData.characters))
                      ? stData.characters
                      : {};

    for (const name of charNames) {
        const d = charDetails[String(name)] || {};
        result.characters.push({
            name:     String(name),
            outfit:   d.Outfit               || d.outfit   || '',
            state:    d.StateOfDress         || d.State    || d.state    || '',
            position: d.PostureAndInteraction || d.Position || d.position || '',
        });
    }

    if (result.time || result.location || result.weather || result.characters.length > 0) {
        return result;
    }
    return null;
}

/**
 * Try to import tracker data from SillyTavern-Tracker format.
 */
function tryImportSTTracker(msg) {
    if (msg.tracker && typeof msg.tracker === 'object' && Object.keys(msg.tracker).length > 0) {
        return convertSTTrackerToTT(msg.tracker);
    }

    const textMatch = (msg.mes || '').match(/<tracker>([\s\S]*?)<\/tracker>/i);
    if (textMatch) {
        try {
            const data = JSON.parse(textMatch[1].trim());
            return convertSTTrackerToTT(data);
        } catch (_) { /* not valid JSON */ }
    }

    return null;
}

/**
 * Find the most recent tt_tracker in chat messages before the given index.
 */
function getMostRecentTracker(chat, beforeMesId) {
    for (let i = beforeMesId - 1; i >= 0; i--) {
        if (chat[i]?.extra?.tt_tracker) return chat[i].extra.tt_tracker;
    }
    return null;
}

/**
 * Format a tt_tracker object as plain text for use in AI prompts.
 */
function formatTrackerForPrompt(data) {
    if (!data) return 'None';
    let text = `time: ${data.time || 'Unknown'}\nlocation: ${data.location || 'Unknown'}\nweather: ${data.weather || 'Unknown'}\nheart: ${parseInt(data.heart, 10) || 0}`;
    if (data.characters && data.characters.length > 0) {
        text += '\ncharacters:';
        for (const c of data.characters) {
            text += `\n- name: ${c.name} | outfit: ${c.outfit} | state: ${c.state} | position: ${c.position}`;
        }
    }
    return text;
}

// ── HTML helpers ──────────────────────────────────────────────

function esc(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Build the full tracker UI for a message.
 */
function buildTrackerHtml(data, mesId, isUser = false) {
    const heartPts   = parseInt(data.heart, 10) || 0;
    const heartEmoji = getHeartEmoji(heartPts);

    let charsHtml = '';
    if (data.characters && data.characters.length > 0) {
        const nameList = data.characters.map(c => esc(c.name)).join(', ');
        const cards = data.characters.map(c => `
            <div class="tt-char">
                <div class="tt-char-name">${esc(c.name)}</div>
                <div class="tt-char-field"><span class="tt-char-label">Outfit</span>${esc(c.outfit)}</div>
                <div class="tt-char-field"><span class="tt-char-label">State</span>${esc(c.state)}</div>
                <div class="tt-char-field"><span class="tt-char-label">Position</span>${esc(c.position)}</div>
            </div>`).join('');

        charsHtml = `
            <div class="tt-chars-header">Characters Present: <span class="tt-chars-names">${nameList}</span></div>
            <div class="tt-chars-list">${cards}</div>`;
    }

    const regenBtn = `
                        <button class="tt-regen-btn menu_button menu_button_icon" data-mesid="${mesId}" data-isuser="${isUser}">
                            <i class="fa-solid fa-rotate"></i> Regenerate Tracker
                        </button>`;

    return `
        <div class="tt-container" data-mesid="${mesId}">
            <div class="tt-always">
                <div class="tt-row">
                    <span class="tt-label">⏰ Time</span>
                    <span class="tt-value">${esc(data.time     || 'Unknown')}</span>
                </div>
                <div class="tt-row">
                    <span class="tt-label">🗺️ Location</span>
                    <span class="tt-value">${esc(data.location || 'Unknown')}</span>
                </div>
                <div class="tt-row">
                    <span class="tt-label">🌤️ Weather</span>
                    <span class="tt-value">${esc(data.weather  || 'Unknown')}</span>
                </div>
                <div class="tt-row">
                    <span class="tt-label">💘 Heart Meter</span>
                    <span class="tt-value">${heartEmoji} ${heartPts.toLocaleString()}</span>
                </div>
            </div>
            <details class="tt-block">
                <summary class="tt-summary"><span>👁️ Tracker</span></summary>
                <div class="tt-fields">
                    ${charsHtml}
                    <div class="tt-actions">
                        ${regenBtn}
                        <button class="tt-edit-btn menu_button menu_button_icon" data-mesid="${mesId}">
                            <i class="fa-solid fa-pen-to-square"></i> Edit Tracker
                        </button>
                    </div>
                </div>
            </details>
        </div>`;
}

/**
 * Build the inline edit form.
 */
function buildEditFormHtml(data, mesId) {
    const charsText = (data.characters || [])
        .map(c => `name: ${c.name} | outfit: ${c.outfit} | state: ${c.state} | position: ${c.position}`)
        .join('\n');

    return `
        <div class="tt-container tt-editing" data-mesid="${mesId}">
            <div class="tt-edit-form">
                <div class="tt-edit-row">
                    <label class="tt-edit-label">⏰ Time</label>
                    <input class="tt-edit-input text_pole" id="tt-edit-time-${mesId}"
                           value="${esc(data.time || '')}" placeholder="h:MM AM/PM; MM/DD/YYYY (DayOfWeek)">
                </div>
                <div class="tt-edit-row">
                    <label class="tt-edit-label">🗺️ Location</label>
                    <input class="tt-edit-input text_pole" id="tt-edit-location-${mesId}"
                           value="${esc(data.location || '')}" placeholder="Location description">
                </div>
                <div class="tt-edit-row">
                    <label class="tt-edit-label">🌤️ Weather</label>
                    <input class="tt-edit-input text_pole" id="tt-edit-weather-${mesId}"
                           value="${esc(data.weather || '')}" placeholder="Weather, Temperature">
                </div>
                <div class="tt-edit-row">
                    <label class="tt-edit-label">💘 Heart</label>
                    <input class="tt-edit-input text_pole tt-edit-heart" id="tt-edit-heart-${mesId}"
                           type="number" value="${parseInt(data.heart, 10) || 0}" min="0" max="69999">
                </div>
                <div class="tt-edit-row tt-edit-chars-row">
                    <label class="tt-edit-label">👥 Characters</label>
                    <textarea class="tt-edit-chars text_pole" id="tt-edit-chars-${mesId}"
                              rows="4" placeholder="name: Alice | outfit: ... | state: ... | position: ...">${esc(charsText)}</textarea>
                </div>
                <div class="tt-edit-actions">
                    <button class="tt-edit-save menu_button menu_button_icon" data-mesid="${mesId}">
                        <i class="fa-solid fa-check"></i> Save
                    </button>
                    <button class="tt-edit-cancel menu_button menu_button_icon" data-mesid="${mesId}">
                        <i class="fa-solid fa-xmark"></i> Cancel
                    </button>
                </div>
            </div>
        </div>`;
}

// ── Settings ──────────────────────────────────────────────────

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXT_NAME][k] === undefined) {
            extension_settings[EXT_NAME][k] = v;
        }
    }
    return extension_settings[EXT_NAME];
}

// ── Rendering ─────────────────────────────────────────────────

/**
 * Inject (or refresh) the tracker UI for a single message.
 */
function renderMessageTracker(mesId) {
    const el = $(`.mes[mesid="${mesId}"]`);
    if (!el.length) return;

    el.find('.tt-container').remove();

    const s = getSettings();
    if (!s.enabled) return;

    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || !msg.extra?.tt_tracker) return;

    const mesText = el.find('.mes_text');

    // Strip any lingering [TRACKER] block from the displayed HTML (AI messages only)
    if (!msg.is_user) {
        mesText.html(
            mesText.html().replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim()
        );
    }

    mesText.before(buildTrackerHtml(msg.extra.tt_tracker, mesId, msg.is_user));
}

/**
 * After storing a tracker on an AI message, retroactively apply the pre-exchange
 * tracker state to any preceding user messages that don't have one yet.
 * This ensures user messages get their tracker only after the AI has responded.
 */
function populatePrecedingUserMessages(aiMesId) {
    const ctx = getContext();
    let modified = false;

    for (let i = aiMesId - 1; i >= 0; i--) {
        const msg = ctx.chat[i];
        if (!msg || !msg.is_user) break; // Stop at the previous AI message
        if (msg.extra?.tt_tracker) continue; // Already has one

        // The tracker for a user message is whatever was current before they sent their message,
        // with time advanced by 1–3 minutes so every message has a unique, forward-moving timestamp.
        const tracker = getMostRecentTracker(ctx.chat, i);
        if (tracker) {
            const advancedTracker = { ...tracker };
            const nudge = 1 + Math.floor(Math.random() * 3); // 1–3 minutes
            advancedTracker.time = advanceTimeString(tracker.time, nudge);
            msg.extra = msg.extra || {};
            msg.extra.tt_tracker = advancedTracker;
            renderMessageTracker(i);
            modified = true;
        }
    }

    if (modified) ctx.saveChat();
}

/**
 * Parse tracker data from an AI message, clamp the heart value, strip the
 * block from msg.mes permanently, store in extra, and update the display.
 */
function processMessage(mesId) {
    const s = getSettings();
    if (!s.enabled) return;

    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || msg.is_user) return;

    // 1. Try our own [TRACKER] format
    const data = parseTrackerBlock(msg.mes || '');
    if (data) {
        // Enforce heart shift limit in code — don't trust the AI to respect it
        const maxShift = (Number(s.heartSensitivity) || 5) * 500;
        if (data.heart !== null) {
            data.heart = clampHeart(data.heart, s.heartPoints, maxShift);
            s.heartPoints = data.heart;
        }

        // Permanently strip the tracker block from msg.mes so it never renders again
        msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();

        msg.extra = msg.extra || {};
        msg.extra.tt_tracker = data;
        ctx.saveChat();
        saveSettingsDebounced();
        renderMessageTracker(mesId);
        populatePrecedingUserMessages(mesId);
        injectPrompt();
        return;
    }

    // 2. Try importing from SillyTavern-Tracker format
    const imported = tryImportSTTracker(msg);
    if (imported) {
        msg.extra = msg.extra || {};
        msg.extra.tt_tracker = imported;
        ctx.saveChat();
        saveSettingsDebounced();
        renderMessageTracker(mesId);
        populatePrecedingUserMessages(mesId);
        injectPrompt();
    }
}

// ── Regenerate Tracker ────────────────────────────────────────

async function regenTracker(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    const btn = $(`.mes[mesid="${mesId}"] .tt-regen-btn`);
    btn.prop('disabled', true).html('<i class="fa-solid fa-rotate fa-spin"></i> Regenerating…');

    try {
        const prevMsg = ctx.chat.slice(0, mesId).reverse().find(m => m.extra?.tt_tracker);
        const prevTrackerText = prevMsg
            ? formatTrackerForPrompt(prevMsg.extra.tt_tracker)
            : 'None';
        const prevHeart = parseInt(prevMsg?.extra?.tt_tracker?.heart, 10) || 0;

        let genPrompt;

        if (msg.is_user) {
            // User message: infer scene changes from the user's text; lock heart to previous value
            genPrompt =
`[OOC: Based on the user's message below and the previous tracker state, produce an updated tracker reflecting any scene changes the user's message logically implies. Output ONLY the tracker block — no other text.

IMPORTANT: The time field is in-story fiction time, NOT real-world time. Advance only by a realistic amount for what the message depicts.
heart must remain exactly ${prevHeart} — only the character's emotions change this, never the user.]

Previous tracker state:
${prevTrackerText}

User's message:
${msg.mes}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: integer_value
characters:
- name: CharacterName | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;
        } else {
            // AI message: infer from conversation context
            const start       = Math.max(0, mesId - 6);
            const contextMsgs = ctx.chat.slice(start, mesId + 1);
            const contextText = contextMsgs
                .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                .join('\n\n');

            genPrompt =
`[OOC: Based on the conversation excerpt below, infer the tracker state at the moment of the last AI message. Use the previous tracker as your starting point and only update what the narrative logically requires. Output ONLY the tracker block — no other text.

IMPORTANT: The time field is IN-STORY fiction time — NEVER the real-world current date or time. Start from the previous tracker time and advance only by a realistic amount for what the scene depicts. If no previous time exists, invent one that fits the story's setting.]

Previous tracker state:
${prevTrackerText}

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: integer_value
characters:
- name: CharacterName | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;
        }

        // Suppress the "USER'S CURRENT MESSAGE" section during regen so the AI
        // only considers context up to the message being regenerated, not future messages.
        injectPrompt(false);
        let response;
        try {
            response = await generateQuietPrompt(genPrompt, false, true);
        } finally {
            // Always restore the full prompt regardless of outcome
            injectPrompt(true);
        }

        const data = parseTrackerBlock(response);
        if (data) {
            const s = getSettings();
            if (msg.is_user) {
                // Hard lock heart on user messages
                data.heart = prevHeart;
            } else {
                const maxShift = (Number(s.heartSensitivity) || 5) * 500;
                if (data.heart !== null) {
                    data.heart = clampHeart(data.heart, s.heartPoints, maxShift);
                    s.heartPoints = data.heart;
                }
            }
            msg.extra = msg.extra || {};
            msg.extra.tt_tracker = data;
            await ctx.saveChat();
            saveSettingsDebounced();
            renderMessageTracker(mesId);
        }
    } catch (err) {
        console.warn(`[TurboTracker] Regen failed for message #${mesId}:`, err);
        injectPrompt(true); // ensure prompt is restored on error too
        btn.prop('disabled', false).html('<i class="fa-solid fa-rotate"></i> Regenerate Tracker');
    }
}

// ── Edit Tracker ──────────────────────────────────────────────

function showEditForm(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || !msg.extra?.tt_tracker) return;

    const el = $(`.mes[mesid="${mesId}"]`);
    el.find('.tt-container').replaceWith(buildEditFormHtml(msg.extra.tt_tracker, mesId));
}

function saveEditedTracker(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    const time     = $(`#tt-edit-time-${mesId}`).val().trim();
    const location = $(`#tt-edit-location-${mesId}`).val().trim();
    const weather  = $(`#tt-edit-weather-${mesId}`).val().trim();
    const heart    = parseInt($(`#tt-edit-heart-${mesId}`).val()) || 0;
    const charsRaw = $(`#tt-edit-chars-${mesId}`).val().trim();

    const characters = charsRaw
        ? charsRaw.split('\n').filter(l => l.trim()).map(line => {
            const char = { name: '', outfit: '', state: '', position: '' };
            const parts = line.split('|').map(p => p.trim());
            for (const part of parts) {
                const sep = part.indexOf(':');
                if (sep === -1) continue;
                const k = part.slice(0, sep).trim().toLowerCase();
                const v = part.slice(sep + 1).trim();
                if      (k === 'name')     char.name     = v;
                else if (k === 'outfit')   char.outfit   = v;
                else if (k === 'state')    char.state    = v;
                else if (k === 'position') char.position = v;
            }
            return char;
        }).filter(c => c.name)
        : [];

    msg.extra = msg.extra || {};
    msg.extra.tt_tracker = { time, location, weather, heart, characters };

    const s = getSettings();
    s.heartPoints = Math.max(0, heart);

    ctx.saveChat();
    saveSettingsDebounced();
    renderMessageTracker(mesId);
    injectPrompt();
}

// ── Prompt injection ──────────────────────────────────────────

function injectPrompt(includeLatestUserMsg = true) {
    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const maxShift = (Number(s.heartSensitivity) || 5) * 500;

    const ctx  = getContext();
    const chat = ctx?.chat || [];

    // Most recent tracker — concrete starting point for all fields
    let currentTrackerText = 'No previous tracker yet — this is the start of the story.';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.extra?.tt_tracker) {
            currentTrackerText = formatTrackerForPrompt(chat[i].extra.tt_tracker);
            break;
        }
    }

    // Most recent user message — used to tell the AI what scene changes to reflect
    let latestUserMsg = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user && chat[i].mes) {
            latestUserMsg = chat[i].mes.slice(0, 800);
            break;
        }
    }
    const userMsgSection = (includeLatestUserMsg && latestUserMsg)
        ? `\nUSER'S CURRENT MESSAGE — read this carefully before updating the tracker. Any scene changes the user describes (movement, time skip, weather mention, etc.) MUST be reflected in your tracker output:\n"${latestUserMsg}"\n`
        : '';

    const prompt = `[TurboTracker — mandatory instructions]
At the very end of EVERY response, after all narrative text, append a tracker block in exactly this format:

[TRACKER]
time: h:MM AM/PM; story-appropriate date (DayOfWeek)
location: Full location description
weather: Weather condition, Temperature
heart: integer_value
characters:
- name: CharacterName | outfit: Clothing description | state: Emotional/physical state | position: Where in the scene
[/TRACKER]
${userMsgSection}
PREVIOUS TRACKER STATE — your baseline. Update each field that the current exchange (user message + your response) requires; copy everything else forward exactly:
${currentTrackerText}

TIME RULES — most important field:
  • IN-STORY fiction time only. NEVER use the real-world current date or clock time.
  • Advance from the baseline above by the realistic amount the scene depicts (seconds to a few minutes for brief exchanges).
  • The date must match the story's setting (fantasy era, sci-fi calendar, historical period, etc.).
  • If no previous time exists, invent one that fits the world — do NOT use today's date.
  • Only jump hours or days when the exchange explicitly depicts that much time passing.

  Correct examples (fictional — not real-world dates):
    Sci-fi:     "9:10 PM; 01/20/31 BBY (Monday)"
    Historical: "8:10 PM; 10/4/1452 (Monday)"
    Fantasy:    "11:30 PM; Day 47, Third Age (Friday)"

OTHER FIELD RULES:
  • Location: update if the user's message or your response shows characters moving somewhere new.
  • Weather: update only if the exchange gives a narrative reason.
  • Characters: add or remove only as the scene requires.

Heart Meter:
  Tracks the CHARACTER's romantic interest in {{user}}. Starts at 0 for every new story. Range: 0–69,999.
  Only the character's own emotions drive this — never adjust based on user actions alone.
  Current value: ${s.heartPoints}
  THIS RESPONSE: the heart value MUST be between ${Math.max(0, s.heartPoints - maxShift)} and ${Math.min(69999, s.heartPoints + maxShift)}. Any value outside this range is an error.
  🖤 0–4,999   💜 5,000–19,999   💙 20,000–29,999   💚 30,000–39,999
  💛 40,000–49,999   🧡 50,000–59,999   ❤️ 60,000+

Characters section:
  List every character currently present in the scene.
  Each line must use the pipe-separated format shown above.
  Include current outfit, emotional/physical state, and position in the scene.`;

    setExtensionPrompt(EXT_NAME, prompt, extension_prompt_types.BEFORE_PROMPT, 0);
}

// ── Retroactive population ────────────────────────────────────

let isPopulating = false;

async function populateAllMessages() {
    if (isPopulating) return;
    isPopulating = true;

    const btn    = $('#tt-populate-btn');
    const status = $('#tt-populate-status');
    btn.prop('disabled', true);

    try {
        const s   = getSettings();
        const ctx = getContext();
        if (!ctx.chat || ctx.chat.length === 0) {
            status.text('No chat loaded.');
            return;
        }

        // Suppress the "USER'S CURRENT MESSAGE" section for all quiet generations
        // inside this loop — each prompt already supplies its own explicit context.
        injectPrompt(false);

        const aiMessages = ctx.chat
            .map((msg, idx) => ({ msg, idx }))
            .filter(({ msg }) => !msg.is_user);

        let done = 0;
        status.text(`0 / ${aiMessages.length} messages…`);

        for (const { msg, idx } of aiMessages) {
            if (msg.extra?.tt_tracker) {
                // Already has tracker — strip any leftover [TRACKER] text from msg.mes
                if ((msg.mes || '').match(/\[TRACKER\]/i)) {
                    msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
                }
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            const existing = parseTrackerBlock(msg.mes || '');
            if (existing) {
                const maxShift = (Number(s.heartSensitivity) || 5) * 500;
                if (existing.heart !== null) {
                    existing.heart = clampHeart(existing.heart, s.heartPoints, maxShift);
                    s.heartPoints = existing.heart;
                }
                msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
                msg.extra = msg.extra || {};
                msg.extra.tt_tracker = existing;
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            const imported = tryImportSTTracker(msg);
            if (imported) {
                msg.extra = msg.extra || {};
                msg.extra.tt_tracker = imported;
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            // Ask the AI — include previous tracker as reference
            const start       = Math.max(0, idx - 6);
            const contextMsgs = ctx.chat.slice(start, idx + 1);
            const contextText = contextMsgs
                .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                .join('\n\n');

            const prevMsg = ctx.chat.slice(0, idx).reverse().find(m => m.extra?.tt_tracker);
            const prevTrackerText = prevMsg
                ? formatTrackerForPrompt(prevMsg.extra.tt_tracker)
                : 'None';

            const genPrompt =
`[OOC: Based on the conversation excerpt below, infer the tracker state at the moment of the last AI message. Use the previous tracker as your starting point and only update what the narrative logically requires. Output ONLY the tracker block — no other text.

IMPORTANT: The time field is IN-STORY fiction time — NEVER the real-world current date or time. Start from the previous tracker time and advance only by a realistic amount for what the scene depicts. If no previous time exists, invent one that fits the story's setting.]

Previous tracker state:
${prevTrackerText}

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: integer_value
characters:
- name: CharacterName | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;

            try {
                const response = await generateQuietPrompt(genPrompt, false, true);
                const data = parseTrackerBlock(response);
                if (data) {
                    const maxShift = (Number(s.heartSensitivity) || 5) * 500;
                    if (data.heart !== null) {
                        data.heart = clampHeart(data.heart, s.heartPoints, maxShift);
                        s.heartPoints = data.heart;
                    }
                    msg.extra = msg.extra || {};
                    msg.extra.tt_tracker = data;
                    renderMessageTracker(idx);
                }
            } catch (err) {
                console.warn(`[TurboTracker] Could not generate tracker for message #${idx}:`, err);
            }

            done++;
            status.text(`${done} / ${aiMessages.length} messages…`);
        }

        // Apply inherited trackers to user messages that still have none
        ctx.chat.forEach((msg, idx) => {
            if (msg.is_user && !msg.extra?.tt_tracker) {
                const inherited = getMostRecentTracker(ctx.chat, idx);
                if (inherited) {
                    msg.extra = msg.extra || {};
                    msg.extra.tt_tracker = { ...inherited };
                    renderMessageTracker(idx);
                }
            }
        });

        await ctx.saveChat();
        saveSettingsDebounced();
        status.text('Done!');
        setTimeout(() => status.text(''), 3000);

    } finally {
        isPopulating = false;
        btn.prop('disabled', false);
        injectPrompt(true); // restore full prompt when done
    }
}

// ── Event handlers ────────────────────────────────────────────

function onCharacterMessageRendered(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    if (msg.extra?.tt_tracker) {
        renderMessageTracker(mesId);
    } else {
        processMessage(mesId);
    }
}

/**
 * Fires when a user message is rendered.
 * Only renders existing tracker data — user message trackers are applied
 * retroactively by processMessage() after the AI responds.
 */
function onUserMessageRendered(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || !msg.is_user) return;

    const s = getSettings();
    if (!s.enabled) return;

    // Re-inject the prompt now that the user's message is in chat — this ensures
    // the injected prompt includes the user's latest message as tracker context
    // before the AI begins generating its response.
    injectPrompt();

    if (msg.extra?.tt_tracker) {
        renderMessageTracker(mesId);
    }
    // User message trackers are applied retroactively by populatePrecedingUserMessages
    // once the AI responds — no generation here.
}

function onChatChanged() {
    $('.tt-container').remove();

    // Sync heartPoints with the most recent tracker in the incoming chat.
    // This ensures new chats always start at 0 and existing chats restore
    // their correct value rather than inheriting the previous chat's state.
    const s = getSettings();
    const ctx = getContext();
    let latestHeart = 0;
    if (ctx?.chat) {
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const h = ctx.chat[i]?.extra?.tt_tracker?.heart;
            if (h != null) { latestHeart = parseInt(h, 10) || 0; break; }
        }
    }
    s.heartPoints = latestHeart;
    saveSettingsDebounced();

    injectPrompt();

    if (!ctx?.chat) return;

    let modified = false;
    ctx.chat.forEach((msg, idx) => {
        if (msg.extra?.tt_tracker) {
            // Clean up any lingering [TRACKER] text in msg.mes
            if (!msg.is_user && (msg.mes || '').match(/\[TRACKER\]/i)) {
                msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
                modified = true;
            }
            renderMessageTracker(idx);
        }
    });

    if (modified) ctx.saveChat();
}

function onMessageEdited(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    if (msg.is_user) {
        if (msg.extra?.tt_tracker) renderMessageTracker(mesId);
        return;
    }

    processMessage(mesId);
}

function onMessageDeleted() {
    const ctx = getContext();
    if (!ctx.chat) return;
    ctx.chat.forEach((msg, idx) => {
        if (msg.extra?.tt_tracker) renderMessageTracker(idx);
    });
}

// ── Settings UI ───────────────────────────────────────────────

function loadSettingsUi() {
    const s = getSettings();
    const maxShift = (Number(s.heartSensitivity) || 5) * 500;

    const html = `
<div class="tt-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>TurboTracker</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input type="checkbox" id="tt-enabled" ${s.enabled ? 'checked' : ''}>
                <span>Enable TurboTracker</span>
            </label>

            <hr class="tt-divider">

            <div class="tt-setting-row">
                <span class="tt-setting-label">💘 Heart Sensitivity</span>
                <input type="range" id="tt-heart-sensitivity" class="tt-sensitivity-slider"
                       min="1" max="10" step="1" value="${s.heartSensitivity}">
                <span id="tt-heart-sensitivity-val" class="tt-sensitivity-val">${s.heartSensitivity}</span>
            </div>
            <small id="tt-sensitivity-desc">Max shift per AI response: ±${maxShift} pts &nbsp;(1 = slow → 10 = fast, max ±5,000)</small>

            <hr class="tt-divider">

            <div class="tt-setting-row">
                <button id="tt-populate-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    Populate All Messages
                </button>
                <span id="tt-populate-status" class="tt-status"></span>
            </div>
            <small>Uses the AI to infer tracker data for every message that is missing it.</small>
        </div>
    </div>
</div>`;

    $('#extensions_settings').append(html);

    $('#tt-enabled').on('change', function () {
        getSettings().enabled = this.checked;
        saveSettingsDebounced();
        injectPrompt();
        if (!this.checked) $('.tt-container').remove();
    });

    $('#tt-heart-sensitivity').on('input', function () {
        const val = Number(this.value);
        getSettings().heartSensitivity = val;
        $('#tt-heart-sensitivity-val').text(val);
        $('#tt-sensitivity-desc').text(`Max Heart Meter shift per AI response: \u00b1${val * 500} pts \u00a0(1\u2009=\u2009slow \u2192 10\u2009=\u2009fast)`);
        saveSettingsDebounced();
        injectPrompt();
    });

    $('#tt-populate-btn').on('click', populateAllMessages);
}

// ── Init ──────────────────────────────────────────────────────

jQuery(async () => {
    loadSettingsUi();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED,      onUserMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED,               onChatChanged);
    eventSource.on(event_types.MESSAGE_EDITED,             onMessageEdited);
    eventSource.on(event_types.MESSAGE_DELETED,            onMessageDeleted);

    $(document).on('click', '.tt-regen-btn', async function () {
        const mesId = parseInt($(this).data('mesid'));
        await regenTracker(mesId);
    });

    $(document).on('click', '.tt-edit-btn', function () {
        const mesId = parseInt($(this).data('mesid'));
        showEditForm(mesId);
    });

    $(document).on('click', '.tt-edit-save', function () {
        const mesId = parseInt($(this).data('mesid'));
        saveEditedTracker(mesId);
    });

    $(document).on('click', '.tt-edit-cancel', function () {
        const mesId = parseInt($(this).data('mesid'));
        renderMessageTracker(mesId);
    });

    injectPrompt();
    console.log('[TurboTracker] Loaded.');
});
