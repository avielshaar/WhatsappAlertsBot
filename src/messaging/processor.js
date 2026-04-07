/**
 * Message Processing and Event Tracking Module
 */

const { log } = require("../logger");
const { classifyMessage, checkForNewInfo } = require("./classifier");
const { CONTEXT_WINDOW_MS, MIN_CHANNELS_TO_ACT } = require("../config");

const activeEvents = {};
let lastPublished = null;

function setLastPublished(source, target, estimated_time) {
    // FIX: Ensure resetting the state actually nullifies the object
    if (!source && !target && !estimated_time) {
        lastPublished = null;
        return;
    }
    lastPublished = { source, target, estimated_time, publishedAt: Date.now() };
}

function getLastPublished() { return lastPublished; }
function getActiveEvents()  { return activeEvents; }

function mergeTargets(existing, incoming) {
    if (!existing) return incoming || "";
    if (!incoming) return existing || "";

    const normalize = (str) => {
        let s = str.replace(/-/g, ', ').replace(/ ו/g, ', ').replace(/וגם /g, ', '); 
        return s.split(',').map(x => {
            let cleaned = x.trim();
            cleaned = cleaned.replace(/^ה(מרכז|דרום|צפון|שרון|שפלה|נגב)/, '$1');
            cleaned = cleaned.replace(/^אזור /, ''); // Strip "אזור" filler word
            return cleaned;
        }).filter(x => x && x !== 'ו');
    };

    const existingParts = normalize(existing);
    const incomingParts = normalize(incoming);
    const finalParts = [...existingParts];

    for (const inc of incomingParts) {
        let foundMatch = false;
        const incBase = inc.split(' ')[0]; 

        for (let i = 0; i < finalParts.length; i++) {
            const ex = finalParts[i];
            const exBase = ex.split(' ')[0];

            if (incBase === exBase) {
                foundMatch = true;
                if (inc.length > ex.length) {
                    finalParts[i] = inc; 
                }
                break;
            }
        }

        if (!foundMatch) {
            finalParts.push(inc);
        }
    }

    return Array.from(new Set(finalParts)).sort().join(', '); 
}

function sanitizeTime(aiTimeString) {
    if (!aiTimeString) return "";
    if (aiTimeString.includes("דקות") || aiTimeString.includes("minutes")) {
        const numbers = aiTimeString.match(/\d+/);
        if (numbers) {
            const addedTime = new Date(Date.now() + parseInt(numbers[0]) * 60000);
            return addedTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
        }
        return "";
    }
    return aiTimeString.trim();
}

function pickBestEvent(candidates) {
    const scored = candidates.map(key => {
        const e = activeEvents[key];
        const totalInfo = (e.source ? 1 : 0) + (e.target ? 1 : 0) + (e.estimated_time ? 1 : 0);
        return { key, totalInfo, channelCount: e.channels.size };
    });

    scored.sort((a, b) => b.totalInfo - a.totalInfo || b.channelCount - a.channelCount);
    const best = scored[0];
    
    if (scored.length > 1 && scored[0].totalInfo === scored[1].totalInfo) {
        const e1 = activeEvents[scored[0].key];
        const e2 = activeEvents[scored[1].key];
        if (!e1.source         && e2.source)         { e1.source         = e2.source; }
        if (!e1.target         && e2.target)         { e1.target         = e2.target; }
        if (!e1.estimated_time && e2.estimated_time) { e1.estimated_time = e2.estimated_time; }
    }

    return best.key;
}

async function processMessage(channelId, messageText, callbacks) {
    const now = Date.now();

    const spamKeywords = ["פרסום"];
    if (spamKeywords.some(word => messageText.includes(word)) && messageText.length < 80) {
        log(`[Filter] ❌ Regex Spam Match — ignoring.`);
        return;
    }

    const classification = await classifyMessage(channelId, messageText, lastPublished);
    classification.estimated_time = sanitizeTime(classification.estimated_time); 
    log(`[AI] Category: ${classification.category} | Reasoning: ${classification.reasoning}`);

    if (classification.category === "UPDATE_TO_LAST" && lastPublished) {
        const mergedTarget = mergeTargets(lastPublished.target, classification.target);
        const normalizedLastTarget = mergeTargets(lastPublished.target, ""); 
        
        const hasNewTarget = mergedTarget !== normalizedLastTarget;
        const hasNewTime   = classification.estimated_time && classification.estimated_time !== lastPublished.estimated_time;

        if (!hasNewTarget && !hasNewTime) {
            log(`[Update] 🔁 UPDATE_TO_LAST but no actual new detail — skipping.`);
            return;
        }

        log(`[Update] 📝 Single-channel update — publishing.`);
        const updateType = hasNewTarget && hasNewTime ? "target+time"
                         : hasNewTarget               ? "target"
                         :                              "time";

        await callbacks.update(
            { source: lastPublished.source, target: mergedTarget, estimated_time: classification.estimated_time || lastPublished.estimated_time },
            lastPublished,
            updateType,
        );
        return;
    }

    if (classification.category !== "LAUNCH_REPORT") {
        log(`[Filter] ❌ IRRELEVANT — ignoring.`);
        return;
    }

    const eventKey = classification.event_key || "->";
    log(`[Filter] ✅ Launch report! Event: "${eventKey}" from channel ${channelId}`);

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

    for (const key of Object.keys(activeEvents)) {
        if (now - activeEvents[key].firstSeen > CONTEXT_WINDOW_MS) {
            log(`[Events] 🗑️  Expired: "${key}"`);
            delete activeEvents[key];
        }
    }

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

        if (classification.source         && !event.source)         event.source         = classification.source;
        if (classification.target)                                  event.target         = mergeTargets(event.target, classification.target);
        if (classification.estimated_time && !event.estimated_time) event.estimated_time = classification.estimated_time;
    }

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

    const keyToPublish = readyForPublish.length === 1 ? readyForPublish[0] : pickBestEvent(readyForPublish);
    const finalEvent = activeEvents[keyToPublish];

    if (!lastPublished) {
        log(`[AI] 🚨 First ever publish — "${keyToPublish}"`);
        await callbacks.alert(finalEvent.source, finalEvent.target, finalEvent.estimated_time);
        for (const key of eventKeysToTrack) delete activeEvents[key];
        return;
    }

    const normalizedFinalTarget = mergeTargets(finalEvent.target, "");
    const normalizedLastTarget = mergeTargets(lastPublished.target, "");

    const isSameSource = finalEvent.source && lastPublished.source && finalEvent.source.trim() === lastPublished.source.trim();
    const isSameTarget = normalizedFinalTarget === normalizedLastTarget;
    const isSameTime   = finalEvent.estimated_time && lastPublished.estimated_time && finalEvent.estimated_time.trim() === lastPublished.estimated_time.trim();

    if (isSameSource && isSameTarget && (isSameTime || (!finalEvent.estimated_time && !lastPublished.estimated_time))) {
        log(`[Dedup] 🔁 Exact duplicate — skipping.`);
        for (const key of eventKeysToTrack) delete activeEvents[key];
        return;
    }

    const newInfoCheck = await checkForNewInfo(finalEvent.messages, lastPublished);
    newInfoCheck.estimated_time = sanitizeTime(newInfoCheck.estimated_time); 
    
    if (newInfoCheck.has_new_info) {
        const finalMergedTarget = mergeTargets(lastPublished.target, newInfoCheck.target);
        const isTargetNew = finalMergedTarget !== normalizedLastTarget;
        const isTimeNew = newInfoCheck.estimated_time && newInfoCheck.estimated_time !== lastPublished.estimated_time;
        const isSourceNew = newInfoCheck.source && newInfoCheck.source !== lastPublished.source;

        if (!isTargetNew && !isTimeNew && !isSourceNew) {
             log(`[Dedup] 🔁 AI claimed new info, but programmatically nothing changed — skipping.`);
             for (const key of eventKeysToTrack) delete activeEvents[key];
             return;
        }

        log(`[AI] 🚨 New info confirmed: ${newInfoCheck.reasoning}`);
        await callbacks.alert(newInfoCheck.source || lastPublished.source, finalMergedTarget, newInfoCheck.estimated_time || lastPublished.estimated_time);
    } else {
        log(`[Dedup] 🔁 Skipped — ${newInfoCheck.reasoning}`);
    }
    
    for (const key of eventKeysToTrack) delete activeEvents[key];
}

module.exports = { processMessage, setLastPublished, getLastPublished, getActiveEvents };