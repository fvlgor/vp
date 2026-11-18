export const firebaseConfig = {
    apiKey: "AIzaSyD6VxVr8KY4_e4oRR3c4MwErrz1qFfvv4o",
    authDomain: "voicepulse-9b68e.firebaseapp.com",
    projectId: "voicepulse-9b68e",
    storageBucket: "voicepulse-9b68e.firebasestorage.app",
    messagingSenderId: "946322910949",
    appId: "1:946322910949:web:5e260c2b5dac0e4f882e0c"
};

export const APP_CONSTANTS = {
    ADMIN_USERNAME: 'c6514b064415f7736e61a99588a41e82516d0c091a512a5e01869b4e38661477',
    ADMIN_DEFAULT_PASS: 'a447863433529f425c1dae87ad48390e4a6b0f92ecfe1e7ac8617ebd10f154fc',
    MAX_MESSAGE_TTL_HOURS: 72,
    CHANNEL_INACTIVITY_MS: 180 * 24 * 3600 * 1000, // 6 Months
    AUTOBURN_DELAY_MS: 120000, // 120 Seconds
    ADJECTIVES: ['Swift', 'Cosmic', 'Silent', 'Bold', 'Neon', 'Cyber', 'Shadow', 'Solar', 'Quantum', 'Hyper'],
    NOUNS: ['Falcon', 'Tiger', 'Wizard', 'Ninja', 'Ghost', 'Phoenix', 'Rider', 'Voyager', 'Spark', 'Titan']
};

export function generateRandomName() {
    const adj = APP_CONSTANTS.ADJECTIVES[Math.floor(Math.random() * APP_CONSTANTS.ADJECTIVES.length)];
    const noun = APP_CONSTANTS.NOUNS[Math.floor(Math.random() * APP_CONSTANTS.NOUNS.length)];
    return `${adj}-${noun}-${Math.floor(Math.random() * 899) + 100}`;
}
