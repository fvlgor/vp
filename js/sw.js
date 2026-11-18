self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    const title = 'VoicePulse Vault';
    const options = {
        body: 'Encrypted activity received in your channel.',
        tag: 'vp-activity'
    };
    event.waitUntil(self.registration.showNotification(title, options));
});