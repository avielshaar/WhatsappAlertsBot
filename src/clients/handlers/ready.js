const { startTelegramClient } = require("../telegram");

async function onReady(callbacks) {
    await startTelegramClient(callbacks);
}

module.exports = { onReady };