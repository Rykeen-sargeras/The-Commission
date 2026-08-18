'use strict';

// Automatic moderation is high impact, so only accept Google's most precise result.
const PRECISE_LOCATION_TYPES = new Set(['ROOFTOP']);

function addressComponent(result, type) {
    return result?.address_components?.find(component => component.types?.includes(type)) || null;
}

function componentValue(result, type, short = false) {
    const component = addressComponent(result, type);
    return component ? (short ? component.short_name : component.long_name) : '';
}

function parseGoogleGeocodeResult(result) {
    const locationType = result?.geometry?.location_type || '';
    const resultTypes = result?.types || [];
    const number = componentValue(result, 'street_number');
    const street = componentValue(result, 'route');
    const city = componentValue(result, 'locality')
        || componentValue(result, 'postal_town')
        || componentValue(result, 'administrative_area_level_2');
    const state = componentValue(result, 'administrative_area_level_1', true);

    if (!resultTypes.includes('street_address')) {
        return { verified: false, reason: 'Google result is not a street address' };
    }
    if (!PRECISE_LOCATION_TYPES.has(locationType)) {
        return { verified: false, reason: `Google location is not precise (${locationType || 'unknown'})` };
    }
    if (!number || !street || !city || !state) {
        return { verified: false, reason: 'Google result is missing required address components' };
    }

    return {
        verified: true,
        provider: 'Google Maps Geocoding API',
        displayName: result.formatted_address || `${number} ${street}, ${city}, ${state}`,
        type: 'street_address',
        confidence: locationType === 'ROOFTOP' ? 1 : 0.9,
        locationType,
        street,
        number,
        city,
        state,
        zip: componentValue(result, 'postal_code'),
        country: componentValue(result, 'country'),
        placeId: result.place_id || '',
    };
}

async function verifyAddressWithGoogle(text, apiKey, { fetchImpl = globalThis.fetch, timeoutMs = 7000 } = {}) {
    if (!apiKey) return { verified: false, reason: 'Google Maps API key not configured' };
    if (typeof fetchImpl !== 'function') return { verified: false, reason: 'HTTP client unavailable' };

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', text);
    url.searchParams.set('key', apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) return { verified: false, reason: `Google HTTP ${response.status}` };

        const data = await response.json();
        if (data.status !== 'OK') {
            return { verified: false, reason: `Google status: ${data.status || 'UNKNOWN'}` };
        }

        for (const result of data.results || []) {
            const parsed = parseGoogleGeocodeResult(result);
            if (parsed.verified) return parsed;
        }
        return { verified: false, reason: 'No precise street-address result' };
    } catch (error) {
        return {
            verified: false,
            reason: error.name === 'AbortError' ? 'Google request timed out' : `Google request failed: ${error.message}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    parseGoogleGeocodeResult,
    verifyAddressWithGoogle,
};

