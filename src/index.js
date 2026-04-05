const fs = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); 
const { analyzeSituation } = require("./ai");
require("dotenv").config();

const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const ALERT_CHANNELS = process.env.ALERT_CHANNELS ? process.env.ALERT_CHANNELS.split(',').map(id => id.trim()) : [];
const TARGET_WHATSAPP_GROUP = process.env.WHATSAPP_GROUPS;

let whatsappGroupChat = null;
let telegramClient = null; 
let messagesBuffer = [];
let lastAlertTime = 0;
const CONTEXT_WINDOW_MS = 120 * 1000; 
const COOLDOWN_MS = 60 * 1000; 

// מעקב אחרי ההודעות האחרונות כדי לא לשלוח כפילויות
const lastSeenMessageIds = {};

// פונקציית עזר להשהיה חכמה
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

console.log("[System] Initializing WhatsApp Client...");
const whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    puppeteer: { 
        headless: true, 
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    }
});

whatsappClient.on("qr", (qr) => qrcode.generate(qr, { small: true }));

whatsappClient.on("ready", async () => {
    console.log("[WhatsApp] ✅ Connected and ready!");
    try {
        const chats = await whatsappClient.getChats();
        whatsappGroupChat = chats.find(c => c.isGroup && c.name.includes(TARGET_WHATSAPP_GROUP));
        
        if (!whatsappGroupChat) {
            console.error(`[WhatsApp] ❌ Target group not found: ${TARGET_WHATSAPP_GROUP}`);
            return;
        }
        console.log(`[WhatsApp] ✅ Target group located: ${whatsappGroupChat.name}`);
        await startTelegramClient();
    } catch (err) {
        console.error("[WhatsApp] ❌ Error fetching chats:", err);
    }
});

whatsappClient.initialize();

async function processWithAI(channelId, messageText) {
    const now = Date.now();
    console.log(`[System] Processing new message for AI analysis...`);

    messagesBuffer.push({ channel: channelId, text: messageText, time: now });
    messagesBuffer = messagesBuffer.filter(msg => now - msg.time <= CONTEXT_WINDOW_MS);

    if (now - lastAlertTime < COOLDOWN_MS) {
        console.log(`[System] Cooldown active. Waiting...`);
        return;
    }
    
    const aiDecision = await analyzeSituation(messagesBuffer);

    if (aiDecision && aiDecision.should_publish) {
        console.log(`[AI] 🚨 PUBLISHING! Reasoning: ${aiDecision.reasoning}`);
        const alertMsg = 
            `🚨 *התרעת שיגור מאומתת!* 🚨\n\n` +
            `📍 *מקור:* ${aiDecision.source || "לא ידוע עוד"}\n` +
            `🎯 *יעד:* ${aiDecision.target || "לא ידוע עוד"}\n` +
            `⏱️ *זמן משוער:* ${aiDecision.estimated_time || "לא ידוע עוד"}\n\n`;

        try {
            await whatsappGroupChat.sendMessage(alertMsg);
            console.log("[WhatsApp] 📤 Message sent!");
        } catch (err) {
            console.error("[WhatsApp] ❌ Failed:", err);
        }

        lastAlertTime = now;
        messagesBuffer = []; 
    } else {
        console.log(`[AI] BLOCKED. Reasoning: ${aiDecision?.reasoning || "None"}`);
    }
}

async function startTelegramClient() {
    console.log("[Telegram] Initializing client...");
    
    const sessionFile = './.telegram_session';
    let sessionString = '';
    if (fs.existsSync(sessionFile)) {
        sessionString = fs.readFileSync(sessionFile, 'utf8');
    }

    const stringSession = new StringSession(sessionString); 
    telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });

    await telegramClient.start({
        phoneNumber: async () => await input.text("[Telegram Auth] Enter your phone number: "),
        password: async () => await input.text("[Telegram Auth] Enter your 2FA password: "),
        phoneCode: async () => await input.text("[Telegram Auth] Enter the code: "),
        onError: (err) => console.error("[Telegram Auth] Error:", err),
    });

    fs.writeFileSync(sessionFile, telegramClient.session.save());
    console.log("[Telegram] ✅ Connected successfully!");
    
    // --- איתחול מערכת המעקב ---
    console.log("\n[Telegram] 🔍 Initializing trackers for your channels...");
    for (let id of ALERT_CHANNELS) {
        if (!id) continue;
        try {
            const msgs = await telegramClient.getMessages(id, { limit: 1 });
            if (msgs && msgs.length > 0) {
                lastSeenMessageIds[id] = msgs[0].id;
                console.log(`✅ Tracking initialized for ID: ${id}`);
            }
        } catch (err) {
            console.log(`❌ Could not fetch initial data for ${id}`);
        }
        // השהייה גם פה כדי לא לקבל חסימה על ההתחלה
        await sleep(300);
    }

    console.log("\n[Telegram] 🔄 SWITCHING TO SMART POLLING MODE!");
    console.log("[Telegram] 📡 Checking channels sequentially to prevent rate limits...\n");

    // --- לולאת Smart Polling (עוקפת את חסימות טלגרם) ---
    (async () => {
        while (true) {
            for (let id of ALERT_CHANNELS) {
                if (!id) continue;
                try {
                    const msgs = await telegramClient.getMessages(id, { limit: 1 });
                    if (msgs && msgs.length > 0) {
                        const latestMsg = msgs[0];
                        const msgText = latestMsg.message;
                        
                        if (latestMsg.id > (lastSeenMessageIds[id] || 0)) {
                            lastSeenMessageIds[id] = latestMsg.id; 
                            
                            if (msgText) {
                                console.log(`\n=========================================`);
                                console.log(`[POLLING] 🚨 NEW MESSAGE CAUGHT!`);
                                console.log(`[POLLING] Channel ID: ${id}`);
                                console.log(`=========================================`);
                                
                                await processWithAI(id, msgText);
                            }
                        }
                    }
                } catch (err) {
                    // אם בכל זאת קיבלנו חסימת פתע, ניתן לבוט לנוח קצת בשקט ונמשיך
                    if (err.message && err.message.includes("FLOOD")) {
                        await sleep(5000); 
                    }
                }
                // סוד הקסם: מנוחה של 300 מילישניות בין בקשה לבקשה
                await sleep(300);
            }
            // מנוחה של שניה בסוף כל סבב (נותן לשרת להירגע)
            await sleep(1000);
        }
    })();
}

process.on('SIGINT', async () => {
    console.log("\n[System] Shutting down...");
    if (whatsappClient) await whatsappClient.destroy();
    if (telegramClient) await telegramClient.disconnect();
    process.exit(0);
});