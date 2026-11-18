import { firebaseConfig, APP_CONSTANTS } from './config.js';
import { hashStringSHA256 } from './crypto.js';

let firestoreDb = null;
let isCloudActive = false;
const bc = new BroadcastChannel('voicepulse_e2ee_matrix_prod_v1');

export async function initSyncEngine(onEventCallback) {
    bc.onmessage = (ev) => onEventCallback(ev.data);

    const isPlaceholder = !firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY";
    const statusEl = document.getElementById('sync-mode-indicator');

    if (!isPlaceholder) {
        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js");
            const { getAuth, signInAnonymously } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js");
            const { getFirestore, collection, onSnapshot, query, orderBy, limit } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");

            const app = initializeApp(firebaseConfig);
            const auth = getAuth(app);
            await signInAnonymously(auth);
            firestoreDb = getFirestore(app);
            isCloudActive = true;

            if (statusEl) statusEl.textContent = "Cloud E2EE Relay Connected (Spark Free Tier)";

            // Run free client-side TTL cleanup immediately on connect and every 15 minutes
            purgeExpiredCloudRecords();
            setInterval(purgeExpiredCloudRecords, 15 * 60 * 1000);

            const q = query(collection(firestoreDb, "vp_events"), orderBy("ts", "desc"), limit(25));
            let initialLoad = true;
            onSnapshot(q, (snapshot) => {
                if (initialLoad) {
                    initialLoad = false;
                    return;
                }
                snapshot.docChanges().forEach(change => {
                    if (change.type === "added") {
                        const data = change.doc.data();
                        // Ignore if already expired
                        if (data.expiresAtMs && Date.now() > data.expiresAtMs) return;
                        onEventCallback(data.payload);
                    }
                });
            });
            return;
        } catch (err) {
            console.warn("Firestore unavailable, using Local BroadcastChannel:", err);
        }
    }

    if (statusEl) statusEl.textContent = "Local Multi-Tab Sync Ready";
}

// 100% Free Spark-Plan TTL Auto-Purge (72h Messages & 6-Month Inactive Channels)
export async function purgeExpiredCloudRecords() {
    if (!isCloudActive || !firestoreDb) return;
    try {
        const { collection, query, where, getDocs, deleteDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const now = Date.now();

        // 1. Delete all events/messages past their TTL (max 72 hours)
        const expiredEventsQuery = query(
            collection(firestoreDb, "vp_events"),
            where("expiresAtMs", "<=", now)
        );
        const eventSnaps = await getDocs(expiredEventsQuery);
        eventSnaps.forEach(docSnap => {
            deleteDoc(docSnap.ref).catch(() => {});
        });

        // 2. Delete any custom channel documents inactive for > 6 months
        const sixMonthsCutoff = now - APP_CONSTANTS.CHANNEL_INACTIVITY_MS;
        const inactiveChannelsQuery = query(
            collection(firestoreDb, "vp_channels"),
            where("lastActive", "<=", sixMonthsCutoff)
        );
        const chanSnaps = await getDocs(inactiveChannelsQuery);
        chanSnaps.forEach(docSnap => {
            deleteDoc(docSnap.ref).catch(() => {});
        });
    } catch (e) {}
}

export async function broadcastEvent(payload) {
    bc.postMessage(payload);
    if (isCloudActive && firestoreDb) {
        try {
            const { collection, addDoc, doc, setDoc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");

            // Calculate custom message TTL or default to 72 hours max
            const ttlHours = (payload.message && payload.message.ttl)
                ? Math.min(payload.message.ttl, APP_CONSTANTS.MAX_MESSAGE_TTL_HOURS)
                : APP_CONSTANTS.MAX_MESSAGE_TTL_HOURS;
            const expiresAtMs = Date.now() + (ttlHours * 3600 * 1000);

            await addDoc(collection(firestoreDb, "vp_events"), {
                payload,
                ts: Date.now(),
                expiresAtMs
            });

            // Track channel creation / activity in vp_channels for 6-month auto-purge
            if (payload.type === 'CHANNEL_CREATED' && payload.room) {
                await setDoc(doc(firestoreDb, "vp_channels", payload.room.id), {
                    ...payload.room,
                    lastActive: Date.now()
                });
            } else if (payload.type === 'CHAT_MESSAGE' && payload.roomId && payload.roomId !== 'public-lobby') {
                await setDoc(doc(firestoreDb, "vp_channels", payload.roomId), {
                    lastActive: Date.now()
                }, { merge: true });
            } else if (payload.type === 'CHANNEL_DELETED' && payload.roomId) {
                await deleteDoc(doc(firestoreDb, "vp_channels", payload.roomId));
            }
        } catch (e) {}
    }
}

export async function verifyOrRegisterAccount(username, plaintextPassword) {
    const key = username.trim().toLowerCase();
    const userHash = await hashStringSHA256(key + "_vp_user_salt");
    const passHash = await hashStringSHA256(plaintextPassword + "_vp_salt");

    // Zero-knowledge admin check: neither username nor password exists in plaintext
    if (userHash === APP_CONSTANTS.ADMIN_USER_HASH) {
        if (passHash !== APP_CONSTANTS.ADMIN_PASS_HASH) {
            return { ok: false, error: "Invalid credentials." };
        }
        return { ok: true, isAdmin: true };
    }

    if (isCloudActive && firestoreDb) {
        try {
            const { doc, getDoc, setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
            const ref = doc(firestoreDb, "vp_accounts", key);
            const snap = await getDoc(ref);
            if (snap.exists()) {
                if (snap.data().passwordHash !== passHash) {
                    return { ok: false, error: "Passphrase mismatch for existing handle." };
                }
                return { ok: true, isAdmin: Boolean(snap.data().isAdmin) };
            } else {
                await setDoc(ref, { passwordHash: passHash, isAdmin: false, createdAt: Date.now() });
                return { ok: true, isAdmin: false };
            }
        } catch (e) {}
    }

    const registry = JSON.parse(localStorage.getItem('vp_accounts_v1') || '{}');
    if (registry[key]) {
        if (registry[key].passwordHash !== passHash) {
            return { ok: false, error: "Passphrase mismatch for existing handle." };
        }
        return { ok: true, isAdmin: Boolean(registry[key].isAdmin) };
    } else {
        registry[key] = { passwordHash: passHash, isAdmin: false };
        localStorage.setItem('vp_accounts_v1', JSON.stringify(registry));
        return { ok: true, isAdmin: false };
    }
}
