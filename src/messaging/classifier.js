/**
 * Message Classification Module
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../logger");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" }); // Note: Used standard flash model name

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
UPDATE_TO_LAST — Provides NEW specific details (more precise target city, estimated arrival time) about the LAST PUBLISHED alert.
IRRELEVANT — Everything else (past events, damage, interceptions, "seek shelter" without specifics, spam, links, drones).

CRITICAL RULES FOR TIME (estimated_time field):
1. If the message mentions a relative time (e.g., "בעוד 10 דקות", "עשר דקות", "in 5 minutes"), YOU MUST DO THE MATH. Add the minutes to the Current Israel Time (${currentTimeStr}).
2. Output ONLY the absolute arrival time in strictly HH:MM format (e.g., "16:41").
3. Do NOT output words like "דקות" or "minutes".

CRITICAL RULES FOR TARGET (target field):
1. Use ONLY base names without the prefix "ה" (e.g., write "מרכז", NOT "המרכז").
2. Separate multiple regions with a COMMA ONLY (e.g., "מרכז, דרום"). Do NOT use "ו" or "וגם".
3. Do NOT split sub-regions or cities that are in parentheses. Keep them together exactly as written (e.g., "מרכז (שפלה)").

Return ONLY raw JSON, no markdown:
{
  "category": "LAUNCH_REPORT" or "UPDATE_TO_LAST" or "IRRELEVANT",
  "reasoning": "One sentence in English",
  "event_key": "source->target or empty string if not LAUNCH_REPORT",
  "source": "Hebrew country name (e.g. איראן, לבנון), empty string if unknown",
  "target": "Comma-separated Hebrew districts/cities, empty string if unknown",
  "estimated_time": "Absolute arrival time (HH:MM) calculated from Current Time, else empty string"
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
You are an intelligence analyst. An alert was already published.

ALREADY PUBLISHED:
- Source: ${lastPublished.source || "Unknown"}
- Target: ${lastPublished.target || "Unknown"}
- Estimated time: ${lastPublished.estimated_time || "Unknown"}

NEW MESSAGES:
${contextText}

Do these messages contain genuinely NEW tactical information vs what was already published?
NEW = A more specific target area, or a new estimated arrival time.
NOT NEW = Repetition, damage reports, interception reports, or rephrasing the exact same regions.

CRITICAL: Separate target regions with a COMMA ONLY. No "ו" (and).

Return ONLY raw JSON, no markdown:
{
  "has_new_info": true or false,
  "reasoning": "One sentence in English",
  "source": "Hebrew — updated if changed",
  "target": "Hebrew — updated if changed",
  "estimated_time": "Updated if new in HH:MM format, else same as published"
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