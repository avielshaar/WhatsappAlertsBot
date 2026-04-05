/**
 * WhatsApp Client Module
 * 
 * Handles WhatsApp connection and message sending using whatsapp-web.js.
 * This opens a headless Chromium browser to interact with WhatsApp Web.
 * 
 * Session is persisted in .wwebjs_auth/ directory so we don't need to
 * scan the QR code every time the bot restarts.
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const { log } = require("../logger");
const { TARGET_WHATSAPP_GROUP } = require("../config");
const { onReady } = require("./handlers/ready");

let whatsappGroupChat = null;    // Reference to target WhatsApp group
let whatsappClient = null;         // The WhatsApp client instance

/**
 * Initialize WhatsApp client and connect to WhatsApp Web
 * 
 * Lifecycle:
 * 1. If first run, QR code is displayed for phone authentication
 * 2. Browser session is saved to .wwebjs_auth/ for future runs
 * 3. When ready, locate target group and start Telegram polling
 * 
 * @param {Function} onReadyCallback - Called when WhatsApp is ready, starts Telegram client
 */
function initializeWhatsApp(onReadyCallback) {
    log("[System] Initializing WhatsApp Client...");
    whatsappClient = new Client({
        // Persist authentication between restarts
        authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
        puppeteer: {
            // Headless mode: no visible browser window
            headless: true,
            // Sandbox arguments for security and reliability
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        }
    });

    // Show QR code for first-time authentication
    whatsappClient.on("qr", (qr) => {
        const qrcode = require("qrcode-terminal");
        qrcode.generate(qr, { small: true });
    });

    // When WhatsApp Web connection is established
    whatsappClient.on("ready", async () => {
        log("[WhatsApp] ✅ Connected and ready!");
        try {
            // Fetch all chats and find our target group
            const chats = await whatsappClient.getChats();
            whatsappGroupChat = chats.find(c => c.isGroup && c.name.includes(TARGET_WHATSAPP_GROUP));
            
            if (!whatsappGroupChat) {
                log(`[WhatsApp] ❌ Target group not found: ${TARGET_WHATSAPP_GROUP}`);
                return;
            }
            
            log(`[WhatsApp] ✅ Target group located: ${whatsappGroupChat.name}`);
            // Now that WhatsApp is ready, start the Telegram polling
            await onReady(onReadyCallback);
        } catch (err) {
            log("[WhatsApp] ❌ Error fetching chats: " + err);
        }
    });

    // Begin connection process
    whatsappClient.initialize();
}

/**
 * Send an alert message to the target WhatsApp group
 * 
 * Message format is formatted with Hebrew text and emoji for clear notification.
 * Returns alert metadata if successful (used to update lastPublished state).
 * 
 * @param {string} source - Origin country (Hebrew, e.g., "איראן")
 * @param {string} target - Target location (Hebrew, e.g., "צפון")
 * @param {string} estimated_time - Estimated arrival time or empty string
 * @returns {Promise<object|null>} Alert metadata if sent successfully, null on error
 */
async function sendAlert(source, target, estimated_time) {
    // Construct message with emojis and markdown formatting (WhatsApp supports *bold*)
    const alertMsg =
        `🚨 *התרעה - שיגורים בדרכם!* 🚨\n\n` +
        `📍 *מקור:* ${source          || "לא ידוע"}\n` +
        `🎯 *יעד:* ${target            || "לא ידוע"}\n` +
        `⏱️ *זמן משוער:* ${estimated_time || "לא ידוע"}`;

    try {
        // Send message to the target group
        await whatsappGroupChat.sendMessage(alertMsg);
        log("[WhatsApp] 📤 Alert sent!");
        // Return alert metadata for state tracking
        return { source, target, estimated_time, publishedAt: Date.now() };
    } catch (err) {
        log("[WhatsApp] ❌ Failed to send: " + err);
        return null;
    }
}

/**
 * Clean shutdown of WhatsApp connection
 * Closes browser and disconnects cleanly
 */
async function shutdownWhatsApp() {
    if (whatsappClient) await whatsappClient.destroy();
}

module.exports = {
    initializeWhatsApp,
    sendAlert,
    shutdownWhatsApp,
};
