'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

function generateDashboardHTML() {
    return dashboardHtml;
}

module.exports = { generateDashboardHTML };
