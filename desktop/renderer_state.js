'use strict';

const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const loginForm = document.getElementById('loginForm');
const loginPassword = document.getElementById('loginPassword');
const rememberLogin = document.getElementById('rememberLogin');
const loginError = document.getElementById('loginError');
const settingsForm = document.getElementById('settingsForm');
const toast = document.getElementById('toast');
const logConsole = document.getElementById('logConsole');

let currentStatus = { state: 'stopped', dashboardReady: false, logs: [] };
let toastTimer;
let savedBlueprints = [];
let availableGuilds = [];
let pendingEconomyResetToken = '';
let pendingBulkGrantToken = '';
let memberBridgeCreators = [];
let memberBridgeRoles = [];
let memberBridgeLevels = [];
