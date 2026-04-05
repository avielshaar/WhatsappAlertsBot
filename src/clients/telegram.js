/**
 * Telegram Client Module
 * 
 * Connects to Telegram using user account credentials (not a bot)
 * and continuously polls configured alert channels for new messages.
 * 
 * Using a user account allows access to any channel without needing
 * the channel admin to add a bot. Session is persisted in .telegram_session
 * file for reuse across restarts (only need 2FA once).
 * 
 * Polling strategy: Check each channel once per cycle, 300ms between channels,
 * 1s between full cycles. This balances responsiveness with rate limiting.
 */

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { log } = require("../logger");
const { TELEGRAM_API_ID, TELEGRAM_API_HASH, ALERT_CHANNELS } = require("../config");
const { processMessage } = require("../messaging/processor");

let telegramClient = null;                    // The Telegram client instance
const lastSeenMessageIds = {};                // Track latest message ID per channel
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Initialize Telegram user client and start monitoring channels
 * 
 * First execution:
 * 1. Prompts for phone number, 2FA password, and verification code
 * 2. Authenticates and saves session to .telegram_session
 * 
 * Subsequent executions:
 * 1. Loads session from .telegram_session automatically
 * 2. No authentication needed
 * 
 * Then begin polling all configured ALERT_CHANNELS
 * 
 * @param {Function} onPublish - Callback to pass to processMessage
 */
async function startTelegramClient(onPublish) {
    log("[Telegram] Initializing client...");

    // Try to load existing session to avoid re-authentication
    const sessionFile = './.telegram_session';
    let sessionString = '';
    if (fs.existsSync(sessionFile)) sessionString = fs.readFileSync(sessionFile, 'utf8');

    const stringSession = new StringSession(sessionString);
    telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });

    // Authenticate user account with phone number and 2FA
    await telegramClient.start({
        phoneNumber: async () => await input.text("[Telegram Auth] Enter your phone number: "),
        password:    async () => await input.text("[Telegram Auth] Enter your 2FA password: "),
        phoneCode:   async () => await input.text("[Telegram Auth] Enter the code: "),
        onError:     (err) => log("[Telegram Auth] Error: " + err),
    });

    // Save session for next time
    fs.writeFileSync(sessionFile, telegramClient.session.save());
    log("[Telegram] ✅ Connected successfully!");
    
    // Initialize tracking: Get the latest message ID from each channel
    // so we only process NEW messages
    log("[Telegram] 🔍 Initializing trackers...");
    for (let id of ALERT_CHANNELS) {
        if (!id) continue;
        try {
            const msgs = await telegramClient.getMessages(id, { limit: 1 });
            if (msgs && msgs.length > 0) {
                lastSeenMessageIds[id] = msgs[0].id;
                log(`✅ Tracking initialized for ID: ${id}`);
            }
        } catch (err) {
            log(`❌ Could not fetch initial data for ${id}`);
        }
        await sleep(300);
    }

    log("[Telegram] 🔍 Listening for new messages...");

    // Start the continuous polling loop
    startPolling(onPublish);
}

/**
 * Continuous polling loop
 * 
 * Checks each channel twice per second for new messages.
 * Processes any new messages through the message processor.
 * Handles FLOOD_WAIT errors gracefully with backoff.
 * 
 * @param {Function} onPublish - Callback for message processing
 */
async function startPolling(onPublish) {
    (async () => {
        while (true) {
            // Poll each channel
            for (let id of ALERT_CHANNELS) {
                if (!id) continue;
                try {
                    // Get latest message from this channel
                    const msgs = await telegramClient.getMessages(id, { limit: 1 });
                    if (msgs && msgs.length > 0) {
                        const latestMsg = msgs[0];
                        const msgText   = latestMsg.message;

                        // Check if this is a new message we haven't processed yet
                        if (latestMsg.id > (lastSeenMessageIds[id] || 0)) {
                            lastSeenMessageIds[id] = latestMsg.id;
                            if (msgText) {
                                log(`[POLLING] 🚨 NEW MESSAGE | Channel: ${id}`);
                                // Process through the message handling pipeline
                                await processMessage(id, msgText, onPublish);
                            }
                        }
                    }
                } catch (err) {
                    // Telegram rate limiting - back off and retry
                    if (err.message && err.message.includes("FLOOD")) await sleep(5000);
                }
                // Stagger requests to avoid overwhelming the server
                await sleep(300);
            }
            // Full cycle delay
            await sleep(1000);
        }
    })();
}

/**
 * Clean shutdown of Telegram connection
 * Disconnects client gracefully
 */
async function shutdownTelegram() {
    if (telegramClient) await telegramClient.disconnect();
}

module.exports = {
    startTelegramClient,
    shutdownTelegram,
};
