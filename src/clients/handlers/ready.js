/**
 * WhatsApp Ready Event Handler
 * 
 * This module bridges the WhatsApp connection lifecycle with Telegram initialization.
 * 
 * When WhatsApp is ready and we've located the target group,
 * we then initialize Telegram polling to begin listening for new launch alerts.
 */

const { startTelegramClient } = require("../telegram");

/**
 * Handle WhatsApp ready event
 * 
 * Called after WhatsApp client has authenticated and found the target group.
 * Initiates Telegram client startup, which chains into the polling loop.
 * 
 * @param {Function} onReadyCallback - Called when alerts are ready to publish
 */
async function onReady(onReadyCallback) {
    // WhatsApp ready, so start monitoring Telegram for alerts
    await startTelegramClient(onReadyCallback);
}

module.exports = { onReady };
