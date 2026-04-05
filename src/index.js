/**
 * WhatsApp Alert Bot - Main Entry Point
 * 
 * This application monitors Telegram channels for alerts about missile/rocket launches
 * and republishes them to a WhatsApp group for immediate notification.
 * 
 * Flow:
 * 1. Initialize WhatsApp client
 * 2. When WhatsApp is ready, start Telegram polling
 * 3. Process incoming Telegram messages through AI classifier
 * 4. Track events across multiple channels for corroboration
 * 5. Publish verified alerts to WhatsApp group
 * 6. Graceful shutdown on Ctrl+C
 */

const { log } = require("./logger");
const { initializeWhatsApp, sendAlert, shutdownWhatsApp } = require("./clients/whatsapp");
const { shutdownTelegram } = require("./clients/telegram");
const { setLastPublished } = require("./messaging/processor");

/**
 * Callback handler when an alert should be published to WhatsApp
 * @param {string} source - The origin of the launch (e.g., "איראן" - Iran)
 * @param {string} target - The target location (e.g., "צפון" - Northern Israel)
 * @param {string} estimated_time - Estimated arrival time if available
 */
async function onAlertPublish(source, target, estimated_time) {
    const result = await sendAlert(source, target, estimated_time);
    if (result) {
        // Update the last published alert state for deduplication comparison
        setLastPublished(result.source, result.target, result.estimated_time);
    }
}

// Initialize WhatsApp client and chain Telegram setup on ready
initializeWhatsApp(onAlertPublish);

/**
 * Graceful shutdown handler
 * Triggered by user pressing Ctrl+C
 * Closes all connections before exiting
 */
process.on('SIGINT', async () => {
    log("\n[System] Shutting down...");
    await shutdownWhatsApp();
    await shutdownTelegram();
    process.exit(0);
});
