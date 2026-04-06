/**
 * Message Processing and Event Tracking Module
 */

const { log } = require("../logger");
const { classifyMessage, checkForNewInfo } = require("./classifier");
const { CONTEXT_WINDOW_MS, MIN_CHANNELS_TO_ACT } = require("../config");

const activeEvents = {};
let lastPublished = null;

function setLastPublished(source, target, estimated_time) {
    lastPublished = { source, target, estimated_time, publishedAt: Date.now() };
}
function getLastPublished() { return lastPublished; }
function getActiveEvents()  { return activeEvents; }

/**
 * איחוד יעדים — מחבר "צפון" + "מרכז (תל אביב)" → "צפון, מרכז (תל אביב)"
 * לא מוחק אזורים קיימים, רק מוסיף חדשים
 */
function mergeTargets(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    if (existing.trim() === incoming.trim()) return existing;

    // חלץ מחוזות קיימים
    const DISTRICTS = ["ירושלים", "צפון", "יו״ש", "מרכז", "דרום"];
    const existingDistricts = DISTRICTS.filter(d => existing.includes(d));
    const incomingDistricts = DISTRICTS.filter(d => incoming.includes(d));

    // מחוזות שבincoming ואינם בexisting
    const newDistricts = incomingDistricts.filter(d => !existingDistricts.includes(d));

    if (newDistricts.length === 0) {
        // אין מחוז חדש — אולי רק ערים ספציפיות יותר, נשאר עם הנוכחי
        return existing;
    }

    // הוספת החלק החדש
    return `${existing}, ${incoming}`;
}

/**
 * בחירת האירוע הכי מלא כשיש כמה מועמדים
 */
function pickBestEvent(candidates) {
    const scored = candidates.map(key => {
        const e = activeEvents[key];
        const totalInfo =
            (e.source         ? 1 : 0) +
            (e.target         ? 1 : 0) +
            (e.estimated_time ? 1 : 0);
        return { key, totalInfo, channelCount: e.channels.size };
    });

    scored.sort((a, b) => b.totalInfo - a.totalInfo || b.channelCount - a.channelCount);

    const best = scored[0];
    log(`[Events] 🏆 Selected "${best.key}" (info: ${best.totalInfo}, channels: ${best.channelCount})`);

    // מיזוג אם שניים עם אותו ציון
    if (scored.length > 1 && scored[0].totalInfo === scored[1].totalInfo) {
        const e1 = activeEvents[scored[0].key];
        const e2 = activeEvents[scored[1].key];
        if (!e1.source         && e2.source)         { e1.source         = e2.source; }
        if (!e1.target         && e2.target)         { e1.target         = e2.target; }
        if (!e1.estimated_time && e2.estimated_time) { e1.estimated_time = e2.estimated_time; }
    }

    return best.key;
}

/**
 * עיבוד הודעה נכנסת
 */
async function processMessage(channelId, messageText, callbacks) {
    const now = Date.now();

    // ── שלב 1: סיווג ──
    const classification = await classifyMessage(channelId, messageText, lastPublished);
    log(`[AI] Category: ${classification.category} | Reasoning: ${classification.reasoning}`);

    // ── שלב 2א: UPDATE_TO_LAST — ערוץ אחד מספיק ──
    if (classification.category === "UPDATE_TO_LAST" && lastPublished) {
        const hasNewTarget = classification.target && classification.target !== lastPublished.target;
        const hasNewTime   = classification.estimated_time &&
                             classification.estimated_time !== lastPublished.estimated_time;

        if (!hasNewTarget && !hasNewTime) {
            log(`[Update] 🔁 UPDATE_TO_LAST but no actual new detail — skipping.`);
            return;
        }

        log(`[Update] 📝 Single-channel update — publishing.`);

        // איחוד יעדים — לא מוחקים אזורים קודמים
        const mergedTarget = hasNewTarget
            ? mergeTargets(lastPublished.target, classification.target)
            : lastPublished.target;

        const newTime = hasNewTime ? classification.estimated_time : lastPublished.estimated_time;

        // קביעת סוג העדכון לכותרת
        const updateType = hasNewTarget && hasNewTime ? "target+time"
                         : hasNewTarget               ? "target"
                         :                              "time";

        await callbacks.update(
            { source: lastPublished.source, target: mergedTarget, estimated_time: newTime },
            lastPublished,
            updateType,
        );
        return;
    }

    // ── שלב 2ב: חייב LAUNCH_REPORT ──
    if (classification.category !== "LAUNCH_REPORT") {
        log(`[Filter] ❌ IRRELEVANT — ignoring.`);
        return;
    }

    const eventKey = classification.event_key || "->";
    log(`[Filter] ✅ Launch report! Event: "${eventKey}" from channel ${channelId}`);

    // ── שלב 3: מפתחות מקבילים ──
    const [srcPart, tgtPart] = eventKey.split("->");
    const hasSource = srcPart && srcPart.trim() !== "";
    const hasTarget = tgtPart && tgtPart.trim() !== "";

    const eventKeysToTrack = [eventKey];
    if (hasSource && hasTarget) {
        eventKeysToTrack.push(`${srcPart}->`);
        eventKeysToTrack.push(`->${tgtPart}`);
    } else if (hasSource || hasTarget) {
        eventKeysToTrack.push(`->`);
    }

    // ── שלב 4: ניקוי ישנים ──
    for (const key of Object.keys(activeEvents)) {
        if (now - activeEvents[key].firstSeen > CONTEXT_WINDOW_MS) {
            log(`[Events] 🗑️  Expired: "${key}"`);
            delete activeEvents[key];
        }
    }

    // ── שלב 5: רישום — תמיד מה-AI, לא מחלקי המפתח ──
    for (const currentKey of eventKeysToTrack) {
        if (!activeEvents[currentKey]) {
            activeEvents[currentKey] = {
                channels:       new Set(),
                messages:       [],
                source:         classification.source         || "",
                target:         classification.target         || "",
                estimated_time: classification.estimated_time || "",
                firstSeen:      now,
            };
        }

        const event = activeEvents[currentKey];
        event.channels.add(channelId);
        event.messages.push({ channel: channelId, text: messageText, time: now });

        // העשרה
        if (classification.source         && !event.source)         event.source         = classification.source;
        if (classification.target         && !event.target)         event.target         = classification.target;
        if (classification.estimated_time && !event.estimated_time) event.estimated_time = classification.estimated_time;
    }

    // ── שלב 6: סף ──
    const readyForPublish = [];
    for (const checkKey of eventKeysToTrack) {
        const event = activeEvents[checkKey];
        log(`[Events] 📊 "${checkKey}": ${event.channels.size}/${MIN_CHANNELS_TO_ACT} channels confirmed.`);
        if (event.channels.size >= MIN_CHANNELS_TO_ACT) readyForPublish.push(checkKey);
    }

    if (readyForPublish.length === 0) {
        log(`[Filter] ⏸  Waiting for corroboration...`);
        return;
    }

    // ── שלב 7: בחירת הטוב ביותר ──
    const keyToPublish = readyForPublish.length === 1
        ? readyForPublish[0]
        : pickBestEvent(readyForPublish);

    const event = activeEvents[keyToPublish];

    // ── שלב 8: פרסום ראשון ──
    if (!lastPublished) {
        log(`[AI] 🚨 First ever publish — "${keyToPublish}"`);
        await callbacks.alert(event.source, event.target, event.estimated_time);
        for (const key of eventKeysToTrack) delete activeEvents[key];
        return;
    }

    // ── שלב 9: dedup מהיר ──
    const isSameSource = event.source && lastPublished.source &&
        event.source.trim() === lastPublished.source.trim();
    const isSameTarget = event.target && lastPublished.target &&
        event.target.trim() === lastPublished.target.trim();
    const isSameTime   = event.estimated_time && lastPublished.estimated_time &&
        event.estimated_time.trim() === lastPublished.estimated_time.trim();

    if (isSameSource && isSameTarget && (isSameTime || (!event.estimated_time && !lastPublished.estimated_time))) {
        log(`[Dedup] 🔁 Exact duplicate — skipping.`);
        for (const key of eventKeysToTrack) delete activeEvents[key];
        return;
    }

    // ── שלב 10: dedup AI ──
    const newInfoCheck = await checkForNewInfo(event.messages, lastPublished);

    if (newInfoCheck.has_new_info) {
        log(`[AI] 🚨 New info confirmed: ${newInfoCheck.reasoning}`);
        await callbacks.alert(newInfoCheck.source, newInfoCheck.target, newInfoCheck.estimated_time);
        for (const key of eventKeysToTrack) delete activeEvents[key];
    } else {
        log(`[Dedup] 🔁 Skipped — ${newInfoCheck.reasoning}`);
    }
}

module.exports = { processMessage, setLastPublished, getLastPublished, getActiveEvents };