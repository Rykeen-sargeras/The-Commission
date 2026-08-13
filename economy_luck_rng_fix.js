'use strict';

const crypto = require('crypto');
const { EconomyService } = require('./economy');

EconomyService.prototype.luckProc = function independentLuckProc(guildId, userId, now = Date.now()) {
    const percent = this.totalLuckPercent(guildId, userId, now);
    if (percent <= 0) return false;
    const roll = crypto.randomInt(0, 1_000_000) / 10_000;
    return roll < Math.min(100, percent);
};
