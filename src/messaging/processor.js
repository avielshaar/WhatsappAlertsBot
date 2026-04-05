/**
 * Message Processing and Event Tracking Module
 * 
 * Core responsibilities:
 * 1. Classify incoming messages (first dedup stage)
 * 2. Track events across multiple channels (correlation)
 * 3. Monitor for MIN_CHANNELS_TO_ACT threshold
 * 4. Check for new info vs last published (second dedup stage)
 * 5. Clean up expired events after CONTEXT_WINDOW_MS
 * 
 * Key feature: Dual event tracking
 * When a report includes both source and target (e.g., "iran->צפון"),
 * we also track generic variants ("iran->", "->צפון") so that reports
 * with partial information can corroborate.
 */

const { log } = require("../logger");
const { classifyMessage, checkForNewInfo } = require("./classifier");
const { CONTEXT_WINDOW_MS, MIN_CHANNELS_TO_ACT } = require("../config");

/**
 * Select the best event when multiple events reach the confirmation threshold
 * 
 * Scoring criteria (in order of priority):
 * 1. Information completeness: events with source, target, AND estimated_time score highest
 * 2. Channel confirmations: more channels = higher score
 * 3. Age: newer events slightly preferred after tiebreaker
 * 
 * If two events have identical scores and are complementary,
 * we merge them to fill in missing details.
 * 
 * @param {Array} candidates - Array of event keys ready for publishing
 * @returns {string} The key of the selected best event
 */
function pickBestEvent(candidates) {
    // Score each candidate based on information completeness and confirmations
    const scoredCandidates = candidates.map(key => {
        const event = activeEvents[key];
        const score = {
            key,
            channelCount: event.channels.size,
            hasSource: (event.source && event.source.trim() !== '') ? 1 : 0,
            hasTarget: (event.target && event.target.trim() !== '') ? 1 : 0,
            hasTime: (event.estimated_time && event.estimated_time.trim() !== '') ? 1 : 0,
            totalInfo: 0,
        };
        
        // Total info score (0-3)
        score.totalInfo = score.hasSource + score.hasTarget + score.hasTime;
        
        // Overall score: prioritize info completeness, then channel count, then age
        score.priority = (score.totalInfo * 1000) + (score.channelCount * 100) + (Date.now() - event.firstSeen);
        
        return score;
    });
    
    // Sort by priority (higher = better)
    scoredCandidates.sort((a, b) => b.priority - a.priority);
    
    const best = scoredCandidates[0];
    log(`[Events] 🏆 Selected event "${best.key}" (info: ${best.totalInfo}, channels: ${best.channelCount})`);
    
    // If top candidates are very close in score, try to merge them
    if (scoredCandidates.length > 1 && 
        scoredCandidates[0].totalInfo === scoredCandidates[1].totalInfo &&
        scoredCandidates[0].totalInfo < 3) {
        
        log(`[Events] 🔀 Merging complementary events...`);
        const candidate1 = activeEvents[scoredCandidates[0].key];
        const candidate2 = activeEvents[scoredCandidates[1].key];
        
        // Merge: fill missing info from candidate2
        if (!candidate1.source && candidate2.source) {
            candidate1.source = candidate2.source;
            log(`[Events] → Added source from secondary: ${candidate2.source}`);
        }
        if (!candidate1.target && candidate2.target) {
            candidate1.target = candidate2.target;
            log(`[Events] → Added target from secondary: ${candidate2.target}`);
        }
        if (!candidate1.estimated_time && candidate2.estimated_time) {
            candidate1.estimated_time = candidate2.estimated_time;
            log(`[Events] → Added time from secondary: ${candidate2.estimated_time}`);
        }
    }
    
    return best.key;
}

/**
 * Application State
 * 
 * activeEvents: Object keyed by event_key (e.g., "iran->צפון")
 *   Tracks all ongoing events within the CONTEXT_WINDOW_MS
 *   Each event includes channels reporting it, messages, and extracted details
 * 
 * lastPublished: The most recent alert sent to WhatsApp
 *   Used for deduplication and UPDATE_TO_LAST detection
 */
const activeEvents = {};
let lastPublished = null;

/**
 * Record a published alert for deduplication and update detection
 * @param {string} source - Origin of the launch (Hebrew)
 * @param {string} target - Target location (Hebrew)
 * @param {string} estimated_time - Arrival time if known
 */
function setLastPublished(source, target, estimated_time) {
    lastPublished = { source, target, estimated_time, publishedAt: Date.now() };
}

/**
 * Get the previously published alert (for comparison)
 * @returns {object|null} The last alert we sent, or null if never published
 */
function getLastPublished() {
    return lastPublished;
}

/**
 * Get all currently tracked events (debugging utility)
 * @returns {object} The activeEvents object
 */
function getActiveEvents() {
    return activeEvents;
}

/**
 * Main message processing pipeline
 * 
 * This is the core logic that:
 * 1. Classifies the message
 * 2. Routes it to UPDATE_TO_LAST or LAUNCH_REPORT paths
 * 3. Tracks it across multiple channels
 * 4. Checks against MIN_CHANNELS_TO_ACT threshold
 * 5. Performs deduplication
 * 6. Publishes verified alerts
 * 
 * @param {string} channelId - Telegram channel ID source
 * @param {string} messageText - Message content in Hebrew
 * @param {Function} onPublish - Callback(source, target, estimated_time) when alert ready
 */
async function processMessage(channelId, messageText, onPublish) {
    const now = Date.now();

    // STAGE 1: Classify the incoming message
    const classification = await classifyMessage(channelId, messageText, lastPublished);
    log(`[AI] Category: ${classification.category} | Reasoning: ${classification.reasoning}`);

    /**
     * STAGE 2A: UPDATE_TO_LAST Path
     * 
     * If a single channel reports new details about the active event,
     * we don't need MIN_CHANNELS_TO_ACT confirmation. Update immediately.
     * Examples: More specific target city, refined estimated arrival time
     */
    if (classification.category === "UPDATE_TO_LAST" && lastPublished) {
        const hasNewTarget = classification.target && classification.target !== lastPublished.target;
        const hasNewTime   = classification.estimated_time && classification.estimated_time !== lastPublished.estimated_time;

        if (hasNewTarget || hasNewTime) {
            log(`[Update] 📝 Single-channel update accepted — new detail received.`);
            const newSource = classification.source || lastPublished.source;
            const newTarget = hasNewTarget ? classification.target : lastPublished.target;
            const newTime   = hasNewTime ? classification.estimated_time : lastPublished.estimated_time;
            onPublish(newSource, newTarget, newTime);
        } else {
            log(`[Update] 🔁 UPDATE_TO_LAST but no actual new detail — skipping.`);
        }
        return;
    }

    /**
     * STAGE 2B: NEW LAUNCH Path (requires MIN_CHANNELS_TO_ACT confirmation)
     * 
     * If not UPDATE_TO_LAST and not LAUNCH_REPORT, discard as IRRELEVANT
     */
    if (classification.category !== "LAUNCH_REPORT") {
        log(`[Filter] ❌ IRRELEVANT — ignoring.`);
        return;
    }

    const eventKey = classification.event_key || "->";
    log(`[Filter] ✅ Launch report! Event: "${eventKey}" from channel ${channelId}`);

    /**
     * STAGE 3: Dual Event Tracking
     * 
     * When a report specifies both source AND target (e.g., "iran->צפון"),
     * we create tracking keys for all combinations so partial reports can correlate:
     * - "iran->צפון" (specific)
     * - "iran->" (source-only)
     * - "->צפון" (target-only)
     * 
     * This allows the system to match reports like:
     * - Channel 1: "Launch from Iran toward Northern Israel"
     * - Channel 2: "Incoming missiles - Northern Israel area"
     * Even though one omits the source and one omits having "Iran"
     */
    const [sourceFromKey, targetFromKey] = eventKey.split("->");

    const hasSpecificSource = sourceFromKey && sourceFromKey.trim() !== "";
    const hasSpecificTarget = targetFromKey && targetFromKey.trim() !== "";

    const eventKeysToTrack = [eventKey];

    if (hasSpecificSource && hasSpecificTarget) {
        // Both specified: track specific + both generic variants
        eventKeysToTrack.push(`${sourceFromKey}->`);
        eventKeysToTrack.push(`->${targetFromKey}`);
    } else if (hasSpecificSource && !hasSpecificTarget) {
        // Only source: track source only + generic
        eventKeysToTrack.push(`->`);
    } else if (!hasSpecificSource && hasSpecificTarget) {
        // Only target: track target only + generic
        eventKeysToTrack.push(`->`);
    }

    /**
     * STAGE 4: Housekeeping - Remove expired events
     * Events older than CONTEXT_WINDOW_MS are assumed complete or irrelevant
     */
    for (const key of Object.keys(activeEvents)) {
        if (now - activeEvents[key].firstSeen > CONTEXT_WINDOW_MS) {
            log(`[Events] 🗑️  Expired: "${key}"`);
            delete activeEvents[key];
        }
    }

    /**
     * STAGE 5: Track this message under all relevant event keys
     */
    for (const currentKey of eventKeysToTrack) {
        if (!activeEvents[currentKey]) {
            // First report for this event key - initialize
            const [src, tgt] = currentKey.includes("->")
                ? currentKey.split("->")
                : [currentKey, ""];

            activeEvents[currentKey] = {
                channels:       new Set(),    // Unique channels reporting this event
                messages:       [],           // All message texts received
                source:         src || classification.source || "",
                target:         tgt || classification.target || "",
                estimated_time: classification.estimated_time,
                firstSeen:      now,
            };
        }

        // Add this channel's report to the event
        const event = activeEvents[currentKey];
        event.channels.add(channelId);
        event.messages.push({ channel: channelId, text: messageText, time: now });
    }

    /**
     * STAGE 6: Check confirmation threshold
     * 
     * For each event key we're tracking, check if it has reached
     * MIN_CHANNELS_TO_ACT confirmation from different sources
     */
    const readyForPublish = [];
    for (const checkKey of eventKeysToTrack) {
        const event = activeEvents[checkKey];
        log(`[Events] 📊 "${checkKey}": ${event.channels.size}/${MIN_CHANNELS_TO_ACT} channels confirmed.`);

        if (event.channels.size >= MIN_CHANNELS_TO_ACT) {
            readyForPublish.push(checkKey);
        }
    }

    if (readyForPublish.length === 0) {
        log(`[Filter] ⏸  Waiting for corroboration...`);
        return;
    }

    /**
     * STAGE 7: Select best event if multiple are ready
     * 
     * If multiple event keys hit the threshold simultaneously,
     * pickBestEvent chooses the one with most complete information
     */
    const keyToPublish = readyForPublish.length === 1 ? readyForPublish[0] : pickBestEvent(readyForPublish);

    const event = activeEvents[keyToPublish];

    /**
     * STAGE 8: First-time publish check
     * 
     * If this is our first ever alert, publish immediately
     */
    if (!lastPublished) {
        log(`[AI] 🚨 First ever publish — event "${keyToPublish}"`);
        onPublish(event.source, event.target, event.estimated_time);
        for (const key of eventKeysToTrack) {
            delete activeEvents[key];
        }
        for (const key of eventKeysToTrack) {
            delete activeEvents[key];
        }
        return;
    }

    /**
     * STAGE 9: Quick deduplication check
     * 
     * First dedup pass: Exact string match with lastPublished
     * If source, target, and time all match, it's definitely a duplicate
     */
    const isSameSource = event.source && lastPublished.source && 
                        event.source.toLowerCase().trim() === lastPublished.source.toLowerCase().trim();
    const isSameTarget = event.target && lastPublished.target && 
                        event.target.toLowerCase().trim() === lastPublished.target.toLowerCase().trim();
    const isSameTime = event.estimated_time && lastPublished.estimated_time &&
                      event.estimated_time.toLowerCase().trim() === lastPublished.estimated_time.toLowerCase().trim();

    if (isSameSource && isSameTarget && (isSameTime || (!event.estimated_time && !lastPublished.estimated_time))) {
        log(`[Dedup] 🔁 Exact duplicate — skipping.`);
        for (const key of eventKeysToTrack) {
            delete activeEvents[key];
        }
        return;
    }

    /**
     * STAGE 10: Advanced deduplication - AI check for new info
     * 
     * Second dedup pass: Use AI to determine if this is genuinely new information
     * or just the same event reported again by different channels
     */
    const newInfoCheck = await checkForNewInfo(event.messages, lastPublished);

    if (newInfoCheck.has_new_info) {
        log(`[AI] 🚨 New info confirmed: ${newInfoCheck.reasoning}`);
        // Use AI-analyzed fields which may have merged/refined info from multiple messages
        onPublish(newInfoCheck.source, newInfoCheck.target, newInfoCheck.estimated_time);
        for (const key of eventKeysToTrack) {
            delete activeEvents[key];
        }
    } else {
        log(`[Dedup] 🔁 Skipped — ${newInfoCheck.reasoning}`);
    }
}

module.exports = {
    processMessage,
    setLastPublished,
    getLastPublished,
    getActiveEvents,
};
