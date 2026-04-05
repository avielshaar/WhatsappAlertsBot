/**
 * Message Classification Module
 * 
 * Uses Google Gemini AI to classify incoming Telegram messages as:
 * - LAUNCH_REPORT: A new missile/rocket launch event
 * - UPDATE_TO_LAST: New details about the previously published alert
 * - IRRELEVANT: Damage reports, past events, UAVs, noise
 * 
 * The classifier extracts structured data:
 * - event_key: Normalized key for tracking (e.g., "iran->merkaz")
 * - source: Origin country in Hebrew
 * - target: Target location in Hebrew
 * - estimated_time: Arrival time if mentioned
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../logger");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

/**
 * Classify a single message from a Telegram channel
 * @param {string} channelId - The Telegram channel ID this message came from
 * @param {string} messageText - The message text content in Hebrew
 * @param {object} lastPublished - The last alert we published (for UPDATE_TO_LAST detection)
 * @returns {Promise<object>} Classification result with category, event_key, source, target, estimated_time
 */
async function classifyMessage(channelId, messageText, lastPublished) {
    const lastPublishedSection = lastPublished
        ? `LAST PUBLISHED ALERT (still active context):
- Source: ${lastPublished.source || "לא ידוע"}
- Target: ${lastPublished.target || "לא ידוע"}  
- Estimated time: ${lastPublished.estimated_time || "לא ידוע"}
- Published: ${Math.round((Date.now() - lastPublished.publishedAt) / 60000)} minutes ago`
        : `LAST PUBLISHED ALERT: None yet.`;

    const prompt = `
You are an intelligence analyst monitoring missile/rocket threats to Israel.

${lastPublishedSection}

Now analyze this single Telegram message (in Hebrew) from channel "${channelId}":
"${messageText}"

Classify this message into one of these categories:
1. LAUNCH_REPORT — explicitly reports a NEW missile/rocket launch or firing toward Israel (imminent or currently happening)
2. UPDATE_TO_LAST — provides new specific details about the LAST PUBLISHED alert above (new target city, new estimated time). Only valid if there IS a last published alert.
3. IRRELEVANT — damage reports, aftermath, UAVs/drones only, politics, general news, advertisements, repetition of already-known info, OR reports about PAST launches that already happened

Rules:
- If the message only reports damage, casualties, or aftermath of a launch = IRRELEVANT
- If the message repeats info already in the last published alert = IRRELEVANT  
- If the message gives a more specific city/area or an estimated arrival time for the active event = UPDATE_TO_LAST
- If the message is in PAST TENSE (already happened, already fired, was launched) = IRRELEVANT (this is a past event, not current)
- If the message refers to something that occurred in the past (minutes/hours ago) = IRRELEVANT
- Drones/UAVs are NOT missiles — classify as IRRELEVANT

Return ONLY raw JSON, no markdown:
{
  "category": "LAUNCH_REPORT" or "UPDATE_TO_LAST" or "IRRELEVANT",
  "reasoning": "One sentence in English",
  "event_key": "Normalized key for LAUNCH_REPORT only, e.g. 'iran->merkaz' or 'lebanon->tzafon'. Use English lowercase. MUST BE EXPLICIT - if source/target NOT clearly stated, use empty parts. Empty string if not a launch.",
  "source": "Origin country IN HEBREW (e.g. איראן). ONLY if EXPLICITLY mentioned. Empty string if unclear or inferred. Use 'לא ידוע' only in output context display.",
  "target": "Target district IN HEBREW, must start with: ירושלים, צפון, יו״ש, מרכז, or דרום. Add specific cities in parentheses ONLY if explicitly mentioned. Empty string if unknown. NOTE: צפון alone does NOT mean לבנון - it means Israel's north.",
  "estimated_time": "Estimated arrival time if mentioned, else empty string"
}
`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        // Extract JSON object from AI response (handles markdown code blocks if present)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (err) {
        log("[AI] classifyMessage error: " + err.message);
    }
    // Default to IRRELEVANT if classification fails
    return { category: "IRRELEVANT", event_key: "" };
}

/**
 * Check if incoming messages contain genuinely new information
 * 
 * This is the second stage of deduplication. Even if multiple channels
 * report the same event, we only publish updates if there's NEW information
 * that differs from the last published alert.
 * 
 * @param {Array} newMessages - Array of {channel, text} objects to analyze
 * @param {object} lastPublished - The previous alert we sent
 * @returns {Promise<object>} Analysis result with has_new_info flag and updated fields
 */
async function checkForNewInfo(newMessages, lastPublished) {
    const contextText = newMessages.map(m => `- Channel ${m.channel}: ${m.text}`).join('\n');

    const prompt = `
You are an intelligence analyst. An alert was already published for a missile/rocket launch.

ALREADY PUBLISHED:
- Source: ${lastPublished.source || "לא ידוע"}
- Target: ${lastPublished.target || "לא ידוע"}
- Estimated time: ${lastPublished.estimated_time || "לא ידוע"}
- Published: ${Math.round((Date.now() - lastPublished.publishedAt) / 60000)} minutes ago

NEW MESSAGES (confirmed by multiple channels):
${contextText}

Do these messages contain genuinely NEW information that is different from what was already published?
NEW = one of:
1. A more specific or different target area not in the published alert
2. An estimated arrival time not previously published
3. Clear evidence this is a DIFFERENT launch event entirely

NOT NEW = repetition, damage reports, aftermath, or same info rephrased

Return ONLY raw JSON, no markdown:
{
  "has_new_info": true or false,
  "reasoning": "One sentence in English",
  "source": "IN HEBREW — updated if changed, else same as published",
  "target": "IN HEBREW — updated if changed, else same as published",
  "estimated_time": "Updated if new info, else same as published"
}
`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        // Extract JSON object from AI response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (err) {
        log("[AI] checkForNewInfo error: " + err.message);
    }
    // Default to no new info if analysis fails
    return { has_new_info: false, reasoning: "Error during analysis" };
}

module.exports = { classifyMessage, checkForNewInfo };
