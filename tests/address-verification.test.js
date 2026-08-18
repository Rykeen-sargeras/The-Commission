'use strict';

const assert = require('assert');
const { parseGoogleGeocodeResult, verifyAddressWithGoogle } = require('../address_verification');

function component(longName, shortName, ...types) {
    return { long_name: longName, short_name: shortName, types };
}

const preciseAddress = {
    formatted_address: '14941 N Dale Mabry Hwy, Tampa, FL 33618, USA',
    place_id: 'test-place-id',
    types: ['street_address'],
    geometry: { location_type: 'ROOFTOP' },
    address_components: [
        component('14941', '14941', 'street_number'),
        component('North Dale Mabry Highway', 'N Dale Mabry Hwy', 'route'),
        component('Tampa', 'Tampa', 'locality'),
        component('Florida', 'FL', 'administrative_area_level_1'),
        component('33618', '33618', 'postal_code'),
        component('United States', 'US', 'country'),
    ],
};

const parsed = parseGoogleGeocodeResult(preciseAddress);
assert.strictEqual(parsed.verified, true);
assert.strictEqual(parsed.number, '14941');
assert.strictEqual(parsed.state, 'FL');
assert.strictEqual(parsed.confidence, 1);

assert.strictEqual(parseGoogleGeocodeResult({
    ...preciseAddress,
    types: ['route'],
}).verified, false);

assert.strictEqual(parseGoogleGeocodeResult({
    ...preciseAddress,
    geometry: { location_type: 'APPROXIMATE' },
}).verified, false);

assert.strictEqual(parseGoogleGeocodeResult({
    ...preciseAddress,
    geometry: { location_type: 'RANGE_INTERPOLATED' },
}).verified, false);

(async () => {
    const verified = await verifyAddressWithGoogle('14941 N Dale Mabry Hwy, Tampa, FL 33618', 'test-key', {
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ status: 'OK', results: [preciseAddress] }),
        }),
    });
    assert.strictEqual(verified.verified, true);

    const missingKey = await verifyAddressWithGoogle('14941 N Dale Mabry Hwy', '');
    assert.strictEqual(missingKey.verified, false);

    console.log('address-verification tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

