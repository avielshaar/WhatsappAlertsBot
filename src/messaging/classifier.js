/**
 * Message Classification Module
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../logger");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

async function classifyMessage(channelId, messageText, lastPublished) {
    const now = new Date();
    // Generate current time string in Israel time zone
    const currentTimeStr = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

    const lastPublishedSection = lastPublished
        ? `LAST PUBLISHED ALERT (active context):
- Source: ${lastPublished.source || "Unknown"}
- Target: ${lastPublished.target || "Unknown"}
- Estimated time: ${lastPublished.estimated_time || "Unknown"}
- Published: ${Math.round((now.getTime() - lastPublished.publishedAt) / 60000)} minutes ago`
        : `LAST PUBLISHED ALERT: None yet.`;

    const prompt = `
You are an intelligence analyst monitoring missile/rocket threats to Israel.
Current Israel Time: ${currentTimeStr}

${lastPublishedSection}

Analyze this Telegram message (in Hebrew) from channel "${channelId}":
"${messageText}"

Classify into exactly ONE category:

LAUNCH_REPORT — The message reports a NEW missile/rocket launch that is CURRENTLY HAPPENING or IMMINENT. 

UPDATE_TO_LAST — Provides NEW specific details (more precise target city, estimated arrival time) about the LAST PUBLISHED alert OR an ongoing attack. If the source matches the LAST PUBLISHED alert and it's within the last 15 minutes, it is an UPDATE_TO_LAST.

IRRELEVANT — Everything else (past events, damage, interceptions, "seek shelter" without specifics, spam, links, drones).

CRITICAL RULES FOR TIME:
1. If the message mentions a relative time (e.g. "בעוד 5 דקות", "in 10 minutes", "5 minutes remaining"), you MUST add that to the Current Israel Time (${currentTimeStr}) and output ONLY the absolute time in HH:MM format (e.g. "15:46").
2. Never output words like "minutes" or "דקות" in the estimated_time field.

For target field: MUST start with Hebrew district: ירושלים, צפון, יו״ש, מרכז, דרום

Return ONLY raw JSON, no markdown:
{
  "category": "LAUNCH_REPORT" or "UPDATE_TO_LAST" or "IRRELEVANT",
  "reasoning": "One sentence in English",
  "event_key": "source->target or empty string if not LAUNCH_REPORT",
  "source": "Hebrew country name (e.g. איראן, לבנון), empty string if unknown",
  "target": "Hebrew district + optional cities, empty string if unknown",
  "estimated_time": "Absolute arrival time (HH:MM) if explicitly mentioned, else empty string"
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
- Source: ${lastPublished.source || "Unknown"}
- Target: ${lastPublished.target || "Unknown"}
- Estimated time: ${lastPublished.estimated_time || "Unknown"}
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