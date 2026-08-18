'use strict';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const USER_AGENT = 'The-Commission-Discord-Bot/3.6.2 (https://github.com/Rykeen-sargeras/The-Commission)';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const cache = new Map();
let requestChain = Promise.resolve();
let lastRequestAt = 0;

const STREET_WORDS = new Map([
    ['n', 'north'], ['s', 'south'], ['e', 'east'], ['w', 'west'],
    ['hwy', 'highway'], ['rd', 'road'], ['st', 'street'], ['ave', 'avenue'],
    ['blvd', 'boulevard'], ['dr', 'drive'], ['ln', 'lane'], ['ct', 'court'],
    ['pkwy', 'parkway'], ['trl', 'trail'], ['cir', 'circle'], ['ter', 'terrace'],
]);

function normalizeWords(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(word => STREET_WORDS.get(word) || word);
}

function containsWords(inputWords, expectedWords) {
    const input = new Set(inputWords);
    return expectedWords.every(word => input.has(word));
}

function cityFrom(address) {
    return address.city || address.town || address.village || address.municipality || address.hamlet || '';
}

function parseNominatimResult(result, originalText) {
    const address = result?.address || {};
    const number = address.house_number || '';
    const street = address.road || address.pedestrian || address.residential || '';
    const city = cityFrom(address);
    const state = address.state || '';
    const stateCode = String(address['ISO3166-2-lvl4'] || '').replace(/^US-/, '');
    const zip = address.postcode || '';
    const inputWords = normalizeWords(originalText);
    const inputText = ` ${inputWords.join(' ')} `;
    const numericMatches = String(originalText || '').match(/\b\d{5}(?:-\d{4})?\b/g) || [];
    const inputZip = [...numericMatches].reverse().find(value => value.slice(0, 5) !== number) || '';

    if (!number || !street || !city || !state) {
        return { verified: false, reason: 'OpenStreetMap result is missing exact address components' };
    }
    if (!new RegExp(`(^|\\D)${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\D|$)`).test(originalText)) {
        return { verified: false, reason: 'House number does not match' };
    }
    if (!containsWords(inputWords, normalizeWords(street))) {
        return { verified: false, reason: 'Street does not match' };
    }
    if (!containsWords(inputWords, normalizeWords(city))) {
        return { verified: false, reason: 'City does not match' };
    }
    const stateMatches = (stateCode && inputText.includes(` ${stateCode.toLowerCase()} `))
        || containsWords(inputWords, normalizeWords(state));
    if (!stateMatches) {
        return { verified: false, reason: 'State does not match' };
    }
    if (inputZip && (!zip || !zip.startsWith(inputZip.slice(0, 5)))) {
        return { verified: false, reason: 'Postal code does not match' };
    }

    return {
        verified: true,
        provider: 'OpenStreetMap Nominatim â€¢ Â© OpenStreetMap contributors',
        displayName: result.display_name || `${number} ${street}, ${city}, ${state}`,
        type: 'street_address',
        confidence: 1,
        street,
        number,
        city,
        state: stateCode || state,
        zip,
        country: address.country || '',
        placeId: String(result.place_id || ''),
    };
}

function parseCensusResult(match, originalText) {
    const components = match?.addressComponents || {};
    const matchedAddress = match?.matchedAddress || '';
    const inputWords = normalizeWords(originalText);
    const matchedWords = normalizeWords(matchedAddress);
    const inputNumber = String(originalText || '').trim().match(/^(\d+[a-z]?)/i)?.[1] || '';
    const matchedNumber = matchedAddress.trim().match(/^(\d+[a-z]?)/i)?.[1] || '';
    const streetNameWords = normalizeWords(components.streetName);
    const cityWords = normalizeWords(components.city);
    const state = String(components.state || '').toLowerCase();
    const zip = String(components.zip || '');
    const inputZipMatches = String(originalText || '').match(/\b\d{5}(?:-\d{4})?\b/g) || [];
    const inputZip = [...inputZipMatches].reverse().find(value => value.slice(0, 5) !== inputNumber) || '';

    if (!inputNumber || !matchedNumber || inputNumber.toLowerCase() !== matchedNumber.toLowerCase()) {
        return { verified: false, reason: 'Census house number does not match' };
    }
    if (!streetNameWords.length || !containsWords(inputWords, streetNameWords)) {
        return { verified: false, reason: 'Census street does not match' };
    }
    if (!cityWords.length || !containsWords(inputWords, cityWords)) {
        return { verified: false, reason: 'Census city does not match' };
    }
    if (!state || !inputWords.includes(state)) {
        return { verified: false, reason: 'Census state does not match' };
    }
    if (inputZip && (!zip || zip.slice(0, 5) !== inputZip.slice(0, 5))) {
        return { verified: false, reason: 'Census postal code does not match' };
    }
    if (!matchedWords.includes(matchedNumber.toLowerCase())) {
        return { verified: false, reason: 'Census result is not a complete address' };
    }

    return {
        verified: true,
        provider: 'U.S. Census Geocoder',
        displayName: matchedAddress,
        type: 'street_address',
        confidence: 1,
        street: [components.preDirection, components.preType, components.streetName, components.suffixType]
            .filter(Boolean).join(' '),
        number: matchedNumber,
        city: components.city || '',
        state: components.state || '',
        zip,
        country: 'United States',
        coordinates: match.coordinates || null,
    };
}

async function waitForRateLimit() {
    const waitMs = Math.max(0, 1000 - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
}

async function verifyAddressWithCensus(text, fetchImpl, timeoutMs) {
    const url = new URL(CENSUS_URL);
    url.searchParams.set('address', text);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
        if (!response.ok) return { verified: false, reason: `Census HTTP ${response.status}` };
        const data = await response.json();
        for (const match of data?.result?.addressMatches || []) {
            const parsed = parseCensusResult(match, text);
            if (parsed.verified) return parsed;
        }
        return { verified: false, reason: 'No exact U.S. Census address match' };
    } catch (error) {
        return {
            verified: false,
            reason: error.name === 'AbortError' ? 'Census request timed out' : `Census request failed: ${error.message}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function verifyAddressWithFreeGeocoders(text, { fetchImpl = globalThis.fetch, timeoutMs = 7000 } = {}) {
    if (typeof fetchImpl !== 'function') return { verified: false, reason: 'HTTP client unavailable' };

    const cacheKey = String(text || '').trim().toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.result;

    const performLookup = async () => {
        await waitForRateLimit();
        const url = new URL(NOMINATIM_URL);
        url.searchParams.set('q', text);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('addressdetails', '1');
        url.searchParams.set('countrycodes', 'us');
        url.searchParams.set('limit', '3');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            });
            if (!response.ok) return verifyAddressWithCensus(text, fetchImpl, timeoutMs);

            const results = await response.json();
            for (const result of results || []) {
                const parsed = parseNominatimResult(result, text);
                if (parsed.verified) return parsed;
            }
            return verifyAddressWithCensus(text, fetchImpl, timeoutMs);
        } catch (_error) {
            return verifyAddressWithCensus(text, fetchImpl, timeoutMs);
        } finally {
            clearTimeout(timer);
        }
    };

    const lookup = requestChain.then(performLookup, performLookup);
    requestChain = lookup.then(() => undefined, () => undefined);
    const result = await lookup;
    cache.set(cacheKey, { savedAt: Date.now(), result });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return result;
}

module.exports = {
    parseCensusResult,
    parseNominatimResult,
    verifyAddressWithFreeGeocoders,
};

