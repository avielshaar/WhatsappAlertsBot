/**
 * Message Classification Module
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../logger");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Primary fast model (High daily quota - 500)
const primaryModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

// High-tier stable fallback model (Low daily quota - 20)
const fallbackModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

/**
 * Helper function to call AI with automatic fallback on 503 errors
 */
async function generateWithFallback(prompt) {
    try {
        const result = await primaryModel.generateContent(prompt);
        return result.response.text();
    } catch (err) {
        if (err.message.includes("503") || err.message.includes("high demand") || err.message.includes("Unavailable")) {
            log(`[AI] ⚠️ Primary model 503 overload. Instantly falling back to gemini-3-flash...`);
            const fallbackResult = await fallbackModel.generateContent(prompt);
            return fallbackResult.response.text();
        }
        throw err;
    }
}

async function classifyMessage(channelId, messageText, lastPublished) {
    const now = new Date();
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
1. If a relative time is explicitly mentioned (e.g., "בעוד 10 דקות", "in 5 minutes"), YOU MUST DO THE MATH. Add the minutes to the Current Israel Time (${currentTimeStr}) and output the absolute HH:MM.
2. IF NO EXPLICIT ARRIVAL TIME IS MENTIONED, YOU MUST RETURN AN EMPTY STRING "".
3. DO NOT output the "Current Israel Time" as the estimated time unless you mathematically calculated an addition to it.
4. Output ONLY absolute arrival time in HH:MM format. No words like "minutes".

CRITICAL RULES FOR TARGET (target field):
1. Use EXACT base names only: ירושלים, צפון, יו״ש, מרכז, דרום.
2. DO NOT add filler words like "אזור", "ה", or "לעבר" (e.g., write "מרכז", NOT "אזור המרכז").
3. Separate multiple regions with a COMMA ONLY. Do NOT use "ו" or "וגם".
4. Do NOT split sub-regions in parentheses. Keep them exactly as written (e.g., "מרכז (שפלה)").

Return ONLY raw JSON, no markdown:
{
  "category": "LAUNCH_REPORT" or "UPDATE_TO_LAST" or "IRRELEVANT",
  "reasoning": "One sentence in English",
  "event_key": "source->target or empty string if not LAUNCH_REPORT",
  "source": "Hebrew country name (e.g. איראן, לבנון), empty string if unknown",
  "target": "Comma-separated exact Hebrew regions, empty string if unknown",
  "estimated_time": "Absolute arrival time (HH:MM) calculated from Current Time, else empty string"
}
`;

    try {
        const text = await generateWithFallback(prompt);
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

CRITICAL RULES FOR TARGET UPDATES:
1. DO NOT add filler words like "אזור" or "ה".
2. Separate regions with a COMMA ONLY. No "ו".
3. Keep parentheses intact (e.g., "מרכז (שפלה)").
4. ONLY update estimated_time if a NEW explicit timeframe is provided. NEVER default to the Current Israel Time.

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
        const text = await generateWithFallback(prompt);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (err) {
        log("[AI] checkForNewInfo error: " + err.message);
    }
    return { has_new_info: false, reasoning: "Error during analysis" };
}

module.exports = { classifyMessage, checkForNewInfo };