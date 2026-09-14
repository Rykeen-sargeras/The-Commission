'use strict';

const INSTALL_KEY = Symbol.for('the-commission.runtime-performance-installed');

function installRuntimePerformanceGuards(options = {}) {
    if (globalThis[INSTALL_KEY]) return;
    globalThis[INSTALL_KEY] = true;

    const verboseMessages = options.verboseMessages
        ?? String(process.env.COMMISSION_VERBOSE_MESSAGES || '').toLowerCase() === 'true';

    if (!verboseMessages) {
        const originalLog = console.log.bind(console);
        console.log = (...args) => {
            const first = String(args[0] ?? '');

            // Legacy discord_bot.js emits one of these for every message received.
            // On hosted runtimes, high-volume stdout can become measurable latency.
            if (first.startsWith('📩 Message received - Author:')) return;

            originalLog(...args);
        };
    }
}

module.exports = { installRuntimePerformanceGuards };
