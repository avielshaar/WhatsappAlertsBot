const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// החזרתי לגרסת הפרו שאהבת
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

async function analyzeSituation(messagesBuffer) {
    const contextText = messagesBuffer.map(msg => `- Channel ${msg.channel}: ${msg.text}`).join('\n');

    const prompt = `
    You are an intelligence analyst responsible for publishing real-time missile/rocket alert notifications to the public in Israel.
    Below is a batch of recent Telegram messages from highly reliable sources (in Hebrew):
    
    ${contextText}
    
    Your task is to analyze the information and decide if a formal alert should be published.
    Apply independent judgment:
    - These channels are generally very reliable. If you see a clear, official-sounding report of a missile launch or siren, prioritize speed.
    - Look for cross-references to validate vague reports.
    - Filter out general news, politics, UAVs/drones (focus strictly on missiles/rockets), or advertisements.

    CRITICAL FORMATTING RULES:
    - LANGUAGE RULE: The fields for the "source" (threatening country) and "target" MUST be written in Hebrew ONLY (e.g., "איראן", "לבנון", "תימן"). Do NOT output these in English.
    - LOCATION RULE: The "target" field MUST start with one or more of the following exact districts: "ירושלים", "צפון", "יו״ש", "מרכז", "דרום".
    - SPECIFIC LOCATIONS: After writing the district in the "target" field, you may add specific cities or areas in parentheses ONLY IF they are explicitly verified and mentioned in the source text.
    - FORMAT EXAMPLES FOR TARGET: "מרכז (תל אביב, רמת גן)", "צפון, יו״ש", "דרום (שדרות)", "ירושלים".
    
    Return your decision EXCLUSIVELY as a valid JSON object with the following structure:
    {
        "should_publish": true,
        "reasoning": "Brief 1-sentence explanation of your decision (in English)",
        "source": "Origin country/area IN HEBREW ONLY (e.g. איראן, לבנון)",
        "target": "District in Hebrew + Specifics IN HEBREW ONLY (e.g. מרכז (תל אביב))",
        "estimated_time": "Estimated arrival time (if specified, else empty string)"
    }
    Return ONLY raw JSON. No markdown, no additional text.
    `;

    try {
        console.log(`[AI] Sending ${messagesBuffer.length} messages to Gemini for analysis...`);
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            console.log("[AI] Successfully received and parsed response from Gemini.");
            return JSON.parse(jsonMatch[0]);
        } else {
            throw new Error("No JSON found in response");
        }

    } catch (error) {
        console.error("[AI] ❌ Error analyzing situation:", error.message);
        return { should_publish: false, reasoning: "Error during AI analysis" };
    }
}

module.exports = { analyzeSituation };