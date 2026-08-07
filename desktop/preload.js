const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commission', {
    bootstrap: () => ipcRenderer.invoke('auth:bootstrap'),
    login: credentials => ipcRenderer.invoke('auth:login', credentials),
    lock: () => ipcRenderer.invoke('auth:lock'),
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: payload => ipcRenderer.invoke('config:save', payload),
    startBot: () => ipcRenderer.invoke('bot:start'),
    stopBot: () => ipcRenderer.invoke('bot:stop'),
    getStatus: () => ipcRenderer.invoke('bot:status'),
    openDashboard: () => ipcRenderer.invoke('bot:open-dashboard'),
    openDataFolder: () => ipcRenderer.invoke('system:open-data'),
    getEconomyStats: () => ipcRenderer.invoke('economy:stats'),
    getEconomyLeaderboard: type => ipcRenderer.invoke('economy:leaderboard', type),
    pushHeistPanel: () => ipcRenderer.invoke('economy:push-heist'),
    previewEconomyReset: payload => ipcRenderer.invoke('economy:reset-preview', payload),
    executeEconomyReset: token => ipcRenderer.invoke('economy:reset-execute', token),
    previewBulkGrant: amount => ipcRenderer.invoke('economy:bulk-grant-preview', amount),
    executeBulkGrant: token => ipcRenderer.invoke('economy:bulk-grant-execute', token),
    listGuilds: () => ipcRenderer.invoke('blueprint:list-guilds'),
    listBlueprints: () => ipcRenderer.invoke('blueprint:list'),
    captureBlueprint: guildId => ipcRenderer.invoke('blueprint:capture', guildId),
    applyBlueprint: payload => ipcRenderer.invoke('blueprint:apply', payload),
    onStatus: callback => ipcRenderer.on('bot:status', (_event, value) => callback(value)),
    onLog: callback => ipcRenderer.on('bot:log', (_event, value) => callback(value)),
});

// MemberBridge is retired from The Commission. Keep the legacy markup out of
// the desktop navigation even on installs that still have an older index.html.
window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-page-target="memberbridge"], [data-page="memberbridge"]').forEach(element => {
        element.remove();
    });
});
