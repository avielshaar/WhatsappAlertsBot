const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
    
    Return your decision EXCLUSIVELY as a valid JSON object with the following structure:
    {
        "should_publish": true/false,
        "reasoning": "Brief 1-sentence explanation of your decision (in English)",
        "source": "Origin country/area (if known, else empty string)",
        "target": "Target area in Israel (if known, else empty string)",
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