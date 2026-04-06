/**
 * Message Classification Module
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../logger");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

async function classifyMessage(channelId, messageText, lastPublished) {
    const lastPublishedSection = lastPublished
        ? `LAST PUBLISHED ALERT (active context):
- Source: ${lastPublished.source || "לא ידוע"}
- Target: ${lastPublished.target || "לא ידוע"}
- Estimated time: ${lastPublished.estimated_time || "לא ידוע"}
- Published: ${Math.round((Date.now() - lastPublished.publishedAt) / 60000)} minutes ago`
        : `LAST PUBLISHED ALERT: None yet.`;

    const prompt = `
You are an intelligence analyst monitoring missile/rocket threats to Israel.

${lastPublishedSection}

Analyze this Telegram message (in Hebrew) from channel "${channelId}":
"${messageText}"

Classify into exactly ONE category:

LAUNCH_REPORT — The message reports a missile/rocket launch that is CURRENTLY HAPPENING or IMMINENT (happening right now, sirens active now, missiles in the air now). The launch must be ongoing or just began.

UPDATE_TO_LAST — Provides NEW specific details (more precise target city, estimated arrival time) about the LAST PUBLISHED alert. Only valid if there IS a last published alert and the new detail is not already in it.

IRRELEVANT — Everything else, including:
  - Messages about events that ALREADY HAPPENED (past tense: "was launched", "hit", "fell", "exploded")
  - Damage reports, casualties, rescue operations
  - Interception reports ("intercepted", "iron dome activated")
  - Reports from hours or minutes ago that already occurred
  - Cluster munition behavior descriptions
  - UAV/drone reports (not missiles/rockets)
  - Advertisements, promotional posts
  - General news, politics
  - Calls to submit footage
  - "Seek shelter" without a current launch source
  - Repetition of already-published info

CRITICAL RULES:
- PAST TENSE = IRRELEVANT. If the event already occurred, it is NOT a LAUNCH_REPORT.
- "A missile hit..." = IRRELEVANT (past, already happened)
- "Sirens sounded in..." with past tense = IRRELEVANT
- "Launch detected from Iran" in present/real-time = LAUNCH_REPORT
- Drones/UAVs = IRRELEVANT always
- If unsure between LAUNCH_REPORT and IRRELEVANT, choose IRRELEVANT

For event_key: use English lowercase only. Format: "source->target_district"
- source examples: "iran", "lebanon", "yemen", "gaza"
- target_district examples: "merkaz", "tzafon", "darom", "yerushalayim", "yosh"
- If source unknown: "->tzafon"
- If target unknown: "iran->"
- If both unknown: "->"

For target field: MUST start with Hebrew district: ירושלים, צפון, יו״ש, מרכז, דרום
- Add specific cities in parentheses ONLY if explicitly mentioned
- Empty string if target not mentioned

Return ONLY raw JSON, no markdown:
{
  "category": "LAUNCH_REPORT" or "UPDATE_TO_LAST" or "IRRELEVANT",
  "reasoning": "One sentence in English",
  "event_key": "source->target or empty string if not LAUNCH_REPORT",
  "source": "Hebrew country name (e.g. איראן, לבנון), empty string if unknown",
  "target": "Hebrew district + optional cities, empty string if unknown",
  "estimated_time": "Estimated arrival time if explicitly mentioned, else empty string"
}
`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (err) {
        log("[AI] classifyMessage error: " + err.message);
    }
    return { category: "IRRELEVANT", event_key: "", source: "", target: "", estimated_time: "", reasoning: "Error" };
}

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

Do these messages contain genuinely NEW information vs what was already published?
NEW = one of:
1. A more specific or different target area not in the published alert
2. An estimated arrival time not previously published
3. Clear evidence this is a DIFFERENT launch event entirely (different source, or clearly separate incident)

NOT NEW:
- Repetition of same info
- Damage/aftermath/rescue reports
- Interception reports
- Same event rephrased differently

Return ONLY raw JSON, no markdown:
{
  "has_new_info": true or false,
  "reasoning": "One sentence in English",
  "source": "IN HEBREW — updated if changed, else same as published",
  "target": "IN HEBREW — updated if changed, else same as published",
  "estimated_time": "Updated if new, else same as published"
}
`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (err) {
        log("[AI] checkForNewInfo error: " + err.message);
    }
    return { has_new_info: false, reasoning: "Error during analysis" };
}

module.exports = { classifyMessage, checkForNewInfo };