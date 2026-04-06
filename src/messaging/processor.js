/**
 * Message Processing and Event Tracking Module
 */

const { log } = require("../logger");
const { classifyMessage, checkForNewInfo } = require("./classifier");
const { CONTEXT_WINDOW_MS, MIN_CHANNELS_TO_ACT } = require("../config");

const activeEvents = {};
let lastPublished = null;
const pendingAlerts = new Map(); // Manages debounce timers

function setLastPublished(source, target, estimated_time) {
    lastPublished = { source, target, estimated_time, publishedAt: Date.now() };
}
function getLastPublished() { return lastPublished; }
function getActiveEvents()  { return activeEvents; }

/**
 * Smart target merging — prevents duplications like "מרכז-דרום, ירושלים, מרכז (שפלה)"
 */
function mergeTargets(existing, incoming) {
    if (!existing) return incoming || "";
    if (!incoming) return existing || "";
    if (existing === incoming) return existing;

    // Helper function: replaces hyphens with commas, splits into an array of clean regions
    const normalize = (str) => {
        let s = str.replace(/-/g, ', '); 
        return s.split(',').map(x => x.trim()).filter(x => x);
    };

    const existingParts = normalize(existing);
    const incomingParts = normalize(incoming);

    const finalParts = [...existingParts];

    for (const inc of incomingParts) {
        let foundMatch = false;
        // Extract the base region word, e.g., "מרכז" out of "מרכז (שפלה)"
        const incBase = inc.split(' ')[0]; 

        for (let i = 0; i < finalParts.length; i++) {
            const ex = finalParts[i];
            const exBase = ex.split(' ')[0];

            if (incBase === exBase) {
                foundMatch = true;
                // If the new report is more detailed (e.g., contains a specific city in parentheses), overwrite the existing broader one
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

    return Array.from(new Set(finalParts)).join(', ');
}

/**
 * Pick the most complete event when multiple candidates exist
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

    // Merge if the top two have the same score
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
 * Process an incoming message
 */
async function processMessage(channelId, messageText, callbacks) {
    const now = Date.now();

    // ── Pre-filter spam to save API calls ──
    const spamKeywords = ["להצטרפות", "לחצו כאן", "t.me", "פרסום", "לערוץ"];
    if (spamKeywords.some(word => messageText.includes(word)) && messageText.length < 80) {
        log(`[Filter] ❌ Regex Spam Match — ignoring.`);
        return;
    }

    // ── Phase 1: Classification ──
    const classification = await classifyMessage(channelId, messageText, lastPublished);
    log(`[AI] Category: ${classification.category} | Reasoning: ${classification.reasoning}`);

    // ── Phase 2a: UPDATE_TO_LAST — One channel is enough ──
    if (classification.category === "UPDATE_TO_LAST" && lastPublished) {
        
        // Generate the new merged target
        const mergedTarget = mergeTargets(lastPublished.target, classification.target);
        
        // Smart check: Did the target actually change after merging?
        const hasNewTarget = mergedTarget !== lastPublished.target;
        const hasNewTime   = classification.estimated_time && classification.estimated_time !== lastPublished.estimated_time;

        // If no new target and no new time - do nothing
        if (!hasNewTarget && !hasNewTime) {
            log(`[Update] 🔁 UPDATE_TO_LAST but no actual new detail (already covered) — skipping.`);
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

    // ── Phase 2b: Must be a LAUNCH_REPORT ──
    if (classification.category !== "LAUNCH_REPORT") {
        log(`[Filter] ❌ IRRELEVANT — ignoring.`);
        return;
    }

    const eventKey = classification.event_key || "->";
    log(`[Filter] ✅ Launch report! Event: "${eventKey}" from channel ${channelId}`);

    // ── Phase 3: Parallel keys ──
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

    // ── Phase 4: Clean up expired events ──
    for (const key of Object.keys(activeEvents)) {
        if (now - activeEvents[key].firstSeen > CONTEXT_WINDOW_MS) {
            log(`[Events] 🗑️  Expired: "${key}"`);
            delete activeEvents[key];
        }
    }

    // ── Phase 5: Registration ──
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

        // Enrich data
        if (classification.source         && !event.source)         event.source         = classification.source;
        if (classification.target)                                  event.target         = mergeTargets(event.target, classification.target);
        if (classification.estimated_time && !event.estimated_time) event.estimated_time = classification.estimated_time;
    }

    // ── Phase 6: Threshold check ──
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

    // ── Phase 7: Select the best key ──
    const keyToPublish = readyForPublish.length === 1
        ? readyForPublish[0]
        : pickBestEvent(readyForPublish);

    // ── Phase 8: Debounce and aggregate before publishing ──
    if (pendingAlerts.has(keyToPublish)) {
        log(`[Events] ⏳ Already waiting to publish "${keyToPublish}", new data added silently.`);
        return;
    }

    log(`[Filter] ⏳ Threshold reached for "${keyToPublish}". Waiting 35s to aggregate more data before publishing...`);
    
    // Open a waiting window
    const timeoutId = setTimeout(async () => {
        const finalEvent = activeEvents[keyToPublish];
        
        // Abort if the event disappeared
        if (!finalEvent) {
             pendingAlerts.delete(keyToPublish);
             return;
        }

        // Dedup logic if something was published previously
        if (lastPublished) {
            const isSameSource = finalEvent.source && lastPublished.source && finalEvent.source.trim() === lastPublished.source.trim();
            const isSameTarget = finalEvent.target && lastPublished.target && finalEvent.target.trim() === lastPublished.target.trim();
            const isSameTime   = finalEvent.estimated_time && lastPublished.estimated_time && finalEvent.estimated_time.trim() === lastPublished.estimated_time.trim();

            if (isSameSource && isSameTarget && (isSameTime || (!finalEvent.estimated_time && !lastPublished.estimated_time))) {
                log(`[Dedup] 🔁 Exact duplicate found after delay — skipping.`);
                for (const key of eventKeysToTrack) delete activeEvents[key];
                pendingAlerts.delete(keyToPublish);
                return;
            }

            const newInfoCheck = await checkForNewInfo(finalEvent.messages, lastPublished);
            if (newInfoCheck.has_new_info) {
                // Double check against AI hallucinations
                const finalMergedTarget = mergeTargets(lastPublished.target, newInfoCheck.target);
                const isTargetNew = finalMergedTarget !== lastPublished.target;
                const isTimeNew = newInfoCheck.estimated_time && newInfoCheck.estimated_time !== lastPublished.estimated_time;
                const isSourceNew = newInfoCheck.source && newInfoCheck.source !== lastPublished.source;

                if (!isTargetNew && !isTimeNew && !isSourceNew) {
                     log(`[Dedup] 🔁 AI claimed new info, but target/time/source are identical to last published — skipping.`);
                     for (const key of eventKeysToTrack) delete activeEvents[key];
                     pendingAlerts.delete(keyToPublish);
                     return;
                }

                log(`[AI] 🚨 New info confirmed after delay: ${newInfoCheck.reasoning}`);
                await callbacks.alert(newInfoCheck.source || lastPublished.source, finalMergedTarget, newInfoCheck.estimated_time || lastPublished.estimated_time);
            } else {
                log(`[Dedup] 🔁 Skipped after delay — ${newInfoCheck.reasoning}`);
            }
        } else {
            // First publish ever
            log(`[AI] 🚨 First ever publish after delay — "${keyToPublish}"`);
            await callbacks.alert(finalEvent.source, finalEvent.target, finalEvent.estimated_time);
        }

        // Clean up the event and the timer after publishing
        for (const key of eventKeysToTrack) delete activeEvents[key];
        pendingAlerts.delete(keyToPublish);

    }, 35000); // Wait 35 seconds

    // Save the timer in the map
    pendingAlerts.set(keyToPublish, timeoutId);
}

module.exports = { processMessage, setLastPublished, getLastPublished, getActiveEvents };