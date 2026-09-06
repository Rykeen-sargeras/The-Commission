const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDurationMs, PersistentJailScheduler } = require('../jail_scheduler');

function makeHarness(onRelease = async () => true) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-jail-scheduler-'));
    const filePath = path.join(directory, 'active-jails.json');
    const timers = [];
    let now = 1_000;
    const scheduler = new PersistentJailScheduler({
        filePath,
        onRelease,
        now: () => now,
        setTimer(callback, delay) {
            const timer = { callback, delay, cleared: false, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) {
            timer.cleared = true;
        },
        logger: { error() {} },
    });
    return {
        directory,
        filePath,
        scheduler,
        timers,
        setNow(value) { now = value; },
        cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
    };
}

async function flush() {
    await new Promise(resolve => setImmediate(resolve));
}

async function run() {
    assert.equal(parseDurationMs('5 minutes (1st offense)'), 300_000);
    assert.equal(parseDurationMs('24 hours'), 86_400_000);
    assert.equal(parseDurationMs('Permanent'), null);

    {
        const harness = makeHarness();
        harness.scheduler.schedule({ guildId: 'guild', userId: 'user', releaseAt: 6_000, channelId: 'channel' });
        assert.equal(harness.timers[0].delay, 5_000, 'future jail should use remaining duration');
        const saved = JSON.parse(fs.readFileSync(harness.filePath, 'utf8'));
        assert.equal(saved.activeJails[0].channelId, 'channel', 'record should persist immediately');
        harness.scheduler.remove('guild', 'user');
        assert.equal(harness.timers[0].cleared, true, 'manual release should cancel the timer');
        assert.equal(JSON.parse(fs.readFileSync(harness.filePath, 'utf8')).activeJails.length, 0);
        harness.cleanup();
    }

    {
        const released = [];
        const first = makeHarness(async record => released.push(record.userId));
        fs.writeFileSync(first.filePath, JSON.stringify({
            version: 1,
            activeJails: [{ guildId: 'guild', userId: 'overdue', releaseAt: 900 }],
        }));
        assert.equal(first.scheduler.restore(), 1);
        assert.equal(first.timers[0].delay, 0, 'overdue jail should release immediately after restart');
        first.timers[0].callback();
        await flush();
        assert.deepEqual(released, ['overdue']);
        assert.equal(first.scheduler.list().length, 0, 'successful release should remove persisted record');
        first.cleanup();
    }

    {
        let attempts = 0;
        const harness = makeHarness(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('temporary Discord failure');
            return true;
        });
        harness.scheduler.schedule({ guildId: 'guild', userId: 'retry', releaseAt: 1_000 });
        harness.timers[0].callback();
        await flush();
        assert.equal(harness.scheduler.list().length, 1, 'failed release must remain durable');
        assert.equal(harness.timers[1].delay, 60_000, 'failed release should be retried');
        harness.timers[1].callback();
        await flush();
        assert.equal(attempts, 2);
        assert.equal(harness.scheduler.list().length, 0);
        harness.cleanup();
    }

    console.log('jail-scheduler tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
