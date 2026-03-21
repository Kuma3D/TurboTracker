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
function advanceTimeString(timeStr, minutes) {    if (!timeStr) return timeStr;

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

/**
 * Parse a time field value that the AI returned as a minute offset.
 * Accepts plain integers or "N minutes" / "N min" formats.
 * Returns the integer if valid (1–1440 minutes), or null if it looks like
 * a real clock time or anything else we can't use as a minute count.
 */
function parseMinuteOffset(val) {
    if (!val) return null;
    const m = String(val).trim().match(/^(\d+)\s*(?:minutes?|min|m)?$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return (n >= 1 && n <= 1440) ? n : null;
}

/**
 * Estimate the number of in-story minutes that likely pass during a message,
 * based on keywords in the message text.  Used as a heuristic fallback when
 * the AI does not return a valid integer minute offset.
 *
 * Priority order:
 *   1. Explicit long time skip keywords → 90 min
 *   2. Travel / movement keywords       → 10 min
 *   3. Meals / grooming / tasks         → 15 min
 *   4. Default casual exchange          → 3–5 min scaled by message length
 */
function estimateMinutesFromContent(text) {
    const t = (text || '').toLowerCase();
    const r = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

    if (/\b(hours?\s+later|next\s+(?:day|morning|afternoon|evening|night)|the\s+following\s+(?:day|morning)|woke?\s+up|fell\s+asleep|overnight|days?\s+later)\b/.test(t)) {
        return r(60, 90);
    }
    if (/\b(walk(?:ed|s|ing)|ran\b|running|arriv(?:ed|es|ing)|depart(?:ed)|left\s+(?:the|a|her|his|their|your)\b|head(?:ed|ing)\s+(?:to\b|towards?\b|for\b|back\b)|travel(?:led|ing)?|drove\b|driv(?:es|ing)|riding|climb(?:ed|ing)|descend(?:ed|ing)|jogg(?:ed|ing)|march(?:ed|ing)|stroll(?:ed|ing)|wander(?:ed|ing))\b/.test(t)) {
        return r(8, 15);
    }
    if (/\b(eat(?:ing|s|en)?|meal\b|dinner\b|lunch\b|breakfast\b|drink(?:ing)?|bath(?:ing)?|shower(?:ing)?|dress(?:ed|ing)\b|chang(?:ed|ing)\s+(?:into|out|clothes?)|groom(?:ing)?|cook(?:ing)?|prepar(?:ed|ing))\b/.test(t)) {
        return r(12, 20);
    }
    // Default: scale by message length, with random variance in the 2-10 range
    if (t.length > 600) return r(5, 10);
    if (t.length > 300) return r(3, 8);
    return r(2, 6);
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

/**
 * Keyword-based heuristic for estimating heart change from message content.
 * Returns a signed integer delta.  All values are fractions of maxShift —
 * the absolute value of the return will NEVER exceed maxShift.
 *
 * Negative deltas are reserved for clearly hostile/antagonistic content.
 * Shy, embarrassed, or flustered behaviour is treated as positive (attraction).
 *
 * @param {string} text     - The message text to analyze.
 * @param {number} maxShift - Maximum allowed change (sensitivity * 500).
 * @returns {number} Signed delta to add to the previous heart value.
 */
function estimateHeartDelta(text, maxShift) {
    const t = (text || '').toLowerCase();
    const r = (min, max) => {
        const lo = Math.round(Math.min(min, max));
        const hi = Math.round(Math.max(min, max));
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    };

    // ── Major negative: betrayal, violence, deep hostility ──
    // Only match unambiguously hostile actions
    if (/\b(betray(?:ed|al|s|ing)?|murder(?:ed|s|ing)?|kill(?:ed|s|ing)?\s+(?:you|him|her|them|me)|abandon(?:ed|s|ing)?\s+(?:you|him|her|them|me)|hate[sd]?\s+(?:you|him|her|them|me)|despise[sd]?|loathe[sd]?|detest(?:ed|s|ing)?|sworn\s+enem|mortal\s+enem)\b/.test(t)) {
        return -r(Math.round(maxShift * 0.7), maxShift);
    }

    // ── Moderate negative: arguments, insults, rejection ──
    if (/\b(argu(?:ed|es|ing|ment)|insult(?:ed|s|ing)?|reject(?:ed|s|ion|ing)?|slap(?:ped|s)?\s+(?:you|him|her|them|me|across)|shov(?:ed|es|ing)\s+(?:you|him|her|them|me)|scold(?:ed|s|ing)?|yell(?:ed|s|ing)?\s+at|scream(?:ed|s|ing)?\s+at|disgust(?:ed)?\s+(?:by|with|at)|mock(?:ed|s|ing)?|ridicul(?:ed?|es|ing)?|sneer(?:ed|s|ing)?\s+at)\b/.test(t)) {
        return -r(Math.round(maxShift * 0.4), Math.round(maxShift * 0.7));
    }

    // ── Mild negative: only clearly cold/hostile behaviour ──
    // Excludes shyness, embarrassment, looking away from bashfulness, etc.
    if (/\b(cold\s+shoulder|ignored?\s+(?:you|him|her|them)|storm(?:ed|s|ing)?\s+(?:out|off|away)|glare[sd]?\s+(?:at|toward)|scoff(?:ed|s|ing)?|hostil(?:e|ity)|bitter(?:ly)?\s+(?:said|spoke|replied|laughed|spat))\b/.test(t)) {
        return -r(Math.round(maxShift * 0.2), Math.round(maxShift * 0.4));
    }

    // ── Major positive: confession, kiss, love, sacrifice ──
    if (/\b(confess(?:ed|es|ion|ing)?(?:\s+(?:love|feelings?))?|kiss(?:ed|es|ing)?|lov(?:e[sd]?|ing)\s+you|i\s+love\s+you|marry|propos(?:ed|al|ing)|sacrific(?:ed?|ing)|sav(?:ed|es|ing)\s+(?:your|his|her|their|my)\s+life|embrac(?:ed?|es|ing)|caress(?:ed?|es|ing)|passionate(?:ly)?|soulmate|beloved|devot(?:ed|ion))\b/.test(t)) {
        return r(Math.round(maxShift * 0.8), maxShift);
    }

    // ── Moderate positive: affection, kindness, shy/flustered attraction ──
    // Includes blushing, embarrassment, heart-pounding — these signal attraction
    if (/\b(compliment(?:ed|s|ing)?|kind(?:ness|ly)?|hug(?:ged|s|ging)?|held?\s+hands?|hand\s+on\s+(?:shoulder|cheek|hand|arm)|lean(?:ed|s|ing)?\s+(?:against|on|into|closer)|blush(?:ed|es|ing)?|face\s+(?:burn|red|flush|heat)|ears?\s+(?:burn|red|flush)|heart\s+(?:pound|rac|flutter|skip|swell|beat(?:ing)?\s+fast)|flutter(?:ed|s|ing)?|butterfl(?:y|ies)|nervous(?:ly)?(?:\s+(?:laugh|smile|giggle))?|flustered|embarrass(?:ed|ment|ing)?|shy(?:ly)?|can'?t\s+(?:look|stop\s+(?:look|star|think))|protect(?:ed|s|ing)?|comfort(?:ed|s|ing)?|reassur(?:ed|es|ing)?|gentle|gently|soft(?:ly)?\s+(?:smil|touch|voice|whisper|spoke|said)|warm(?:ly|th)?|sweet(?:ly)?|car(?:ed?|ing)\s+(?:for|about)|worry(?:ing|ied)?\s+about|miss(?:ed)?\s+(?:you|him|her))\b/.test(t)) {
        return r(Math.round(maxShift * 0.5), Math.round(maxShift * 0.8));
    }

    // ── Mild positive: smiles, laughter, friendly interaction ──
    if (/\b(smil(?:ed?|es|ing)|laugh(?:ed|s|ing)?|chuckl(?:ed?|es|ing)|giggl(?:ed?|es|ing)|grin(?:ned|s|ning)?|nod(?:ded|s|ding)?|wink(?:ed|s|ing)?|playful(?:ly)?|teas(?:ed?|es|ing)|jok(?:ed?|es|ing)|friendly|interest(?:ed|ing)?|curious(?:ly)?|cheerful(?:ly)?|enjoy(?:ed|s|ing)?|happy|happily|excite[ds]?|excited(?:ly)?|thank(?:ed|s|ful|ing)?)\b/.test(t)) {
        return r(Math.round(maxShift * 0.3), Math.round(maxShift * 0.5));
    }

    // ── Default: neutral/casual — small positive increase ──
    return r(Math.round(maxShift * 0.2), Math.round(maxShift * 0.4));
}

/**
 * Generate a heart value for an AI message.
 * Hybrid approach: tries an AI quiet prompt first, and if the AI returns
 * roleplay text instead of a valid integer, falls back to keyword heuristic.
 * Callers must handle clearing/restoring the extension prompt if needed.
 */
async function generateHeartValue(msgText, prevHeart, maxShift) {
    const prev  = parseInt(prevHeart, 10) || 0;
    const shift = Math.max(1, parseInt(maxShift, 10) || 2500);

    // Round to nearest 100 — all heart changes must be clean multiples of 100
    const r100 = v => Math.round(v / 100) * 100;

    // 1. Try extracting from inline text first (e.g. "Black Heart (500) 🖤")
    const inline = extractHeartFromText(msgText);
    if (inline !== null) {
        ttDebug(`generateHeartValue: inline extraction → ${inline}`);
        return r100(clampHeart(inline, prev, shift));
    }

    // 2. Try AI call — ask for a signed integer delta
    const prompt =
`[OOC: Based on the following story excerpt, how does the character's romantic interest toward {{user}} change?
Current heart value: ${prev} (scale: 0–99,999).
Reply with ONLY a signed integer for the change amount. Must be a multiple of 100.
Positive = warmer/friendlier feelings. Negative = colder/hostile feelings.
The change MUST be between -${shift} and +${shift}.
Casual conversation: +${r100(shift * 0.2)} to +${r100(shift * 0.4)}.
Kind/friendly interaction: +${r100(shift * 0.3)} to +${r100(shift * 0.5)}.
Meaningful positive interaction: +${r100(shift * 0.5)} to +${r100(shift * 0.8)}.
Major emotional event: +${r100(shift * 0.8)} to +${r100(shift)}.
Negative interaction: -${r100(shift * 0.2)} to -${r100(shift * 0.7)}.
Reply with ONLY a signed integer like +${r100(shift * 0.3)} or -${r100(shift * 0.3)}. No other text.]

"${(msgText || '').slice(0, 600)}"`;

    try {
        const response = await generateQuietPrompt(prompt, false, true);
        ttDebug(`generateHeartValue: AI raw="${response.slice(0, 120)}"`);
        const match = response.trim().match(/([+-]?\d{1,5})/);
        if (match) {
            let delta = parseInt(match[1], 10);
            if (!isNaN(delta) && delta !== 0) {
                delta = r100(Math.max(-shift, Math.min(shift, delta)));
                const newVal = Math.max(0, Math.min(99900, prev + delta));
                ttDebug(`generateHeartValue: AI delta=${delta > 0 ? '+' : ''}${delta} → ${r100(newVal)}`);
                return r100(newVal);
            }
        }
        ttDebug(`generateHeartValue: AI returned no valid integer, falling back to heuristic`);
    } catch (e) {
        ttDebug(`generateHeartValue: AI ERROR ${e.message}, falling back to heuristic`);
    }

    // 3. Heuristic fallback — keyword-based sentiment analysis
    //    estimateHeartDelta already returns values within ±maxShift
    const delta = r100(estimateHeartDelta(msgText, shift));
    const newVal = r100(Math.max(0, Math.min(99900, prev + delta)));
    ttDebug(`generateHeartValue: heuristic delta=${delta > 0 ? '+' : ''}${delta} → ${newVal} (maxShift=${shift})`);
    return newVal;
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
        else if (key === 'heart') {
            // Coerce to integer immediately — descriptive text (e.g. "Alice feels...") becomes null
            const h = parseInt(val, 10);
            result.heart = isNaN(h) ? null : h;
        }
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
        // If this tracker has a heart value, use it. Otherwise scan further back
        // to find any tracker with a non-null heart — ST-Tracker imports store
        // null hearts, so the nearest tracker may not have one.
        let prevHeart = null;
        if (ttTracker.heart !== null && ttTracker.heart !== undefined) {
            prevHeart = parseInt(ttTracker.heart, 10);
        } else {
            for (let i = ttIdx - 1; i >= 0; i--) {
                const h = chat[i]?.extra?.tt_tracker?.heart;
                if (h !== null && h !== undefined) {
                    prevHeart = parseInt(h, 10);
                    break;
                }
            }
        }
        return {
            trackerText: formatTrackerForPrompt(patched),
            prevHeart,
            prevTime,
        };
    }

    // No tt_tracker at all — build minimal context from raw STTracker data
    if (stTime) {
        const synth = { time: stTime, location: null, weather: null, heart: null, characters: [] };
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
    const heartDisplay = (data.heart !== null && data.heart !== undefined)
        ? parseInt(data.heart, 10) || 0
        : 'unknown (not yet established)';
    let text = `time: ${data.time || 'Unknown'}\nlocation: ${data.location || 'Unknown'}\nweather: ${data.weather || 'Unknown'}\nheart: ${heartDisplay}`;
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
            const nudge = 2 + Math.floor(Math.random() * 4); // 2–5 min variance
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
async function processMessage(mesId) {
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
        // ST-Tracker has no heart data — generate one via AI
        const prevTracker = getMostRecentTracker(ctx.chat, mesId);
        const prevHeart = parseInt(prevTracker?.heart ?? s.heartPoints, 10) || 0;
        const maxShift = (Number(s.heartSensitivity) || 5) * 500;

        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
        try {
            imported.heart = await generateHeartValue(msg.mes, prevHeart, maxShift);
        } finally {
            injectPrompt();
        }
        s.heartPoints = parseInt(imported.heart, 10) || 0;
        ttDebug(`  #${mesId} STTracker heart generated: ${imported.heart} (prev=${prevHeart})`);
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

        const { trackerText: prevTrackerText, prevHeart: rawPrevHeart, prevTime: regenPrevTime } = getBestPrevContext(ctx.chat, mesId);
        const heartKnown = rawPrevHeart !== null;
        const prevHeart  = heartKnown ? rawPrevHeart : 0;
        const heartLo    = heartKnown ? Math.max(0,     prevHeart - maxShift) : 0;
        const heartHi    = heartKnown ? Math.min(99999, prevHeart + maxShift) : 99999;

        ttDebug(`  regen #${mesId}: prevHeart=${prevHeart} range=[${heartLo},${heartHi}] prevTime="${regenPrevTime || 'none'}"`);
        let genPrompt;
        let regenNudge    = 0;
        let regenUserTime = null;

        if (msg.is_user) {
            // User message: compute time ourselves (prev + 2-5 min) — never let the AI set it.
            regenNudge    = 2 + Math.floor(Math.random() * 4); // 2–5 min
            regenUserTime = regenPrevTime
                ? advanceTimeString(regenPrevTime, regenNudge)
                : 'h:MM AM/PM; MM/DD/YYYY (DayOfWeek)';
            ttDebug(`  regen #${mesId} user: prevTime="${regenPrevTime}" +${regenNudge}min → "${regenUserTime}"`);

            genPrompt =
`[OOC: Based on the user's message below and the previous tracker state, produce an updated tracker reflecting any scene changes the user's message logically implies. Output ONLY the tracker block — no other text.

The time is already set — do NOT change it.
heart must remain exactly ${prevHeart} — only the character's emotions change this, never the user.]

Previous tracker state:
${prevTrackerText}

User's message:
${msg.mes}

[TRACKER]
time: ${regenUserTime}
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
heart must be between ${heartLo} and ${heartHi}${heartKnown ? ` (previous value was ${prevHeart})` : ' — heart has not been established yet, infer an appropriate value from the narrative'}.]

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
                // Hard lock heart and time on user messages — we computed both, AI must not override them
                data.heart = prevHeart;
                if (regenPrevTime) data.time = advanceTimeString(regenPrevTime, regenNudge);
            } else {
                if (data.heart !== null) {
                    data.heart = heartKnown
                        ? clampHeart(data.heart, prevHeart, maxShift)
                        : Math.max(0, Math.min(99999, parseInt(data.heart, 10) || 0));
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
        ? `\nUSER'S CURRENT MESSAGE — use this to update location, weather, and characters if the scene requires it. Do NOT use any time-of-day mentions in this message to set the tracker time — time advances are governed by TIME RULES only:\n"${latestUserMsg}"\n`
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
  • HARD CAP: Advance by AT MOST 20 minutes from the baseline, unless the narrative text contains a literal, explicit time-skip phrase such as "an hour passed", "by late afternoon", "after several hours", "the next morning", etc.
  • Default advance: 2–10 minutes for a typical exchange.
  • Atmosphere words ("the morning sun", "it's almost noon", "the midday heat") are NOT time-skip phrases and must NOT move the clock more than a few minutes.
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
    if (tracker.heart === null || tracker.heart === undefined) return true;
    for (const c of (tracker.characters || [])) {
        if (!c.description || !c.outfit || !c.state || !c.position) return true;
    }
    return false;
}

function formatTrackerWithBlanks(tracker) {
    const mark = v => isBlankValue(v) ? '???' : v;
    const heartStr = (tracker.heart === null || tracker.heart === undefined) ? '???' : (parseInt(tracker.heart, 10) || 0);
    let text = `time: ${mark(tracker.time)}\nlocation: ${mark(tracker.location)}\nweather: ${mark(tracker.weather)}\nheart: ${heartStr}`;
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
        heart:      (existing.heart !== null && existing.heart !== undefined) ? existing.heart : filled.heart,
        characters: [...mergedChars, ...newChars],
    };
}

// ── Retroactive population ────────────────────────────────────

let isPopulating = false;
let stopPopulate = false;

async function populateAllMessages() {
    if (isPopulating) return;
    isPopulating = true;
    stopPopulate = false;

    const btn    = $('#tt-populate-btn');
    const status = $('#tt-populate-status');
    const stopBtn = $('#tt-stop-btn');
    btn.prop('disabled', true);
    $('#tt-regen-all-btn').prop('disabled', true);
    stopBtn.show().prop('disabled', false).html('<i class="fa-solid fa-stop"></i> Stop');

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

        const totalMessages = ctx.chat.length;
        let done = 0;
        status.text(`0 / ${totalMessages} messages…`);

        // Single pass — process ALL messages in chronological order.
        // User messages inherit from the preceding AI message's tracker.
        // AI messages go through P1/P2/P3/P4 as before.
        for (let idx = 0; idx < ctx.chat.length; idx++) {
            if (stopPopulate) {
                ttDebug('Populate stopped by user');
                status.text('Stopped by user.');
                break;
            }

            const msg = ctx.chat[idx];

            // ── User messages: inherit tracker from preceding AI message ──
            if (msg.is_user) {
                const stImported = tryImportSTTracker(msg);
                if (stImported) {
                    const sourceTracker = getMostRecentTracker(ctx.chat, idx);
                    stImported.heart = sourceTracker?.heart ?? s.heartPoints;
                    msg.extra = msg.extra || {};
                    msg.extra.tt_tracker = stImported;
                    ttDebug(`  user #${idx}: STTracker imported, heart=${stImported.heart}`);
                } else {
                    const sourceTracker = getMostRecentTracker(ctx.chat, idx);
                    if (sourceTracker) {
                        msg.extra = msg.extra || {};
                        const existing = msg.extra.tt_tracker;
                        if (existing) {
                            msg.extra.tt_tracker = { ...existing, heart: sourceTracker.heart };
                            ttDebug(`  user #${idx}: synced heart=${sourceTracker.heart}`);
                        } else {
                            const nudge = 2 + Math.floor(Math.random() * 4);
                            const nudgedTime = advanceTimeString(sourceTracker.time, nudge);
                            msg.extra.tt_tracker = { ...sourceTracker, time: nudgedTime };
                            ttDebug(`  user #${idx}: inherited time="${sourceTracker.time}" +${nudge}min → "${nudgedTime}" heart=${sourceTracker.heart}`);
                        }
                    } else {
                        ttDebug(`  user #${idx}: no source tracker found`);
                    }
                }
                if (msg.extra?.tt_tracker) renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${totalMessages} messages…`);
                continue;
            }

            // ── AI messages ──

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
                // Compute heart context — ST-Tracker never has heart data
                const prevContext = getMostRecentTracker(ctx.chat, idx);
                const prevHeart = parseInt(prevContext?.heart ?? s.heartPoints, 10) || 0;
                const pMaxShift = (Number(s.heartSensitivity) || 5) * 500;

                // Heart handled separately — set placeholder so fill focuses on other fields
                stImported.heart = heartLocked ? lockedHeartVal : prevHeart;

                msg.extra = msg.extra || {};
                msg.extra.tt_tracker = stImported;

                // Fill non-heart blank fields (location details, character info, etc.)
                const hasOtherBlanks = isBlankValue(stImported.time) || isBlankValue(stImported.location) || isBlankValue(stImported.weather) ||
                    (stImported.characters || []).some(c => !c.description || !c.outfit || !c.state || !c.position);

                if (hasOtherBlanks) {
                    ttDebug(`  #${idx} P1: has blank non-heart fields, calling AI fill`);
                    const markV = v => isBlankValue(v) ? '???' : v;
                    const fillCharsText = (stImported.characters || []).length
                        ? stImported.characters
                            .map(c => `- name: ${c.name} | description: ${markV(c.description)} | outfit: ${markV(c.outfit)} | state: ${markV(c.state)} | position: ${markV(c.position)}`)
                            .join('\n')
                        : '- name: ??? | description: ??? | outfit: ??? | state: ??? | position: ???';
                    const fillPrompt =
`[OOC: Extract tracker metadata from the story excerpt below. Output ONLY the completed [TRACKER]...[/TRACKER] block. Fill every ??? using the story for context. Do NOT change the heart value. No story content, no dialogue — only the block.]

Story excerpt:
"${(msg.mes || '').slice(0, 600)}"

[TRACKER]
time: ${markV(stImported.time)}
location: ${markV(stImported.location)}
weather: ${markV(stImported.weather)}
heart: ${prevHeart}
characters:
${fillCharsText}
[/TRACKER]`;
                    setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
                    try {
                        const response = await generateQuietPrompt(fillPrompt, false, true);
                        ttDebug(`  #${idx} P1 fill raw: "${response.slice(0, 300).replace(/\n/g, '\\n')}"`);
                        const filled = parseTrackerBlock(response);
                        ttDebug(`  #${idx} P1 fill: parsed=${filled ? `time="${filled.time}"` : 'null'}`);
                        if (filled) {
                            // Merge non-heart fields only — heart handled below
                            const merged = mergeTrackers(stImported, filled);
                            merged.heart = stImported.heart; // preserve, don't use fill's heart
                            msg.extra.tt_tracker = merged;
                        }
                    } catch (err) {
                        console.warn(`[TurboTracker] Could not fill blank ST fields for message #${idx}:`, err);
                        ttDebug(`  #${idx} P1 fill ERROR: ${err.message}`);
                    }
                }

                // Always generate heart independently for AI messages
                if (!heartLocked) {
                    if (!prevContext) {
                        // First message in chat — use default starting heart, no AI call
                        msg.extra.tt_tracker.heart = s.defaultHeartValue || 0;
                        ttDebug(`  #${idx} P1: first message, heart set to default ${msg.extra.tt_tracker.heart}`);
                    } else {
                        ttDebug(`  #${idx} P1: generating heart (prev=${prevHeart})`);
                        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
                        msg.extra.tt_tracker.heart = await generateHeartValue(msg.mes, prevHeart, pMaxShift);
                    }
                }

                // Always update the running heart state so subsequent messages have a correct baseline
                s.heartPoints = parseInt(msg.extra.tt_tracker.heart, 10) || 0;
                ttDebug(`  #${idx} P1 done: time="${msg.extra.tt_tracker.time}" heart=${msg.extra.tt_tracker.heart}`);
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${totalMessages} messages…`);
                continue;
            }

            // ── Priority 2: Already has a tt_tracker (no STTracker on this msg) ──
            if (msg.extra?.tt_tracker) {
                ttDebug(`  #${idx} P2: existing tt_tracker time="${msg.extra.tt_tracker.time}" heart=${msg.extra.tt_tracker.heart}`);
                // Compute heart context for potential generation
                const prevContext2 = getMostRecentTracker(ctx.chat, idx);
                const prevHeart2 = parseInt(prevContext2?.heart ?? s.heartPoints, 10) || 0;
                const p2MaxShift = (Number(s.heartSensitivity) || 5) * 500;

                // Inline heart always wins over whatever is stored
                if (heartLocked) {
                    msg.extra.tt_tracker = { ...msg.extra.tt_tracker, heart: lockedHeartVal };
                    s.heartPoints = lockedHeartVal;
                } else if (msg.extra.tt_tracker.heart !== null) {
                    s.heartPoints = parseInt(msg.extra.tt_tracker.heart, 10) || 0;
                }

                if (hasBlankFields(msg.extra.tt_tracker)) {
                    ttDebug(`  #${idx} P2: has blank fields, calling AI fill`);
                    const curTracker = msg.extra.tt_tracker;
                    const needsHeart = (curTracker.heart === null || curTracker.heart === undefined);
                    const markV = v => isBlankValue(v) ? '???' : v;
                    const fillCharsText = (curTracker.characters || []).length
                        ? curTracker.characters
                            .map(c => `- name: ${c.name} | description: ${markV(c.description)} | outfit: ${markV(c.outfit)} | state: ${markV(c.state)} | position: ${markV(c.position)}`)
                            .join('\n')
                        : '- name: ??? | description: ??? | outfit: ??? | state: ??? | position: ???';
                    const fillPrompt =
`[OOC: Extract tracker metadata from the story excerpt below. Output ONLY the completed [TRACKER]...[/TRACKER] block. Fill every ??? using the story for context. Do NOT change the heart value. No story content, no dialogue — only the block.]

Story excerpt:
"${(msg.mes || '').slice(0, 600)}"

[TRACKER]
time: ${markV(curTracker.time)}
location: ${markV(curTracker.location)}
weather: ${markV(curTracker.weather)}
heart: ${needsHeart ? prevHeart2 : parseInt(curTracker.heart, 10) || 0}
characters:
${fillCharsText}
[/TRACKER]`;
                    setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
                    try {
                        const response = await generateQuietPrompt(fillPrompt, false, true);
                        ttDebug(`  #${idx} P2 fill raw: "${response.slice(0, 300).replace(/\n/g, '\\n')}"`);
                        const filled = parseTrackerBlock(response);
                        ttDebug(`  #${idx} P2 fill: parsed=${filled ? `time="${filled.time}"` : 'null'}`);
                        if (filled) {
                            const merged = mergeTrackers(msg.extra.tt_tracker, filled);
                            // Preserve heart — don't use fill's value
                            merged.heart = msg.extra.tt_tracker.heart;
                            msg.extra.tt_tracker = merged;
                            if (heartLocked) msg.extra.tt_tracker.heart = lockedHeartVal;
                        }
                    } catch (err) {
                        console.warn(`[TurboTracker] Could not fill blank fields for message #${idx}:`, err);
                        ttDebug(`  #${idx} P2 fill ERROR: ${err.message}`);
                    }
                }

                // If heart is still null after fill, generate via dedicated AI call
                if (!heartLocked && (msg.extra.tt_tracker.heart === null || msg.extra.tt_tracker.heart === undefined)) {
                    ttDebug(`  #${idx} P2: heart still null, generating via dedicated AI call`);
                    setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
                    msg.extra.tt_tracker.heart = await generateHeartValue(msg.mes, prevHeart2, p2MaxShift);
                }

                // Always update running heart state
                if (msg.extra.tt_tracker.heart !== null) {
                    s.heartPoints = parseInt(msg.extra.tt_tracker.heart, 10) || 0;
                }

                ttDebug(`  #${idx} P2 done: time="${msg.extra.tt_tracker.time}" heart=${msg.extra.tt_tracker.heart}`);
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${totalMessages} messages…`);
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
                status.text(`${done} / ${totalMessages} messages…`);
                continue;
            }

            // ── Priority 4: Ask the AI ────────────────────────────────────
            const { prevHeart: populatePrevHeart, prevTime: populatePrevTime } = getBestPrevContext(ctx.chat, idx);
            const prevTrackerObj = getMostRecentTracker(ctx.chat, idx);

            ttDebug(`  #${idx} P4: AI gen — prevTime="${populatePrevTime || 'none'}" prevHeart=${populatePrevHeart}`);

            const populateMaxShift = (Number(s.heartSensitivity) || 5) * 500;
            const heartKnownForPopulate = populatePrevHeart !== null;
            const populateHeartLo = heartLocked ? lockedHeartVal
                                  : heartKnownForPopulate ? Math.max(0,     populatePrevHeart - populateMaxShift) : 0;
            const populateHeartHi = heartLocked ? lockedHeartVal
                                  : heartKnownForPopulate ? Math.min(99999, populatePrevHeart + populateMaxShift) : 99999;

            const heartInstruction = heartLocked
                ? `heart must be exactly ${lockedHeartVal} — extracted directly from the message text.`
                : heartKnownForPopulate
                ? `heart must be between ${populateHeartLo} and ${populateHeartHi} (previous value was ${populatePrevHeart}).`
                : `heart has not been established yet — infer an appropriate value from the narrative.`;

            // ── Step 1: Determine minute offset ───────────────────────────
            // Ask the AI for just a single integer — a much simpler task than a full tracker,
            // so far less likely to produce roleplay.  Fall back to content heuristic on failure.
            let advanceMinutes = null;
            if (populatePrevTime) {
                const minutePrompt =
`[OOC: How many in-story minutes pass during the following story excerpt? Reply with ONLY a single integer. Minimum is 2. Examples: brief dialogue exchange = 2-6, moving to a nearby location = 8-15, a longer journey = 15-60, a large time skip = 60+. No other text — just the integer.]
${msg.mes.slice(0, 600)}`;
                try {
                    const minuteResp = await generateQuietPrompt(minutePrompt, false, true);
                    // Extract the first 1-4 digit number we can find in the response
                    const firstNum = minuteResp.trim().match(/\b(\d{1,4})\b/);
                    const rawNum   = firstNum ? parseInt(firstNum[1], 10) : null;
                    // Clamp to minimum 2 — 1 minute is reserved for user-message nudges only
                    advanceMinutes = (rawNum !== null && rawNum >= 2 && rawNum <= 1440) ? rawNum : null;
                    ttDebug(`  #${idx} P4 step1 raw: "${minuteResp.slice(0, 80).replace(/\n/g, '\\n')}" → minutes=${advanceMinutes}`);
                } catch (err) {
                    ttDebug(`  #${idx} P4 step1 ERROR: ${err.message}`);
                }
            }

            if (advanceMinutes === null) {
                advanceMinutes = estimateMinutesFromContent(msg.mes || '');
                ttDebug(`  #${idx} P4: heuristic minutes=${advanceMinutes} (msgLen=${(msg.mes || '').length})`);
            }

            // Compute the final time — we own this value and the AI will not be asked to change it
            const prefilledTime = populatePrevTime
                ? advanceTimeString(populatePrevTime, advanceMinutes)
                : 'h:MM AM/PM; MM/DD/YYYY (DayOfWeek)';

            ttDebug(`  #${idx} P4: prefilledTime="${prefilledTime}" (advance=${advanceMinutes}min)`);

            // ── Step 2: Fill remaining tracker fields ─────────────────────
            const prefilledLocation  = prevTrackerObj?.location || 'Unknown';
            const prefilledWeather   = prevTrackerObj?.weather  || 'Unknown';
            // Carry forward name/description/outfit but mark state/position as ??? —
            // those are the fields most likely to change each message.
            const prefilledCharsText = (prevTrackerObj?.characters?.length)
                ? prevTrackerObj.characters
                    .map(c => `- name: ${c.name} | description: ${c.description || '???'} | outfit: ${c.outfit || '???'} | state: ??? | position: ???`)
                    .join('\n')
                : `- name: CharacterName | description: Physical description | outfit: Clothing | state: Emotional state | position: Position`;

            const genPrompt =
`[OOC: Complete this scene tracker. Fill each field based on the current story moment. The time is already set — do NOT change it. ${heartInstruction} Output ONLY the [TRACKER]...[/TRACKER] block — no story text, no dialogue, nothing else.]

[TRACKER]
time: ${prefilledTime}
location: ${prefilledLocation}
weather: ${prefilledWeather}
heart: ${heartLocked ? lockedHeartVal : `integer between ${populateHeartLo} and ${populateHeartHi}`}
characters:
${prefilledCharsText}
[/TRACKER]`;

            try {
                const response = await generateQuietPrompt(genPrompt, false, true);
                ttDebug(`  #${idx} P4 step2 raw: "${response.slice(0, 400).replace(/\n/g, '\\n')}"`);
                const data = parseTrackerBlock(response);
                ttDebug(`  #${idx} P4 result: ${data ? `time="${data.time}" heart=${data.heart}` : 'null — retrying'}`);
                if (data) {
                    // Always enforce our pre-computed time — never let the AI override it
                    data.time = prefilledTime;
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
                    // Retry once
                    const retry = await generateQuietPrompt(genPrompt, false, true);
                    ttDebug(`  #${idx} P4 retry raw: "${retry.slice(0, 400).replace(/\n/g, '\\n')}"`);
                    const retryData = parseTrackerBlock(retry);
                    ttDebug(`  #${idx} P4 retry: ${retryData ? `time="${retryData.time}"` : 'null — using fallback'}`);
                    if (retryData) {
                        retryData.time = prefilledTime;
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
                        // Both tracker fills failed — clone previous tracker with our computed time
                        ttDebug(`  #${idx} P4 fallback: cloning prev tracker, time="${prefilledTime}"`);
                        const fallback = prevTrackerObj
                            ? { ...prevTrackerObj, time: prefilledTime, heart: heartLocked ? lockedHeartVal : (prevTrackerObj.heart ?? populatePrevHeart) }
                            : { time: prefilledTime, location: 'Unknown', weather: 'Unknown', heart: heartLocked ? lockedHeartVal : populatePrevHeart, characters: [] };
                        if (!heartLocked && fallback.heart !== null) {
                            s.heartPoints = parseInt(fallback.heart, 10) || populatePrevHeart;
                        }
                        msg.extra = msg.extra || {};
                        msg.extra.tt_tracker = fallback;
                        renderMessageTracker(idx);
                        console.warn(`[TurboTracker] Used fallback tracker for message #${idx}.`);
                    }
                }
            } catch (err) {
                console.warn(`[TurboTracker] Could not generate tracker for message #${idx}:`, err);
                ttDebug(`  #${idx} P4 ERROR: ${err.message}`);
            }

            done++;
            status.text(`${done} / ${totalMessages} messages…`);
        }

        await ctx.saveChat();
        saveSettingsDebounced();
        status.text(stopPopulate ? 'Stopped.' : 'Done!');
        setTimeout(() => status.text(''), 3000);

    } finally {
        isPopulating = false;
        stopPopulate = false;
        btn.prop('disabled', false);
        $('#tt-regen-all-btn').prop('disabled', false);
        stopBtn.hide();
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

async function onCharacterMessageRendered(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    ttDebug(`EVENT char_msg_rendered #${mesId} hasTracker=${!!msg.extra?.tt_tracker}`);

    if (msg.extra?.tt_tracker) {
        renderMessageTracker(mesId);
    } else {
        await processMessage(mesId);
    }
}

/**
 * Fires at the start of any generation pass.
 * For impersonation specifically, we clear the TT system prompt so the AI
 * doesn't append a [TRACKER] block to the generated user message.
 * injectPrompt() is called again in onUserMessageRendered, which fires once
 * the impersonated message is placed into chat, restoring the prompt.
 */
function onGenerationStarted(type) {
    const s = getSettings();
    if (!s.enabled) return;

    ttDebug(`GENERATION_STARTED type="${type}"`);

    if (type === 'impersonate') {
        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
        ttDebug('  → Impersonation — TT prompt suppressed');
        return;
    }

    // Only reset the baseline for explicit user-triggered regenerations.
    // 'normal' fires for background token-count / quiet-prompt operations and
    // must be ignored here, otherwise those events corrupt s.heartPoints and
    // re-inject the wrong baseline while a generation is already in-flight.
    if (type !== 'regenerate' && type !== 'swipe') return;
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return; // Normal new generation — leave prompt alone

    const lastAiIdx = chat.length - 1;
    if (!chat[lastAiIdx].extra?.tt_tracker) return; // No prior swipe data yet — nothing to undo

    const savedTracker = chat[lastAiIdx].extra.tt_tracker;
    chat[lastAiIdx].extra.tt_tracker = null;

    let prevHeart = s.defaultHeartValue || 0;
    for (let i = lastAiIdx - 1; i >= 0; i--) {
        const h = chat[i]?.extra?.tt_tracker?.heart;
        if (h != null) { prevHeart = parseInt(h, 10) || 0; break; }
    }
    s.heartPoints = prevHeart;

    injectPrompt();

    // Restore — injectPrompt is synchronous so this is safe.
    chat[lastAiIdx].extra.tt_tracker = savedTracker;

    ttDebug(`  → Regen detected — re-injected prompt with pre-#${lastAiIdx} baseline, heart=${prevHeart}`);
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

    // Strip any [TRACKER] block the AI may have appended to an impersonated user
    // message. Without this, the AI sees a stale tracker in the user turn and uses
    // it as a baseline instead of the correct prior-message tracker.
    if ((msg.mes || '').match(/\[TRACKER\]/i)) {
        msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
        const mesText = $(`.mes[mesid="${mesId}"] .mes_text`);
        if (mesText.length) {
            mesText.html(mesText.html().replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim());
        }
        ctx.saveChat();
        ttDebug(`  #${mesId} user: stripped [TRACKER] block from impersonated message`);
    }

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
        // Clean up any lingering [TRACKER] text in msg.mes — covers both AI messages
        // that weren't stripped at render time and impersonated user messages.
        if ((msg.mes || '').match(/\[TRACKER\]/i)) {
            msg.mes = (msg.mes || '').replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim();
            modified = true;
        }
        if (msg.extra?.tt_tracker) {
            renderMessageTracker(idx);
        }
    });

    if (modified) ctx.saveChat();
}

async function onMessageEdited(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg) return;

    if (msg.is_user) {
        if (msg.extra?.tt_tracker) renderMessageTracker(mesId);
        return;
    }

    await processMessage(mesId);
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
                <button id="tt-stop-btn" class="menu_button menu_button_icon" style="display:none;">
                    <i class="fa-solid fa-stop"></i>
                    Stop
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
    $('#tt-stop-btn').on('click', function () {
        stopPopulate = true;
        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Stopping…');
    });

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
    eventSource.on(event_types.GENERATION_STARTED,         onGenerationStarted);

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
