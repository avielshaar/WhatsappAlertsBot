const fs = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); // Library for terminal user input
const { NewMessage } = require("telegram/events");
const { analyzeSituation } = require("./ai");
require("dotenv").config();

// Configurations
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
// Parse channels, handling potential empty strings
const ALERT_CHANNELS = process.env.ALERT_CHANNELS ? process.env.ALERT_CHANNELS.split(',').map(id => id.trim()) : [];
const TARGET_WHATSAPP_GROUP = process.env.WHATSAPP_GROUPS;

let whatsappGroupChat = null;
let telegramClient = null; // Lifted to global scope for graceful shutdown
let messagesBuffer = [];
let lastAlertTime = 0;
const CONTEXT_WINDOW_MS = 120 * 1000; // 120 seconds
const COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown between alerts

// ─── 1. WhatsApp Initialization ───
console.log("[System] Initializing WhatsApp Client...");
const whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    puppeteer: { 
        headless: true, 
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu"
        ],
        timeout: 90000,          
        protocolTimeout: 180000 
    }
});

whatsappClient.on("qr", (qr) => {
    console.log("\n[WhatsApp] Please scan the QR code below:");
    qrcode.generate(qr, { small: true });
});

whatsappClient.on("ready", async () => {
    console.log("[WhatsApp] ✅ Connected and ready!");
    console.log("[WhatsApp] Fetching chats to locate the target group...");
    
    try {
        // Find the target group
        const chats = await whatsappClient.getChats();
        whatsappGroupChat = chats.find(c => c.isGroup && c.name.includes(TARGET_WHATSAPP_GROUP));
        
        if (!whatsappGroupChat) {
            console.error(`[WhatsApp] ❌ Target group not found: ${TARGET_WHATSAPP_GROUP}`);
            console.log(`[WhatsApp] Available groups: ${chats.filter(c => c.isGroup).map(c => c.name).join(", ")}`);
            return;
        }
        console.log(`[WhatsApp] ✅ Target group located: ${whatsappGroupChat.name}`);
        
        // Once WhatsApp is ready, start Telegram
        await startTelegramClient();
    } catch (err) {
        console.error("[WhatsApp] ❌ Error fetching chats:", err);
    }
});

whatsappClient.initialize();

// ─── 2. Telegram Initialization & AI Logic ───
async function startTelegramClient() {
    console.log("[Telegram] Initializing client...");
    
    // Session persistence logic to avoid logging in every time
    const sessionFile = './.telegram_session';
    let sessionString = '';
    if (fs.existsSync(sessionFile)) {
        sessionString = fs.readFileSync(sessionFile, 'utf8');
        console.log("[Telegram] Found saved session, logging in automatically...");
    }

    const stringSession = new StringSession(sessionString); // Saves session locally
    telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });

    // Login process (will prompt in terminal only on first run)
    await telegramClient.start({
        phoneNumber: async () => await input.text("[Telegram Auth] Enter your phone number (e.g., +972...): "),
        password: async () => await input.text("[Telegram Auth] Enter your 2FA password (if any): "),
        phoneCode: async () => await input.text("[Telegram Auth] Enter the code received in Telegram: "),
        onError: (err) => console.error("[Telegram Auth] Error:", err),
    });

    // Save session to file after successful login
    fs.writeFileSync(sessionFile, telegramClient.session.save());
    console.log("[Telegram] ✅ Connected successfully!");

    console.log(`[Telegram] Starting to listen for messages in configured channels...`);

    telegramClient.addEventHandler(async (event) => {
        const messageText = event.message.message;
        const channelId = event.chatId;
        const now = Date.now();

        // Manual filter — string comparison to avoid BigInt precision issues
        if (ALERT_CHANNELS.length > 0 && !ALERT_CHANNELS.includes(String(channelId))) {
            return;
        }

        // -------------------------------------------------------------
        // TEST MODE: Log every received message and its channel ID
        console.log(`\n=================================================`);
        console.log(`[Test Mode] New message received!`);
        console.log(`[Test Mode] Channel ID: ${channelId}`);
        console.log(`[Test Mode] Message Preview: ${messageText ? messageText.substring(0, 50) : "No text"}...`);
        console.log(`=================================================`);
        // -------------------------------------------------------------

        // Filter out empty messages
        if (!messageText) return;

        // 1. Add message to buffer
        messagesBuffer.push({ channel: channelId, text: messageText, time: now });
        console.log(`[System] Message added to buffer. Current buffer size: ${messagesBuffer.length}`);

        // 2. Clean old messages (older than 120 seconds)
        messagesBuffer = messagesBuffer.filter(msg => now - msg.time <= CONTEXT_WINDOW_MS);

        // Check Cooldown
        if (now - lastAlertTime < COOLDOWN_MS) {
            const secondsLeft = Math.round((COOLDOWN_MS - (now - lastAlertTime)) / 1000);
            console.log(`[System] Cooldown active. Aggregating data. Seconds left: ${secondsLeft}s`);
            return;
        }

        console.log(`[System] Triggering AI analysis with ${messagesBuffer.length} active messages in context window...`);
        
        // 3. Get AI Decision
        const aiDecision = await analyzeSituation(messagesBuffer);

        if (aiDecision && aiDecision.should_publish) {
            console.log(`[AI] 🚨 DECISION: PUBLISH!`);
            console.log(`[AI] Reasoning: ${aiDecision.reasoning}`);
            
            // 4. Construct WhatsApp Message (Output remains in Hebrew for the group members)
            const alertMsg = 
                `🚨 *התרעת שיגור מאומתת!* 🚨\n\n` +
                `📍 *מקור:* ${aiDecision.source || "לא ידוע עוד"}\n` +
                `🎯 *יעד:* ${aiDecision.target || "לא ידוע עוד"}\n` +
                `⏱️ *זמן משוער:* ${aiDecision.estimated_time || "לא ידוע עוד"}\n\n`;

            console.log(`[WhatsApp] Sending alert to group...`);
            try {
                await whatsappGroupChat.sendMessage(alertMsg);
                console.log("[WhatsApp] 📤 Message sent successfully!");
            } catch (err) {
                console.error("[WhatsApp] ❌ Failed to send message:", err);
            }

            // Reset state after publishing
            lastAlertTime = now;
            messagesBuffer = []; 
            console.log(`[System] Buffer cleared and cooldown activated.`);
        } else {
            console.log(`[AI] DECISION: DO NOT PUBLISH.`);
            console.log(`[AI] Reasoning: ${aiDecision?.reasoning || "None provided"}`);
        }

    }, new NewMessage({}));
}

// ─── 3. Graceful Shutdown ───
// Prevents zombie Chrome processes if the script is stopped manually (Ctrl+C)
process.on('SIGINT', async () => {
    console.log("\n[System] Shutting down gracefully...");
    try {
        if (whatsappClient) await whatsappClient.destroy();
        if (telegramClient) await telegramClient.disconnect();
    } catch (e) {
        console.error("[System] Error during shutdown:", e);
    }
    process.exit(0);
});