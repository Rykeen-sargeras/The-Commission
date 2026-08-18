'use strict';

const assert = require('assert');
const { parseNominatimResult, verifyAddressWithNominatim } = require('../address_verification');

const example = '14941 N Dale Mabry Hwy, Tampa, FL 33618';
const exactResult = {
    place_id: 123,
    display_name: '14941, North Dale Mabry Highway, Tampa, Hillsborough County, Florida, 33618, United States',
    address: {
        house_number: '14941',
        road: 'North Dale Mabry Highway',
        city: 'Tampa',
        state: 'Florida',
        'ISO3166-2-lvl4': 'US-FL',
        postcode: '33618',
        country: 'United States',
    },
};

const parsed = parseNominatimResult(exactResult, example);
assert.strictEqual(parsed.verified, true);
assert.strictEqual(parsed.number, '14941');
assert.strictEqual(parsed.state, 'FL');

assert.strictEqual(parseNominatimResult({
    ...exactResult,
    address: { ...exactResult.address, house_number: '14942' },
}, example).verified, false);

assert.strictEqual(parseNominatimResult({
    ...exactResult,
    address: { ...exactResult.address, road: 'Nebraska Avenue' },
}, example).verified, false);

assert.strictEqual(parseNominatimResult({
    ...exactResult,
    address: { ...exactResult.address, postcode: '33619' },
}, example).verified, false);

(async () => {
    const verified = await verifyAddressWithNominatim(example, {
        fetchImpl: async (_url, options) => {
            assert.match(options.headers['User-Agent'], /The-Commission/);
            return { ok: true, json: async () => [exactResult] };
        },
    });
    assert.strictEqual(verified.verified, true);

    const uncertain = await verifyAddressWithNominatim('99999 Fake Rd, Tampa, FL 33618', {
        fetchImpl: async () => ({ ok: true, json: async () => [] }),
    });
    assert.strictEqual(uncertain.verified, false);

    console.log('address-verification tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

