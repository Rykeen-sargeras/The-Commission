'use strict';

const STATUS = Object.freeze({
    UNVERIFIED: 'Unverified',
    ACTIVE: 'Active',
    PENDING_MISSING: 'PendingMissingConfirmation',
    GRACE: 'GracePeriod',
    EXPIRED: 'Expired',
    UNAVAILABLE: 'VerificationUnavailable',
    UNMAPPED: 'UnmappedLevel',
    OVERRIDE: 'ManualOverride',
    UNLINKED: 'Unlinked',
});

const ROLE_MODE = Object.freeze({
    HIGHEST: 'highest',
    CUMULATIVE: 'cumulative',
    GENERAL_PLUS_HIGHEST: 'general_plus_highest',
});

const CREATOR_SCOPE = 'https://www.googleapis.com/auth/youtube.channel-memberships.creator';
const MEMBER_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const MAX_MEMBER_BATCH = 100;

module.exports = { STATUS, ROLE_MODE, CREATOR_SCOPE, MEMBER_SCOPE, MAX_MEMBER_BATCH };
