'use strict';

const assert = require('assert');
const {
    parseCensusResult,
    parseNominatimResult,
    verifyAddressWithFreeGeocoders,
} = require('../address_verification');

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

const censusMatch = {
    matchedAddress: '9053 STATE HWY 107, SHERWOOD, AR, 72120',
    coordinates: { x: -92.231701499504, y: 34.837114533396 },
    addressComponents: {
        zip: '72120',
        streetName: '107',
        preType: 'STATE HWY',
        city: 'SHERWOOD',
        state: 'AR',
        fromAddress: '9001',
        toAddress: '9199',
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

assert.strictEqual(
    parseCensusResult(censusMatch, '9053 AR-107, Sherwood, AR 72120').verified,
    true,
);
assert.strictEqual(
    parseCensusResult(censusMatch, '9054 AR-107, Sherwood, AR 72120').verified,
    false,
);

assert.strictEqual(parseNominatimResult({
    ...exactResult,
    address: { ...exactResult.address, road: 'Nebraska Avenue' },
}, example).verified, false);

assert.strictEqual(parseNominatimResult({
    ...exactResult,
    address: { ...exactResult.address, postcode: '33619' },
}, example).verified, false);

(async () => {
    const verified = await verifyAddressWithFreeGeocoders(example, {
        fetchImpl: async (_url, options) => {
            assert.match(options.headers['User-Agent'], /The-Commission/);
            return { ok: true, json: async () => [exactResult] };
        },
    });
    assert.strictEqual(verified.verified, true);

    const fallback = await verifyAddressWithFreeGeocoders('9053 AR-107, Sherwood, AR 72120', {
        fetchImpl: async url => {
            if (url.hostname === 'nominatim.openstreetmap.org') {
                return {
                    ok: true,
                    json: async () => [{
                        address: {
                            road: 'State Highway 107', town: 'Sherwood', state: 'Arkansas',
                            'ISO3166-2-lvl4': 'US-AR', postcode: '72120',
                        },
                    }],
                };
            }
            return {
                ok: true,
                json: async () => ({ result: { addressMatches: [censusMatch] } }),
            };
        },
    });
    assert.strictEqual(fallback.verified, true);
    assert.strictEqual(fallback.provider, 'U.S. Census Geocoder');

    const uncertain = await verifyAddressWithFreeGeocoders('99999 Fake Rd, Tampa, FL 33618', {
        fetchImpl: async url => ({
            ok: true,
            json: async () => url.hostname === 'nominatim.openstreetmap.org'
                ? []
                : ({ result: { addressMatches: [] } }),
        }),
    });
    assert.strictEqual(uncertain.verified, false);

    console.log('address-verification tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

