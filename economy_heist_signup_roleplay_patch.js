'use strict';

const economyModule = require('./economy');

const ENTRY_FEE = 100_000;
const EASTERN = 'America/New_York';
const RAID_HOURS = [3, 9, 15, 21];
const CLOSE_BEFORE_MS = 60 * 1000;

const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
});

function parts(ms) {
    const out = {};
    for (const part of formatter.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') out[part.type] = Number(part.value);
    }
    return out;
}

function shiftDay(p, days) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function easternEpoch({ year, month, day, hour, minute = 0, second = 0 }) {
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = target;
    for (let i = 0; i < 4; i += 1) {
        const actual = parts(guess);
        const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        const delta = target - actualUtc;
        if (!delta) break;
        guess += delta;
    }
    return guess;
}

function nextRaid(now = Date.now()) {
    const local = parts(now);
    const today = { year: local.year, month: local.month, day: local.day };
    for (const hour of RAID_HOURS) {
        const at = easternEpoch({ ...today, hour });
        if (at > now) return at;
    }
    const tomorrow = shiftDay(today, 1);
    return easternEpoch({ ...tomorrow, hour: RAID_HOURS[0] });
}

function followingRaid(raidAt) {
    return nextRaid(raidAt + 1000);
}

function pick(list, random = Math.random) {
    return list[Math.floor(Math.min(0.999999, Math.max(0, random())) * list.length)];
}

function installHeistSignupRoleplayPatch() {
    const Previous = economyModule.EconomyService;

    class SignupRoleplayEconomyService extends Previous {
        heistSchedule(now = Date.now()) {
            const raidAt = nextRaid(now);
            return {
                startsAt: raidAt,
                signupEndsAt: raidAt - CLOSE_BEFORE_MS,
                nextAt: raidAt,
            };
        }

        heistState(guildId, now = Date.now()) {
            let active = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' ORDER BY created_at ASC LIMIT 1").get(guildId);
            if (active) {
                let existing = this.heistRound(active.round_id);
                if (Number(existing.created_at) <= now) {
                    this.resolveHeist(existing.round_id, now);
                    active = null;
                }
            }

            const schedule = this.heistSchedule(now);
            let current = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' AND created_at=? LIMIT 1")
                .get(guildId, schedule.startsAt);

            if (!current) {
                const stray = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' ORDER BY created_at DESC LIMIT 1").get(guildId);
                if (stray) {
                    const row = this.heistRound(stray.round_id);
                    if (row && Number(row.created_at) !== schedule.startsAt) this.resolveHeist(row.round_id, now);
                }
                const round = this.createHeistRound(guildId, now);
                if (Number(round.created_at) !== schedule.startsAt) {
                    this.db.prepare('UPDATE heist_rounds SET created_at=?,signup_ends_at=?,entry_fee=? WHERE round_id=?')
                        .run(schedule.startsAt, schedule.signupEndsAt, ENTRY_FEE, round.round_id);
                }
                current = { round_id: round.round_id };
            }

            let round = this.heistRound(current.round_id);
            if (round.signup_ends_at !== schedule.signupEndsAt || round.entry_fee !== ENTRY_FEE) {
                this.db.prepare('UPDATE heist_rounds SET signup_ends_at=?,entry_fee=? WHERE round_id=?')
                    .run(schedule.signupEndsAt, ENTRY_FEE, round.round_id);
                round = this.heistRound(round.round_id);
            }
            round = this.transferQueuedEntries?.(round, now) || round;

            if (now < schedule.signupEndsAt) return { phase: 'signup', round, nextAt: schedule.signupEndsAt, raidAt: schedule.startsAt };
            return { phase: 'cooldown', round, nextAt: schedule.startsAt, raidAt: schedule.startsAt, locked: true };
        }

        joinHeist(guildId, userId, roundId, interactionId, now = Date.now()) {
            const state = this.heistState(guildId, now);
            if (state.phase !== 'signup' || now >= state.round.signup_ends_at) {
                const target = followingRaid(state.raidAt || state.nextAt || now);
                return this.queueNextHeist(guildId, userId, interactionId, target, now);
            }

            return this.transaction(() => {
                const round = this.heistRound(state.round.round_id);
                if (!round || round.guild_id !== guildId || round.status !== 'signup' || now >= round.signup_ends_at) {
                    const target = followingRaid(state.raidAt || state.nextAt || now);
                    return this.queueNextHeist(guildId, userId, interactionId, target, now);
                }
                const existing = this.db.prepare('SELECT 1 FROM heist_entries WHERE round_id=? AND user_id=?').get(round.round_id, userId);
                if (existing) return { alreadyEntered: true, balance: this.member(guildId, userId)?.balance || 0, round };
                const member = this.ensureMember(guildId, userId, now);
                this.assertUsable(member);
                const reserved = this.reserveWager(guildId, userId, ENTRY_FEE, interactionId, `heist:${round.round_id}`, now);
                this.db.prepare('INSERT INTO heist_entries(round_id,guild_id,user_id,entry_fee,joined_at) VALUES(?,?,?,?,?)')
                    .run(round.round_id, guildId, userId, ENTRY_FEE, now);
                this.db.prepare('UPDATE heist_rounds SET pot=pot+? WHERE round_id=?').run(ENTRY_FEE, round.round_id);
                return { alreadyEntered: false, balance: reserved.balance, round: this.heistRound(round.round_id) };
            });
        }

        bossOutcome(round, entries, type) {
            const outcome = super.bossOutcome(round, entries, type);
            const boss = type?.name || 'the boss';
            const opener = pick([
                `🚨 Sirens die in the distance. The vault doors buckle. **${boss}** steps through the smoke like they own the block.`,
                `💥 The lights cut out. One emergency lamp flickers on, and there stands **${boss}**, grinning at the crew.`,
                `🎭 The crew reaches the score clean—too clean. Then **${boss}** kicks the door shut behind them. Nobody is leaving quietly.`,
                `📻 The getaway driver whispers, “Uh... boss? We got company.” **${boss}** crashes the party with terrible timing and excellent dramatic flair.`,
            ], this.random);
            const middle = pick([
                `The crew scatters behind cover, shells hit the floor, and somebody's goon is absolutely pretending that was part of the plan.`,
                `Tables flip, alarms scream, and the hired muscle charges in with the confidence of people who definitely did not read the contract.`,
                `For thirty ugly seconds it is pure chaos—shouting, smoke, ricochets, and one very expensive lamp meeting its end.`,
                `The Commission forms up. No speeches. No mercy. Just a very loud disagreement over who gets to walk away with the Blood Money.`,
            ], this.random);
            if (outcome.success) {
                const finish = pick([
                    `🏆 **${boss} goes down.** The room goes silent, then the crew starts grabbing bags. Tonight, crime actually paid.`,
                    `💰 **The crew wins.** ${boss} is left staring at an empty vault while the Commission disappears into the night with the payout.`,
                    `🔥 **Clean finish.** ${boss} makes one last move, gets folded, and the getaway van leaves before the cops even find the right door.`,
                ], this.random);
                outcome.story = [opener, middle, finish, `💵 Final crew reward: **${Number(outcome.rewardPool || 0).toLocaleString('en-US')} Blood Money**.`];
            } else {
                const finish = pick([
                    `🚔 **Disaster.** ${boss} turns the ambush around. The crew escapes with bruised egos, empty hands, and several new reasons to hate tonight.`,
                    `💀 **The job goes bad.** ${boss} holds the room, the score is lost, and the getaway driver peels out before anyone can make the situation worse.`,
                    `🧱 **Brick wall.** The crew throws everything at ${boss}, but tonight the boss battle wins. The Commission retreats to plan revenge.`,
                ], this.random);
                outcome.story = [opener, middle, finish];
            }
            return outcome;
        }

        pvpOutcome(round, entries, now = Date.now()) {
            const outcome = super.pvpOutcome(round, entries, now);
            const victim = outcome.victimId ? `<@${outcome.victimId}>` : 'the target';
            const opener = pick([
                `🕶️ Word hits the street: **${victim}** is moving Blood Money tonight. The Commission decides that sounds like a donation.`,
                `🚗 A black sedan tails **${victim}** for three blocks. At the fourth light, the crew makes its move.`,
                `📞 The tip comes in hot: **${victim}** has money, bad luck, and exactly sixty seconds before the whole block gets complicated.`,
                `🔫 The crew surrounds **${victim}**. Somebody says, “Nothing personal.” It immediately becomes extremely personal.`,
            ], this.random);
            const clash = pick([
                `Doors slam, goons pile out, and suddenly the street looks like somebody gave a crime movie an unlimited effects budget.`,
                `The first shot sends everyone scrambling. The next minute is sirens, broken glass, and absolutely zero respect for local parking laws.`,
                `The target fights back hard. Hired goons earn their paycheck while the bosses shout instructions from somewhere safely behind cover.`,
                `It turns into a full-on turf fight—fast, messy, and loud enough that three neighborhoods now know somebody made a bad financial decision.`,
            ], this.random);
            if (outcome.success) {
                const finish = pick([
                    `💸 **Score secured.** The target gets cleaned out for the allowed cut and the crew vanishes before backup arrives.`,
                    `🏃 **The Commission gets away clean.** Bags in hand, tires screaming, everybody suddenly remembers they have somewhere else to be.`,
                    `🥷 **Perfect hit.** The target is left counting what is missing while the crew is already splitting the take across town.`,
                ], this.random);
                outcome.story = [opener, clash, finish, `🩸 Taken from the target: **${Number(outcome.stolenAmount || 0).toLocaleString('en-US')} Blood Money**.`, `💰 Crew reward: **${Number(outcome.rewardPool || 0).toLocaleString('en-US')} Blood Money**.`];
            } else {
                const finish = pick([
                    `🛑 **The target holds the line.** The crew gets pushed back and the goons learn that “easy money” was marketing language.`,
                    `🚑 **Retreat.** The hit falls apart, the target keeps the money, and the Commission leaves with less dignity than it arrived with.`,
                    `💥 **Countered.** The target flips the ambush and sends the crew running. Somebody is definitely getting yelled at in the debrief.`,
                ], this.random);
                outcome.story = [opener, clash, finish];
                if (Number(outcome.defenseAmount || 0) > 0) outcome.story.push(`🤕 Goon-related loss absorbed by bosses: **${Number(outcome.defenseAmount).toLocaleString('en-US')} Blood Money**.`);
            }
            return outcome;
        }
    }

    economyModule.EconomyService = SignupRoleplayEconomyService;
}

module.exports = {
    CLOSE_BEFORE_MS,
    installHeistSignupRoleplayPatch,
    nextRaid,
};
