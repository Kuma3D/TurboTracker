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
    debugEnabled: false,
    heartPoints: 0,
    heartSensitivity: 5,
    defaultHeartValue: 0,
    heartColors: [
        { emoji: '🖤', min: 0,     max: 4999  },
        { emoji: '💜', min: 5000,  max: 19999 },
        { emoji: '💙', min: 20000, max: 29999 },
        { emoji: '💚', min: 30000, max: 39999 },
        { emoji: '💛', min: 40000, max: 49999 },
        { emoji: '🧡', min: 50000, max: 59999 },
        { emoji: '❤️', min: 60000, max: 99999 },
    ],
};

// ── Debug logging ─────────────────────────────────────────────

const debugLines = [];
const MAX_DEBUG_LINES = 500;

function ttDebug(...args) {
    if (!extension_settings?.[EXT_NAME]?.debugEnabled) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const msg = args.map(a => (a !== null && typeof a === 'object') ? JSON.stringify(a) : String(a)).join(' ');
    const line = `[${ts}] ${msg}`;
    debugLines.push(line);
    if (debugLines.length > MAX_DEBUG_LINES) debugLines.shift();
    const $log = $('#tt-debug-log');
    if ($log.length) {
        $log.val(debugLines.join('\n'));
        $log[0].scrollTop = $log[0].scrollHeight;
    }
}

// ── Heart meter ───────────────────────────────────────────────

function getHeartEmoji(points) {
    const colors = getSettings().heartColors;
    for (const color of colors) {
        if (points >= color.min && points <= color.max) return color.emoji;
    }
    return colors[colors.length - 1].emoji;
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
    const hi = Math.min(99999, prev + shift);
    return Math.max(lo, Math.min(hi, val));
}

/**
 * Advance the H:MM AM/PM portion of a tracker time string by the given minutes.
 * Leaves the date/era suffix (e.g. "; 01/20/31 BBY (Monday)") unchanged.
 * If the format isn't recognised, the original string is returned unmodified.
 */
function advanceTimeString(timeStr, minutes) {
    if (!timeStr) return timeStr;

    // Format 1: H:MM AM/PM (with optional date suffix)
    const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)(.*)/i);
    if (m) {
        let hours = parseInt(m[1], 10);
        let mins  = parseInt(m[2], 10);
        const period = m[3].toUpperCase();
        const rest   = m[4];

        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours  = 0;

        mins  += minutes;
        hours += Math.floor(mins / 60);
        mins   = mins  % 60;
        hours  = hours % 24;

        const newPeriod = hours >= 12 ? 'PM' : 'AM';
        let   newHours  = hours % 12;
        if (newHours === 0) newHours = 12;

        const result = `${newHours}:${String(mins).padStart(2, '0')} ${newPeriod}${rest}`;
        ttDebug(`advanceTime: "${timeStr}" +${minutes}min → "${result}"`);
        return result;
    }

    // Format 2: HH:MM:SS (24-hour, with optional date suffix)
    const m2 = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})(.*)/);
    if (m2) {
        let hours = parseInt(m2[1], 10);
        let mins  = parseInt(m2[2], 10);
        const secs = m2[3];
        const rest = m2[4];

        mins  += minutes;
        hours += Math.floor(mins / 60);
        mins   = mins  % 60;
        hours  = hours % 24;

        const result = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${secs}${rest}`;
        ttDebug(`advanceTime: "${timeStr}" +${minutes}min → "${result}"`);
        return result;
    }

    ttDebug(`advanceTime: no-match for "${timeStr}"`);
    return timeStr;
}

// ── Heart-in-message extraction ───────────────────────────────

/**
 * Scan raw message text for an inline heart meter value written by the AI
 * in a narrative format such as:
 *   "Black Heart (500) 🖤"   →  500
 *   "Purple Heart (12500) 💜" → 12500
 *   "🖤 (500)"               →  500
 *
 * Returns the integer value found, or null if nothing matches.
 */
function extractHeartFromText(text) {
    if (!text) return null;

    // Pattern 1: "<Color> Heart (6,500) <emoji>" — allow commas in the number
    const named = text.match(/\b\w+\s+Heart\s*\(\s*([\d,]+)\s*\)/i);
    if (named) return parseInt(named[1].replace(/,/g, ''), 10);

    // Pattern 2: "<heart-emoji> (6,500)" — allow commas in the number
    const emojied = text.match(/(?:🖤|💜|💙|💚|💛|🧡|❤️|❤)\s*\(\s*([\d,]+)\s*\)/);
    if (emojied) return parseInt(emojied[1].replace(/,/g, ''), 10);

    return null;
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
            const char = { name: '', description: '', outfit: '', state: '', position: '' };
            for (const part of parts) {
                const sep = part.indexOf(':');
                if (sep === -1) continue;
                const k = part.slice(0, sep).trim().toLowerCase();
                const v = part.slice(sep + 1).trim();
                if      (k === 'name')        char.name        = v;
                else if (k === 'description') char.description = v;
                else if (k === 'outfit')      char.outfit      = v;
                else if (k === 'state')       char.state       = v;
                else if (k === 'position')    char.position    = v;
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
            name:        String(name),
            description: d.Description || d.description || '',
            outfit:      d.Outfit               || d.outfit   || '',
            state:       d.StateOfDress         || d.State    || d.state    || '',
            position:    d.PostureAndInteraction || d.Position || d.position || '',
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
 * Scan backwards for the nearest raw STTracker time string.
 * Checks both msg.tracker.Time / msg.tracker.time fields.
 */
function getMostRecentSTTrackerTime(chat, beforeMesId) {
    for (let i = beforeMesId - 1; i >= 0; i--) {
        const t = chat[i]?.tracker;
        if (t && typeof t === 'object') {
            const time = t.Time || t.time;
            if (time) return String(time);
        }
    }
    return null;
}

/**
 * Returns { trackerText, prevHeart, prevTime } for use in generation prompts.
 * Compares the message index of the nearest tt_tracker vs the nearest raw STTracker
 * time to determine which is more recent, and uses that as the time anchor.
 * This prevents stale STTracker times (from earlier messages) from overriding
 * a more recent AI-generated tracker time, while still using STTracker times
 * when they come from a message that appeared after the last tt_tracker.
 */
function getBestPrevContext(chat, beforeMesId) {
    // Find the most recent tt_tracker and the message index it came from
    let ttTracker = null;
    let ttIdx = -1;
    for (let i = beforeMesId - 1; i >= 0; i--) {
        if (chat[i]?.extra?.tt_tracker) {
            ttTracker = chat[i].extra.tt_tracker;
            ttIdx = i;
            break;
        }
    }

    // Find the most recent raw STTracker time and the message index it came from
    let stTime = null;
    let stIdx = -1;
    for (let i = beforeMesId - 1; i >= 0; i--) {
        const t = chat[i]?.tracker;
        if (t && typeof t === 'object') {
            const time = t.Time || t.time;
            if (time) { stTime = String(time); stIdx = i; break; }
        }
    }

    ttDebug(`getBestPrevCtx before #${beforeMesId}: ttIdx=${ttIdx}${ttTracker ? ` time="${ttTracker.time}"` : ''} stIdx=${stIdx} stTime=${stTime || 'null'}`);

    // Choose the time anchor: use whichever source comes from a MORE RECENT message.
    // stTime wins only if its message appears AFTER the tt_tracker message.
    // This avoids old STTracker times overriding newer AI-generated tracker times.
    const prevTime = (stIdx > ttIdx && stTime) ? stTime
                   : (!isBlankValue(ttTracker?.time)) ? ttTracker.time
                   : stTime || null;

    if (ttTracker) {
        // Patch the tracker with prevTime if its own time is blank
        const patched = !isBlankValue(ttTracker.time) ? ttTracker : { ...ttTracker, time: prevTime };
        return {
            trackerText: formatTrackerForPrompt(patched),
            prevHeart:   parseInt(ttTracker.heart, 10) || 0,
            prevTime,
        };
    }

    // No tt_tracker at all — build minimal context from raw STTracker data
    if (stTime) {
        const synth = { time: stTime, location: null, weather: null, heart: 0, characters: [] };
        for (let i = beforeMesId - 1; i >= 0; i--) {
            const t = chat[i]?.tracker;
            if (t && typeof t === 'object' && Object.keys(t).length > 0) {
                const imported = convertSTTrackerToTT(t);
                if (imported) {
                    synth.location   = imported.location;
                    synth.weather    = imported.weather;
                    synth.characters = imported.characters;
                }
                break;
            }
        }
        return { trackerText: formatTrackerForPrompt(synth), prevHeart: 0, prevTime: stTime };
    }

    return { trackerText: 'None', prevHeart: 0, prevTime: null };
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
            text += `\n- name: ${c.name} | description: ${c.description} | outfit: ${c.outfit} | state: ${c.state} | position: ${c.position}`;
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
                <div class="tt-char-field"><span class="tt-char-label">Description</span>${esc(c.description)}</div>
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
        .map(c => `name: ${c.name} | description: ${c.description} | outfit: ${c.outfit} | state: ${c.state} | position: ${c.position}`)
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
                           type="number" value="${parseInt(data.heart, 10) || 0}" min="0" max="99999">
                </div>
                <div class="tt-edit-row tt-edit-chars-row">
                    <label class="tt-edit-label">👥 Characters</label>
                    <textarea class="tt-edit-chars text_pole" id="tt-edit-chars-${mesId}"
                              rows="4" placeholder="name: Alice | description: Brown hair, blue eyes, 5'7 | outfit: ... | state: ... | position: ...">${esc(charsText)}</textarea>
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
        extension_settings[EXT_NAME] = {
            ...DEFAULT_SETTINGS,
            heartColors: DEFAULT_SETTINGS.heartColors.map(c => ({ ...c })),
        };
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXT_NAME][k] === undefined) {
            extension_settings[EXT_NAME][k] = Array.isArray(v) ? v.map(c => ({ ...c })) : v;
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

    ttDebug(`populatePrecedingUser from ai #${aiMesId}`);

    for (let i = aiMesId - 1; i >= 0; i--) {
        const msg = ctx.chat[i];
        if (!msg || !msg.is_user) break; // Stop at the previous AI message
        if (msg.extra?.tt_tracker) { ttDebug(`  #${i} user: already has tracker`); continue; }

        // The tracker for a user message is whatever was current before they sent their message,
        // with time advanced by 1–3 minutes so every message has a unique, forward-moving timestamp.
        const tracker = getMostRecentTracker(ctx.chat, i);
        if (tracker) {
            const advancedTracker = { ...tracker };
            const nudge = 1 + Math.floor(Math.random() * 3); // 1–3 minutes
            advancedTracker.time = advanceTimeString(tracker.time, nudge);
            ttDebug(`  #${i} user: base="${tracker.time}" +${nudge}min → "${advancedTracker.time}"`);
            msg.extra = msg.extra || {};
            msg.extra.tt_tracker = advancedTracker;
            renderMessageTracker(i);
            modified = true;
        } else {
            ttDebug(`  #${i} user: no base tracker found`);
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

    ttDebug(`processMessage #${mesId} msgLen=${(msg.mes || '').length}`);

    // 1. Try our own [TRACKER] format
    const data = parseTrackerBlock(msg.mes || '');
    if (data) {
        ttDebug(`  #${mesId} [TRACKER] found: time="${data.time}" heart=${data.heart} chars=${data.characters.length}`);
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

    ttDebug(`  #${mesId} no [TRACKER] block — trying STTracker`);

    // 2. Try importing from SillyTavern-Tracker format
    const imported = tryImportSTTracker(msg);
    if (imported) {
        ttDebug(`  #${mesId} STTracker imported: time="${imported.time}"`);
        msg.extra = msg.extra || {};
        msg.extra.tt_tracker = imported;
        ctx.saveChat();
        saveSettingsDebounced();
        renderMessageTracker(mesId);
        populatePrecedingUserMessages(mesId);
        injectPrompt();
    } else {
        ttDebug(`  #${mesId} no tracker data found`);
    }
}

// ── Regenerate Tracker ────────────────────────────────────────

async function regenTracker(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    ttDebug(`regenTracker #${mesId} is_user=${msg.is_user}`);

    const btn = $(`.mes[mesid="${mesId}"] .tt-regen-btn`);
    btn.prop('disabled', true).html('<i class="fa-solid fa-rotate fa-spin"></i> Regenerating…');

    try {
        const s        = getSettings();
        const maxShift = (Number(s.heartSensitivity) || 5) * 500;

        const { trackerText: prevTrackerText, prevHeart, prevTime: regenPrevTime } = getBestPrevContext(ctx.chat, mesId);
        const heartLo   = Math.max(0,     prevHeart - maxShift);
        const heartHi   = Math.min(99999, prevHeart + maxShift);

        ttDebug(`  regen #${mesId}: prevHeart=${prevHeart} range=[${heartLo},${heartHi}] prevTime="${regenPrevTime || 'none'}"`);
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
heart: ${prevHeart}
characters:
- name: CharacterName | description: Physical description | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;
        } else {
            // AI message: infer from conversation context up to (and including) this message only —
            // do NOT include messages after mesId, as those are "future" context for this point in time.
            const start       = Math.max(0, mesId - 6);
            const contextMsgs = ctx.chat.slice(start, mesId + 1);
            const contextText = contextMsgs
                .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                .join('\n\n');

            genPrompt =
`[OOC: Based on the conversation excerpt below, infer the tracker state at the moment of the last AI message. Use the previous tracker as your starting point and only update what the narrative logically requires. Output ONLY the tracker block — no other text.

IMPORTANT: The time field is IN-STORY fiction time — NEVER the real-world current date or time. Start from the previous tracker time and advance by only a small, realistic amount — typically 1 to 10 minutes for a normal exchange, only more if the scene explicitly depicts a significant time skip. Do not jump hours without clear story justification.
heart must be between ${heartLo} and ${heartHi} (previous value was ${prevHeart}).]

Previous tracker state:
${prevTrackerText}

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: integer_value between ${heartLo} and ${heartHi}
characters:
- name: CharacterName | description: Physical description | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;
        }

        // Completely clear the extension prompt before the quiet generation so the AI
        // only sees the conversation history up to mesId and the explicit genPrompt above.
        // If we left injectPrompt() active it would supply s.heartPoints (current latest value)
        // and the current tracker state — causing regen to bleed in future context.
        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
        let response;
        try {
            response = await generateQuietPrompt(genPrompt, false, true);
        } finally {
            // Always restore the full prompt regardless of outcome
            injectPrompt(true);
        }

        const data = parseTrackerBlock(response);
        ttDebug(`  regen #${mesId}: parsed=${data ? `time="${data.time}" heart=${data.heart}` : 'null (no [TRACKER] block)'}`);
        if (data) {
            if (msg.is_user) {
                // Hard lock heart on user messages
                data.heart = prevHeart;
            } else {
                if (data.heart !== null) {
                    // Clamp against prevHeart (the historical baseline), NOT s.heartPoints
                    // (current latest value) — otherwise we'd be constraining relative to
                    // a future state that didn't exist at the time of this message.
                    data.heart = clampHeart(data.heart, prevHeart, maxShift);
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
            const char = { name: '', description: '', outfit: '', state: '', position: '' };
            const parts = line.split('|').map(p => p.trim());
            for (const part of parts) {
                const sep = part.indexOf(':');
                if (sep === -1) continue;
                const k = part.slice(0, sep).trim().toLowerCase();
                const v = part.slice(sep + 1).trim();
                if      (k === 'name')        char.name        = v;
                else if (k === 'description') char.description = v;
                else if (k === 'outfit')      char.outfit      = v;
                else if (k === 'state')       char.state       = v;
                else if (k === 'position')    char.position    = v;
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

    // Build dynamic color legend from settings
    const colors = s.heartColors;
    const colorDesc = colors.map((c, i) => {
        const maxLabel = i === colors.length - 1 ? `${c.max.toLocaleString()}+` : c.max.toLocaleString();
        return `${c.emoji} ${c.min.toLocaleString()}–${maxLabel}`;
    }).join('   ');

    const prompt = `[TurboTracker — mandatory instructions]
At the very end of EVERY response, after all narrative text, append a tracker block in exactly this format:

[TRACKER]
time: h:MM AM/PM; story-appropriate date (DayOfWeek)
location: Full location description
weather: Weather condition, Temperature
heart: integer_value
characters:
- name: CharacterName | description: Hair color, eye color, height, weight, notable features | outfit: Clothing description | state: Emotional/physical state | position: Where in the scene
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
  Tracks the CHARACTER's romantic interest in {{user}}. Starts at 0 for every new story. Range: 0–99,999.
  Only the character's own emotions drive this — never adjust based on user actions alone.
  Current value: ${s.heartPoints}
  THIS RESPONSE: the heart value MUST be between ${Math.max(0, s.heartPoints - maxShift)} and ${Math.min(99999, s.heartPoints + maxShift)}. Any value outside this range is an error.
  ${colorDesc}

Characters section:
  List every character currently present in the scene.
  Each line must use the pipe-separated format shown above.
  description: brief physical description — hair color, eye color, height, weight, notable features. Pull from character/user card if available; infer or estimate if not.
  Include current outfit, emotional/physical state, and position in the scene.`;

    setExtensionPrompt(EXT_NAME, prompt, extension_prompt_types.BEFORE_PROMPT, 0);
}

// ── Blank-field helpers ───────────────────────────────────────

const isBlankValue = v => v == null || String(v).trim() === '' || String(v).trim().toLowerCase() === 'unknown';

function hasBlankFields(tracker) {
    if (isBlankValue(tracker.time) || isBlankValue(tracker.location) || isBlankValue(tracker.weather)) return true;
    for (const c of (tracker.characters || [])) {
        if (!c.description || !c.outfit || !c.state || !c.position) return true;
    }
    return false;
}

function formatTrackerWithBlanks(tracker) {
    const mark = v => isBlankValue(v) ? '???' : v;
    let text = `time: ${mark(tracker.time)}\nlocation: ${mark(tracker.location)}\nweather: ${mark(tracker.weather)}\nheart: ${parseInt(tracker.heart, 10) || 0}`;
    if (tracker.characters && tracker.characters.length > 0) {
        text += '\ncharacters:';
        for (const c of tracker.characters) {
            text += `\n- name: ${c.name} | description: ${mark(c.description)} | outfit: ${mark(c.outfit)} | state: ${mark(c.state)} | position: ${mark(c.position)}`;
        }
    }
    return text;
}

function mergeTrackers(existing, filled) {
    const mergedChars = (existing.characters || []).map(ec => {
        const fc = (filled.characters || []).find(c => c.name === ec.name) || {};
        return {
            name:        ec.name,
            description: ec.description || fc.description || '',
            outfit:      ec.outfit      || fc.outfit      || '',
            state:       ec.state       || fc.state       || '',
            position:    ec.position    || fc.position    || '',
        };
    });

    // Append any characters the AI returned that weren't in the existing tracker
    const existingNames = new Set((existing.characters || []).map(c => c.name));
    const newChars = (filled.characters || []).filter(c => c.name && !existingNames.has(c.name));

    return {
        time:       isBlankValue(existing.time)     && filled.time     ? filled.time     : existing.time,
        location:   isBlankValue(existing.location) && filled.location ? filled.location : existing.location,
        weather:    isBlankValue(existing.weather)  && filled.weather  ? filled.weather  : existing.weather,
        heart:      existing.heart, // never overwrite heart retroactively
        characters: [...mergedChars, ...newChars],
    };
}

// ── Retroactive population ────────────────────────────────────

let isPopulating = false;

async function populateAllMessages() {
    if (isPopulating) return;
    isPopulating = true;

    const btn    = $('#tt-populate-btn');
    const status = $('#tt-populate-status');
    btn.prop('disabled', true);
    $('#tt-regen-all-btn').prop('disabled', true);

    try {
        const s   = getSettings();
        const ctx = getContext();
        if (!ctx.chat || ctx.chat.length === 0) {
            status.text('No chat loaded.');
            return;
        }

        // Completely clear the extension prompt for all quiet generations inside this loop.
        // Each genPrompt below supplies its own explicit context (previous tracker + conversation
        // excerpt), so the main extension prompt would only add noise — and would supply
        // s.heartPoints / current tracker state that could contaminate historical generations.
        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);

        const aiMessages = ctx.chat
            .map((msg, idx) => ({ msg, idx }))
            .filter(({ msg }) => !msg.is_user);

        let done = 0;
        status.text(`0 / ${aiMessages.length} messages…`);

        for (const { msg, idx } of aiMessages) {
            // Always check for an inline heart value in the message text first.
            // This takes priority over everything — clamp, AI output, stored value.
            const inlineHeart    = extractHeartFromText(msg.mes || '');
            const heartLocked    = inlineHeart !== null;
            const lockedHeartVal = heartLocked ? Math.max(0, Math.min(99999, inlineHeart)) : null;

            ttDebug(`populate #${idx}: hasTracker=${!!msg.extra?.tt_tracker} hasSTTracker=${!!(msg.tracker && Object.keys(msg.tracker || {}).length)} heartLocked=${heartLocked}${heartLocked ? ` val=${lockedHeartVal}` : ''}`);

            // Strip any leftover [TRACKER] text from msg.mes regardless of path
            if ((msg.mes || '').match(/\[TRACKER\]/i)) {
                msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
            }

            // ── Priority 1: STTracker data on this exact message ──────────
            // msg.tracker is ground truth — always wins over any stored tt_tracker.
            // Build from it, then AI-fill only what's still blank.
            const stImported = tryImportSTTracker(msg);
            if (stImported) {
                ttDebug(`  #${idx} P1: STTracker time="${stImported.time}" loc="${stImported.location}"`);
                // Heart comes from the nearest preceding processed tracker,
                // since STTracker doesn't track heart.
                const prevContext = getMostRecentTracker(ctx.chat, idx);
                stImported.heart = prevContext?.heart ?? null;

                if (heartLocked) {
                    stImported.heart = lockedHeartVal;
                }

                msg.extra = msg.extra || {};
                msg.extra.tt_tracker = stImported;

                if (hasBlankFields(stImported)) {
                    ttDebug(`  #${idx} P1: has blank fields, calling AI fill`);
                    const start       = Math.max(0, idx - 6);
                    const contextMsgs = ctx.chat.slice(start, idx + 1);
                    const contextText = contextMsgs
                        .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                        .join('\n\n');
                    const lockedHeart = parseInt(stImported.heart, 10) || 0;
                    const fillPrompt =
`[OOC: The tracker below has blank fields marked as ???. Based on the conversation excerpt and character context, fill in ONLY the ??? fields. Do not change any field that already has a value. Output ONLY a complete tracker block — no other text.]

Current tracker (fill in the ??? fields):
${formatTrackerWithBlanks(stImported)}

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: ${lockedHeart}
characters:
- name: CharacterName | description: Physical description | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;
                    try {
                        const response = await generateQuietPrompt(fillPrompt, false, true);
                        const filled = parseTrackerBlock(response);
                        ttDebug(`  #${idx} P1 fill: parsed=${filled ? `time="${filled.time}"` : 'null'}`);
                        if (filled) {
                            msg.extra.tt_tracker = mergeTrackers(stImported, filled);
                            if (heartLocked) msg.extra.tt_tracker.heart = lockedHeartVal;
                        }
                    } catch (err) {
                        console.warn(`[TurboTracker] Could not fill blank ST fields for message #${idx}:`, err);
                        ttDebug(`  #${idx} P1 fill ERROR: ${err.message}`);
                    }
                }

                // Always update the running heart state so subsequent messages have a correct baseline
                if (msg.extra.tt_tracker.heart !== null) {
                    s.heartPoints = parseInt(msg.extra.tt_tracker.heart, 10) || 0;
                }
                ttDebug(`  #${idx} P1 done: time="${msg.extra.tt_tracker.time}" heart=${msg.extra.tt_tracker.heart}`);
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            // ── Priority 2: Already has a tt_tracker (no STTracker on this msg) ──
            if (msg.extra?.tt_tracker) {
                ttDebug(`  #${idx} P2: existing tt_tracker time="${msg.extra.tt_tracker.time}" heart=${msg.extra.tt_tracker.heart}`);
                // Inline heart always wins over whatever is stored
                if (heartLocked) {
                    msg.extra.tt_tracker = { ...msg.extra.tt_tracker, heart: lockedHeartVal };
                    s.heartPoints = lockedHeartVal;
                } else if (msg.extra.tt_tracker.heart !== null) {
                    s.heartPoints = parseInt(msg.extra.tt_tracker.heart, 10) || 0;
                }

                if (hasBlankFields(msg.extra.tt_tracker)) {
                    ttDebug(`  #${idx} P2: has blank fields, calling AI fill`);
                    const start       = Math.max(0, idx - 6);
                    const contextMsgs = ctx.chat.slice(start, idx + 1);
                    const contextText = contextMsgs
                        .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                        .join('\n\n');
                    const lockedHeart = parseInt(msg.extra.tt_tracker.heart, 10) || 0;
                    const fillPrompt =
`[OOC: The tracker below has blank fields marked as ???. Based on the conversation excerpt and character context, fill in ONLY the ??? fields. Do not change any field that already has a value. Output ONLY a complete tracker block — no other text.]

Current tracker (fill in the ??? fields):
${formatTrackerWithBlanks(msg.extra.tt_tracker)}

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: ${lockedHeart}
characters:
- name: CharacterName | description: Physical description | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;
                    try {
                        const response = await generateQuietPrompt(fillPrompt, false, true);
                        const filled = parseTrackerBlock(response);
                        ttDebug(`  #${idx} P2 fill: parsed=${filled ? `time="${filled.time}"` : 'null'}`);
                        if (filled) {
                            msg.extra.tt_tracker = mergeTrackers(msg.extra.tt_tracker, filled);
                            if (heartLocked) msg.extra.tt_tracker.heart = lockedHeartVal;
                        }
                    } catch (err) {
                        console.warn(`[TurboTracker] Could not fill blank fields for message #${idx}:`, err);
                        ttDebug(`  #${idx} P2 fill ERROR: ${err.message}`);
                    }
                }

                ttDebug(`  #${idx} P2 done: time="${msg.extra.tt_tracker.time}" heart=${msg.extra.tt_tracker.heart}`);
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            // ── Priority 3: Inline [TRACKER] block in message text ────────
            const existing = parseTrackerBlock(msg.mes || '');
            if (existing) {
                ttDebug(`  #${idx} P3: [TRACKER] in msg.mes time="${existing.time}" heart=${existing.heart}`);
                if (heartLocked) {
                    existing.heart = lockedHeartVal;
                } else if (existing.heart !== null) {
                    const maxShift = (Number(s.heartSensitivity) || 5) * 500;
                    existing.heart = clampHeart(existing.heart, s.heartPoints, maxShift);
                }
                if (existing.heart !== null) s.heartPoints = existing.heart;
                msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
                msg.extra = msg.extra || {};
                msg.extra.tt_tracker = existing;
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            // ── Priority 4: Ask the AI ────────────────────────────────────
            const start       = Math.max(0, idx - 6);
            const contextMsgs = ctx.chat.slice(start, idx + 1);
            const contextText = contextMsgs
                .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                .join('\n\n');

            const { trackerText: prevTrackerText, prevHeart: populatePrevHeart, prevTime: populatePrevTime } = getBestPrevContext(ctx.chat, idx);

            ttDebug(`  #${idx} P4: AI gen — prevTime="${populatePrevTime || 'none'}" prevHeart=${populatePrevHeart}`);

            // Pre-compute the time so the AI cannot drift — advance by 2 minutes from the
            // last known time. The AI can still write a larger jump if the scene warrants it,
            // but this gives a concrete anchor so it doesn't invent times from whole cloth.
            const computedTime = populatePrevTime ? advanceTimeString(populatePrevTime, 2) : null;
            const timeAnchor   = computedTime
                ? `The previous time was "${populatePrevTime}". Advance it by a realistic amount for what the scene depicts — for a normal brief exchange this is 1–5 minutes. Do NOT jump hours unless the scene explicitly describes a major time skip.`
                : `No previous time exists — invent one that fits the story's setting and keep it consistent going forward.`;

            const populateMaxShift  = (Number(s.heartSensitivity) || 5) * 500;

            const populateHeartLo = heartLocked ? lockedHeartVal : Math.max(0,     populatePrevHeart - populateMaxShift);
            const populateHeartHi = heartLocked ? lockedHeartVal : Math.min(99999, populatePrevHeart + populateMaxShift);

            const heartInstruction = heartLocked
                ? `heart must be exactly ${lockedHeartVal} — extracted directly from the message text.`
                : `heart must be between ${populateHeartLo} and ${populateHeartHi} (previous value was ${populatePrevHeart}).`;

            const genPrompt =
`[OOC: Based on the conversation excerpt below, infer the tracker state at the moment of the last AI message. Use the previous tracker as your starting point and only update what the narrative logically requires. Output ONLY the tracker block — no other text.

TIME: IN-STORY fiction time only — NEVER the real-world current date or time. ${timeAnchor}
${heartInstruction}]

Previous tracker state:
${prevTrackerText}

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: ${heartLocked ? lockedHeartVal : `integer_value between ${populateHeartLo} and ${populateHeartHi}`}
characters:
- name: CharacterName | description: Physical description | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;

            try {
                const response = await generateQuietPrompt(genPrompt, false, true);
                ttDebug(`  #${idx} P4 raw: "${response.slice(0, 400).replace(/\n/g, '\\n')}"`);
                const data = parseTrackerBlock(response);
                ttDebug(`  #${idx} P4 result: ${data ? `time="${data.time}" heart=${data.heart}` : 'null — retrying'}`);
                if (data) {
                    if (heartLocked) {
                        data.heart = lockedHeartVal;
                    } else if (data.heart !== null) {
                        data.heart = clampHeart(data.heart, populatePrevHeart, populateMaxShift);
                    }
                    s.heartPoints = data.heart ?? populatePrevHeart;
                    msg.extra = msg.extra || {};
                    msg.extra.tt_tracker = data;
                    renderMessageTracker(idx);
                } else {
                    // Retry once if the AI didn't produce a parseable tracker block
                    const retry = await generateQuietPrompt(genPrompt, false, true);
                    ttDebug(`  #${idx} P4 retry raw: "${retry.slice(0, 400).replace(/\n/g, '\\n')}"`);
                    const retryData = parseTrackerBlock(retry);
                    ttDebug(`  #${idx} P4 retry: ${retryData ? `time="${retryData.time}"` : 'null (giving up)'}`);
                    if (retryData) {
                        if (heartLocked) {
                            retryData.heart = lockedHeartVal;
                        } else if (retryData.heart !== null) {
                            retryData.heart = clampHeart(retryData.heart, populatePrevHeart, populateMaxShift);
                        }
                        s.heartPoints = retryData.heart ?? populatePrevHeart;
                        msg.extra = msg.extra || {};
                        msg.extra.tt_tracker = retryData;
                        renderMessageTracker(idx);
                    } else {
                        console.warn(`[TurboTracker] No parseable tracker block from AI for message #${idx} after retry.`);
                    }
                }
            } catch (err) {
                console.warn(`[TurboTracker] Could not generate tracker for message #${idx}:`, err);
                ttDebug(`  #${idx} P4 ERROR: ${err.message}`);
            }

            done++;
            status.text(`${done} / ${aiMessages.length} messages…`);
        }

        // Handle user messages: use their own STTracker data if available,
        // otherwise inherit from the most recent preceding tracker.
        for (let i = 0; i < ctx.chat.length; i++) {
            const umsg = ctx.chat[i];
            if (!umsg.is_user) continue;

            // If this user message has its own STTracker data, use it directly
            const stImported = tryImportSTTracker(umsg);
            if (stImported) {
                const sourceTracker = getMostRecentTracker(ctx.chat, i);
                stImported.heart = sourceTracker?.heart ?? null;
                umsg.extra = umsg.extra || {};
                umsg.extra.tt_tracker = stImported;
                renderMessageTracker(i);
                continue;
            }

            // Otherwise inherit from the nearest preceding tracker
            const sourceTracker = getMostRecentTracker(ctx.chat, i);
            if (sourceTracker) {
                const existing = umsg.extra?.tt_tracker;
                umsg.extra = umsg.extra || {};
                umsg.extra.tt_tracker = existing
                    ? { ...existing, heart: sourceTracker.heart }
                    : { ...sourceTracker };
                renderMessageTracker(i);
            }
        }

        await ctx.saveChat();
        saveSettingsDebounced();
        status.text('Done!');
        setTimeout(() => status.text(''), 3000);

    } finally {
        isPopulating = false;
        btn.prop('disabled', false);
        $('#tt-regen-all-btn').prop('disabled', false);
        injectPrompt(true); // restore full prompt when done
    }
}

async function regenerateAllTrackers() {
    if (isPopulating) return;
    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) return;

    // Clear all tt_tracker entries, preserving everything else (msg.tracker, msg.mes, etc.)
    ctx.chat.forEach(msg => {
        if (msg.extra?.tt_tracker) delete msg.extra.tt_tracker;
    });
    $('.tt-container').remove();

    // Re-run full populate from scratch — STTracker data and time chains re-read fresh
    await populateAllMessages();
}

// ── Event handlers ────────────────────────────────────────────

function onCharacterMessageRendered(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    ttDebug(`EVENT char_msg_rendered #${mesId} hasTracker=${!!msg.extra?.tt_tracker}`);

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

    ttDebug(`EVENT user_msg_rendered #${mesId} hasTracker=${!!msg.extra?.tt_tracker}`);

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
    // For new chats with no tracker data, fall back to defaultHeartValue.
    const s = getSettings();
    const ctx = getContext();
    let latestHeart = s.defaultHeartValue || 0;
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

    const colorRowsHtml = s.heartColors.map((c, i) => `
            <div class="tt-color-row">
                <span class="tt-color-emoji">${c.emoji}</span>
                <label class="tt-color-range-label">Min</label>
                <input type="number" class="tt-color-min text_pole tt-heart-num-input"
                       data-coloridx="${i}" min="0" max="99999" value="${c.min}">
                <label class="tt-color-range-label">Max</label>
                <input type="number" class="tt-color-max text_pole tt-heart-num-input"
                       data-coloridx="${i}" min="0" max="99999" value="${c.max}">
            </div>`).join('');

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

            <div class="inline-drawer tt-heart-drawer">
                <div class="inline-drawer-toggle inline-drawer-header tt-heart-drawer-header">
                    <b>💘 Heart Meter</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                </div>
                <div class="inline-drawer-content tt-heart-drawer-content">
                    <div class="tt-setting-row">
                        <span class="tt-setting-label">Default Starting Heart</span>
                        <input type="number" id="tt-default-heart" class="tt-heart-num-input text_pole"
                               min="0" max="99999" step="1" value="${s.defaultHeartValue || 0}">
                    </div>
                    <small>Heart value assigned at the start of every new chat.</small>

                    <div class="tt-setting-row">
                        <span class="tt-setting-label">Heart Sensitivity</span>
                        <input type="range" id="tt-heart-sensitivity" class="tt-sensitivity-slider"
                               min="1" max="10" step="1" value="${s.heartSensitivity}">
                        <span id="tt-heart-sensitivity-val" class="tt-sensitivity-val">${s.heartSensitivity}</span>
                    </div>
                    <small id="tt-sensitivity-desc">Max shift per AI response: ±${maxShift} pts &nbsp;(1 = slow → 10 = fast, max ±5,000)</small>

                    <hr class="tt-divider">

                    <div class="tt-colors-header">Heart Color Ranges</div>
                    ${colorRowsHtml}
                </div>
            </div>

            <hr class="tt-divider">

            <div class="tt-setting-row">
                <button id="tt-populate-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    Populate All Trackers
                </button>
                <span id="tt-populate-status" class="tt-status"></span>
            </div>
            <div class="tt-setting-row">
                <button id="tt-regen-all-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-rotate-left"></i>
                    Regenerate All Trackers
                </button>
            </div>
            <small>Populate: infers tracker data for messages missing it. Regenerate: clears and rebuilds all trackers from scratch.</small>

            <hr class="tt-divider">

            <div class="inline-drawer tt-debug-drawer">
                <div class="inline-drawer-toggle inline-drawer-header tt-heart-drawer-header">
                    <b>🔧 Debug Log</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                </div>
                <div class="inline-drawer-content tt-debug-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="tt-debug-enabled" ${s.debugEnabled ? 'checked' : ''}>
                        <span>Enable debug logging</span>
                    </label>
                    <div class="tt-debug-actions">
                        <button id="tt-debug-copy-btn" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-copy"></i> Copy Log
                        </button>
                        <button id="tt-debug-clear-btn" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-trash"></i> Clear
                        </button>
                    </div>
                    <textarea id="tt-debug-log" class="tt-debug-log text_pole" readonly rows="10"
                              placeholder="Enable debug logging, then reproduce the issue…"></textarea>
                </div>
            </div>
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

    $('#tt-default-heart').on('input', function () {
        const val = Math.max(0, Math.min(99999, parseInt(this.value) || 0));
        getSettings().defaultHeartValue = val;
        saveSettingsDebounced();
    });

    $('#tt-heart-sensitivity').on('input', function () {
        const val = Number(this.value);
        getSettings().heartSensitivity = val;
        $('#tt-heart-sensitivity-val').text(val);
        $('#tt-sensitivity-desc').text(`Max Heart Meter shift per AI response: \u00b1${val * 500} pts \u00a0(1\u2009=\u2009slow \u2192 10\u2009=\u2009fast)`);
        saveSettingsDebounced();
        injectPrompt();
    });

    $('.tt-color-min').on('input', function () {
        const idx = parseInt($(this).data('coloridx'));
        const val = Math.max(0, Math.min(99999, parseInt(this.value) || 0));
        getSettings().heartColors[idx].min = val;
        saveSettingsDebounced();
        injectPrompt();
    });

    $('.tt-color-max').on('input', function () {
        const idx = parseInt($(this).data('coloridx'));
        const val = Math.max(0, Math.min(99999, parseInt(this.value) || 0));
        getSettings().heartColors[idx].max = val;
        saveSettingsDebounced();
        injectPrompt();
    });

    $('#tt-populate-btn').on('click', populateAllMessages);
    $('#tt-regen-all-btn').on('click', regenerateAllTrackers);

    $('#tt-debug-enabled').on('change', function () {
        getSettings().debugEnabled = this.checked;
        saveSettingsDebounced();
        if (!this.checked) return;
        const $log = $('#tt-debug-log');
        $log.val(debugLines.join('\n'));
        if (debugLines.length) $log[0].scrollTop = $log[0].scrollHeight;
    });

    $('#tt-debug-copy-btn').on('click', function () {
        const text = debugLines.join('\n');
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = $(this);
            btn.html('<i class="fa-solid fa-check"></i> Copied!');
            setTimeout(() => btn.html('<i class="fa-solid fa-copy"></i> Copy Log'), 2000);
        });
    });

    $('#tt-debug-clear-btn').on('click', function () {
        debugLines.length = 0;
        $('#tt-debug-log').val('');
    });
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
