let cryptoKey = null;

export async function initE2EEKeys() {
    try {
        // Deterministic shared vault key derived via PBKDF2 so cross-browser nodes can decrypt E2EE payloads
        const enc = new TextEncoder();
        const baseKey = await window.crypto.subtle.importKey(
            "raw",
            enc.encode("voicepulse_zero_metadata_vault_v1"),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        cryptoKey = await window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode("vp_salt_2026"),
                iterations: 100000,
                hash: "SHA-256"
            },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    } catch (e) {
        console.warn("Web Crypto API unavailable:", e);
    }
}

export async function hashStringSHA256(str) {
    const encoded = new TextEncoder().encode(str);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function encryptPayload(plaintext) {
    if (!cryptoKey) return plaintext;
    try {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(plaintext);
        const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
        return { iv: Array.from(iv), data: Array.from(new Uint8Array(ciphertext)) };
    } catch (e) {
        return plaintext;
    }
}

export async function decryptPayload(encryptedObj) {
    if (!cryptoKey || typeof encryptedObj !== 'object' || !encryptedObj.iv) return encryptedObj;
    try {
        const iv = new Uint8Array(encryptedObj.iv);
        const data = new Uint8Array(encryptedObj.data);
        const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, data);
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        return "[Encrypted Message]";
    }
}