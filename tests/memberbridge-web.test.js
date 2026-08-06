'use strict';

const assert = require('assert');
const { MemberBridgeWeb } = require('../memberbridge/web');

(async () => {
    const web = new MemberBridgeWeb({
        store: { integrityCheck: () => true },
        youtube: {},
        engine: {},
        config: {
            enabled: true,
            publicBaseUrl: 'http://127.0.0.1',
            productionMode: false,
            simulationMode: false,
            callbackHost: '127.0.0.1',
            callbackPort: 0
        }
    });

    const address = await web.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        for (const [path, heading] of [
            ['/', 'Membership verification'],
            ['/terms', 'Terms of Service'],
            ['/terms-of-service', 'Terms of Service'],
            ['/privacy', 'Privacy Policy'],
            ['/privacy-policy', 'Privacy Policy']
        ]) {
            const response = await fetch(`${baseUrl}${path}`);
            const body = await response.text();
            assert.equal(response.status, 200, `${path} should return HTTP 200`);
            assert.match(body, new RegExp(`<h1>${heading}</h1>`));
            assert.match(body, /href="\/terms"/);
            assert.match(body, /href="\/privacy-policy"/);
        }
    } finally {
        await web.stop();
    }

    console.log('MemberBridge public legal page tests passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
