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
 *
 * Layout:
 *   [tt-container]
 *     [tt-always]  ← Time, Location, Weather, Heart — always visible
 *     <details.tt-block> ← 🧿 Tracker — collapsible
 *       Characters Present (collapsible)
 *       Regenerate / Edit buttons
 *     </details>
 *   [/tt-container]
 */
function buildTrackerHtml(data, mesId) {
    const heartPts   = parseInt(data.heart, 10) || 0;
    const heartEmoji = getHeartEmoji(heartPts);

    // Characters Present sub-dropdown
    let charsHtml = '';
    if (data.characters && data.characters.length > 0) {
        const cards = data.characters.map(c => `
            <div class="tt-char">
                <div class="tt-char-name">${esc(c.name)}</div>
                <div class="tt-char-field"><span class="tt-char-label">Outfit</span>${esc(c.outfit)}</div>
                <div class="tt-char-field"><span class="tt-char-label">State</span>${esc(c.state)}</div>
                <div class="tt-char-field"><span class="tt-char-label">Position</span>${esc(c.position)}</div>
            </div>`).join('');

        charsHtml = `
            <details class="tt-chars">
                <summary class="tt-chars-summary">
                    Characters Present <span class="tt-char-count">(${data.characters.length})</span>
                </summary>
                <div class="tt-chars-list">${cards}</div>
            </details>`;
    }

    return `
        <div class="tt-container" data-mesid="${mesId}">
            <div class="tt-always">
                <div class="tt-row">
                    <span class="tt-label">⏰ Time</span>
                    <span class="tt-value">${esc(data.time     || 'Unknown')}</span>
                </div>
                <div class="tt-row">
                    <span class="tt-label">📍 Location</span>
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
                <summary class="tt-summary"><span>🧿 Tracker</span></summary>
                <div class="tt-fields">
                    ${charsHtml}
                    <div class="tt-actions">
                        <button class="tt-regen-btn menu_button menu_button_icon" data-mesid="${mesId}">
                            <i class="fa-solid fa-rotate"></i> Regenerate Tracker
                        </button>
                        <button class="tt-edit-btn menu_button menu_button_icon" data-mesid="${mesId}">
                            <i class="fa-solid fa-pen-to-square"></i> Edit Tracker
                        </button>
                    </div>
                </div>
            </details>
        </div>`;
}

/**
 * Build the inline edit form that replaces the tracker container.
 * Characters are presented as one pipe-separated line each for easy editing.
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
                    <label class="tt-edit-label">📍 Location</label>
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
 * Tracker is placed BEFORE .mes_text so it appears at the top of the message.
 * Also strips the raw [TRACKER]...[/TRACKER] block from the displayed message text.
 */
function renderMessageTracker(mesId) {
    const el = $(`.mes[mesid="${mesId}"]`);
    if (!el.length) return;

    // Always remove any existing tracker container first
    el.find('.tt-container').remove();

    const s = getSettings();
    if (!s.enabled) return;

    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || !msg.extra?.tt_tracker) return;

    // Strip raw tracker tags from the displayed HTML
    const mesText = el.find('.mes_text');
    mesText.html(
        mesText.html().replace(/\[TRACKER\][\s\S]*?\[\/TRACKER\]/gi, '').trim()
    );

    // Insert tracker UI BEFORE the message text (top of message)
    mesText.before(buildTrackerHtml(msg.extra.tt_tracker, mesId));
}

/**
 * Parse tracker data from a message, store it, update the display.
 */
function processMessage(mesId) {
    const s = getSettings();
    if (!s.enabled) return;

    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || msg.is_user) return;

    const data = parseTrackerBlock(msg.mes || '');
    if (!data) return;

    if (data.heart !== null) {
        const pts = parseInt(data.heart, 10);
        if (!isNaN(pts)) s.heartPoints = Math.max(0, pts);
    }

    msg.extra = msg.extra || {};
    msg.extra.tt_tracker = data;

    getContext().saveChat();
    saveSettingsDebounced();
    renderMessageTracker(mesId);
    injectPrompt();
}

// ── Regenerate Tracker ────────────────────────────────────────

async function regenTracker(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || msg.is_user) return;

    const btn = $(`.mes[mesid="${mesId}"] .tt-regen-btn`);
    btn.prop('disabled', true).html('<i class="fa-solid fa-rotate fa-spin"></i> Regenerating…');

    try {
        const start       = Math.max(0, mesId - 6);
        const contextMsgs = ctx.chat.slice(start, mesId + 1);
        const contextText = contextMsgs
            .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
            .join('\n\n');

        const genPrompt =
`[OOC: Based only on the conversation excerpt below, infer the tracker state at the moment of the last message. Output ONLY the tracker block — no other text.]

${contextText}

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: integer_value
characters:
- name: CharacterName | outfit: Clothing description | state: State | position: Position
[/TRACKER]`;

        const response = await generateQuietPrompt(genPrompt, false, true);
        const data = parseTrackerBlock(response);
        if (data) {
            msg.extra = msg.extra || {};
            msg.extra.tt_tracker = data;
            if (data.heart !== null) {
                const pts = parseInt(data.heart, 10);
                if (!isNaN(pts)) getSettings().heartPoints = Math.max(0, pts);
            }
            await ctx.saveChat();
            saveSettingsDebounced();
            renderMessageTracker(mesId);
            injectPrompt();
        }
    } catch (err) {
        console.warn(`[TurboTracker] Regen failed for message #${mesId}:`, err);
        // Restore button if re-render didn't happen
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

function injectPrompt() {
    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(EXT_NAME, '', extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const prompt = `[TurboTracker — mandatory instructions]
At the very end of EVERY response, after all narrative text, append a tracker block using exactly this format:

[TRACKER]
time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)
location: Full location description
weather: Weather description, Temperature
heart: integer_value
characters:
- name: CharacterName | outfit: Clothing description | state: Emotional/physical state | position: Where in the scene
[/TRACKER]

Heart Meter (current value: ${s.heartPoints}):
  Tracks the main character's romantic interest in {{user}}. Range: 0–69,999.
  Maximum shift per response: 10,000 points.
  🖤 0–4,999   💜 5,000–19,999   💙 20,000–29,999   💚 30,000–39,999
  💛 40,000–49,999   🧡 50,000–59,999   ❤️ 60,000+

Characters section:
  List every character currently present in the scene.
  Each line must use the pipe-separated format shown above.
  Include current outfit, emotional/physical state, and position in the scene.

Update only values that have changed from the previous block. Never omit the block.`;

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

        const aiMessages = ctx.chat
            .map((msg, idx) => ({ msg, idx }))
            .filter(({ msg }) => !msg.is_user);

        let done = 0;
        status.text(`0 / ${aiMessages.length} messages…`);

        for (const { msg, idx } of aiMessages) {
            // Already have stored tracker data — just re-render
            if (msg.extra?.tt_tracker) {
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            // Tags already embedded in text — parse them now
            const existing = parseTrackerBlock(msg.mes || '');
            if (existing) {
                msg.extra = msg.extra || {};
                msg.extra.tt_tracker = existing;
                renderMessageTracker(idx);
                done++;
                status.text(`${done} / ${aiMessages.length} messages…`);
                continue;
            }

            // Ask the AI to infer tracker values from chat context
            const start       = Math.max(0, idx - 6);
            const contextMsgs = ctx.chat.slice(start, idx + 1);
            const contextText = contextMsgs
                .map(m => `${m.is_user ? '{{user}}' : '{{char}}'}: ${m.mes}`)
                .join('\n\n');

            const genPrompt =
`[OOC: Based only on the conversation excerpt below, infer the tracker state at the moment of the last message. Output ONLY the tracker block — no other text.]

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
                    msg.extra = msg.extra || {};
                    msg.extra.tt_tracker = data;
                    renderMessageTracker(idx);
                    if (data.heart !== null) {
                        const pts = parseInt(data.heart, 10);
                        if (!isNaN(pts)) s.heartPoints = Math.max(0, pts);
                    }
                }
            } catch (err) {
                console.warn(`[TurboTracker] Could not generate tracker for message #${idx}:`, err);
            }

            done++;
            status.text(`${done} / ${aiMessages.length} messages…`);
        }

        await getContext().saveChat();
        saveSettingsDebounced();
        status.text('Done!');
        setTimeout(() => status.text(''), 3000);

    } finally {
        isPopulating = false;
        btn.prop('disabled', false);
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

function onChatChanged() {
    $('.tt-container').remove();
    injectPrompt();
}

function onMessageEdited(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    if (!msg || msg.is_user) return;
    processMessage(mesId);
}

function onMessageDeleted() {
    const ctx = getContext();
    if (!ctx.chat) return;
    ctx.chat.forEach((msg, idx) => {
        if (!msg.is_user && msg.extra?.tt_tracker) renderMessageTracker(idx);
    });
}

// ── Settings UI ───────────────────────────────────────────────

function loadSettingsUi() {
    const s = getSettings();

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

    $('#tt-populate-btn').on('click', populateAllMessages);
}

// ── Init ──────────────────────────────────────────────────────

jQuery(async () => {
    loadSettingsUi();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED,               onChatChanged);
    eventSource.on(event_types.MESSAGE_EDITED,             onMessageEdited);
    eventSource.on(event_types.MESSAGE_DELETED,            onMessageDeleted);

    // Event delegation for dynamically-created tracker buttons
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
