import { APP_CONSTANTS, generateRandomName } from './config.js';
import { initE2EEKeys, encryptPayload, decryptPayload } from './crypto.js';
import {
    activeAudioElements,
    requestInitialAudioPermissions,
    generateDetailedWaveformPeaks,
    drawMessageWaveformCanvas,
    startPerMessageWaveformAnimationLoop,
    beginPTTRecording,
    endPTTRecording,
    playBeepNotification,
    setOnClipReadyCallback
} from './audio.js';
import { initSyncEngine, broadcastEvent, verifyOrRegisterAccount } from './sync.js';

let isAuthenticated = false;
let currentUser = {
    id: 'node_' + Math.random().toString(36).substring(2, 9),
    name: '',
    isAdmin: false,
    isSpeaking: false,
    currentRoom: 'public-lobby',
    device: /Mobile|iP(hone|od|ad)|Android/i.test(navigator.userAgent) ? 'Mobile Terminal' : 'Desktop Workstation',
    os: navigator.platform || 'Unknown OS',
    browser: (function() {
        const ua = navigator.userAgent;
        if (ua.includes("Firefox")) return "Firefox";
        if (ua.includes("Edg")) return "Edge";
        if (ua.includes("Chrome")) return "Chrome";
        if (ua.includes("Safari")) return "Safari";
        return "Standard Browser";
    })(),
    resolution: `${window.screen.width}x${window.screen.height}`,
    cores: navigator.hardwareConcurrency || 4,
    locale: navigator.language || 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ipApproximation: '10.24.' + Math.floor(Math.random() * 254) + '.' + Math.floor(Math.random() * 254),
    connectionTime: new Date().toLocaleTimeString()
};

let rooms = [
    { id: 'public-lobby', name: 'Public Channel', desc: 'Anonymized public room. All senders masked as ANON.', icon: 'fa-globe', password: '', createdAt: Date.now(), lastActive: Date.now() }
];

let joinedRoomIds = new Set(['public-lobby']);
let currentRoomId = 'public-lobby';
let activeTab = 'feed';
let chatMessages = {};
let roomUsers = {};
let unreadChatCount = {};
let p2pChats = {};
let activeP2PSessionId = null;
let blockedPeers = {};
let kickedNodeIds = {};
let globalMaintenanceLock = false;
let publicChannelUsable = true;

let currentTheme = 'cli';
let cliColors = { text: '#ff0000', bg: '#050000' };
let isSidebarCollapsed = false;

window.onload = async function() {
    applyCliThemeColors();
    fillRandomAuthHandle();
    await initE2EEKeys();
    requestInitialAudioPermissions();
    initDataStores();
    setOnClipReadyCallback(sendAudioClipMessage);
    await initSyncEngine(handleIncomingData);
    setupPTTEvents();
    startPerMessageWaveformAnimationLoop(() => ({ currentTheme, cliColors }));

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    if (window.innerWidth < 768) toggleSidebarCollapse();

    setInterval(() => {
        if (isAuthenticated) broadcastPresence();
    }, 3000);
    setInterval(enforceTTLPolicies, 30000);

    window.addEventListener('beforeunload', () => {
        if (isAuthenticated) {
            broadcastEvent({ type: 'USER_LEAVE', user: currentUser, roomId: currentRoomId });
        }
    });
};

function fillRandomAuthHandle() {
    const input = document.getElementById('gate-username');
    if (input) input.value = generateRandomName();
}

async function handleInitialAuthSubmit(e) {
    e.preventDefault();
    const handleInput = document.getElementById('gate-username').value.trim();
    const passInput = document.getElementById('gate-password').value;
    const errBox = document.getElementById('gate-error-msg');

    if (!handleInput || !passInput) return;
    errBox.classList.add('hidden');

    const res = await verifyOrRegisterAccount(handleInput, passInput);
    if (!res.ok) {
        errBox.textContent = res.error;
        errBox.classList.remove('hidden');
        return;
    }

    completeUserSessionSetup(handleInput, res.isAdmin);
    document.getElementById('auth-gate').classList.add('hidden');

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
    }
}

function completeUserSessionSetup(handleInput, isAdminFlag) {
    isAuthenticated = true;
    if (isAdminFlag) {
        currentUser.isAdmin = true;
        currentUser.name = generateRandomName(); // Disguised public handle for Stealth Admin
        document.getElementById('admin-console-btn').classList.remove('hidden');
        document.getElementById('admin-console-btn').classList.add('flex');
    } else {
        currentUser.isAdmin = false;
        currentUser.name = handleInput;
        document.getElementById('admin-console-btn').classList.add('hidden');
        document.getElementById('admin-console-btn').classList.remove('flex');
    }

    document.getElementById('user-name-display').textContent = currentUser.name;
    renderRoomsList();
    switchRoom(currentRoomId, true);
    switchTab('feed');
    broadcastPresence();
}

function initDataStores() {
    rooms.forEach(r => {
        chatMessages[r.id] = [
            { id: 'sys_' + r.id, sender: 'System', text: `Channel [${r.name}] initialized. 72h TTL & E2EE active. Text/File only (PTT disabled on public/passwordless channels).`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true, ttl: 72 }
        ];
        roomUsers[r.id] = [];
        unreadChatCount[r.id] = 0;
    });
}

function enforceTTLPolicies() {
    const now = Date.now();
    const maxMsgAgeMs = APP_CONSTANTS.MAX_MESSAGE_TTL_HOURS * 3600 * 1000;

    Object.keys(chatMessages).forEach(rId => {
        chatMessages[rId] = (chatMessages[rId] || []).filter(m => {
            if (m.isSystem) return true;
            const ttlMs = (m.ttl || 72) * 3600 * 1000;
            return (now - (m.timestamp || now)) < Math.min(ttlMs, maxMsgAgeMs);
        });
    });

    Object.keys(p2pChats).forEach(sId => {
        if (p2pChats[sId].messages) {
            p2pChats[sId].messages = p2pChats[sId].messages.filter(m => {
                if (m.isSystem) return true;
                const ttlMs = (m.ttl || 72) * 3600 * 1000;
                return (now - (m.timestamp || now)) < Math.min(ttlMs, maxMsgAgeMs);
            });
        }
    });

    rooms = rooms.filter(r => r.id === 'public-lobby' || (now - (r.lastActive || now)) < APP_CONSTANTS.CHANNEL_INACTIVITY_MS);
    renderRoomsList();
    renderChatMessages();
}

async function handleIncomingData(data) {
    if (!data || !isAuthenticated) return;
    if (kickedNodeIds[currentUser.id]) return;
    if (blockedPeers[data.senderId] || blockedPeers[data.userId]) return;

    switch (data.type) {
        case 'PRESENCE':
            if (!roomUsers[data.roomId]) roomUsers[data.roomId] = [];
            const idx = roomUsers[data.roomId].findIndex(u => u.id === data.user.id);
            if (idx >= 0) roomUsers[data.roomId][idx] = data.user;
            else roomUsers[data.roomId].push(data.user);
            updateOnlineCounter();
            if (data.roomId === currentRoomId && activeTab === 'users') renderOnlineUsers();
            break;

        case 'USER_LEAVE':
            if (roomUsers[data.roomId]) {
                roomUsers[data.roomId] = roomUsers[data.roomId].filter(u => u.id !== data.user.id);
                updateOnlineCounter();
                if (data.roomId === currentRoomId && activeTab === 'users') renderOnlineUsers();
            }
            break;

        case 'CHANNEL_CREATED':
            if (!rooms.some(r => r.id === data.room.id)) {
                rooms.push(data.room);
                chatMessages[data.room.id] = [{ id: 'sys_' + data.room.id, sender: 'System', text: `Channel ${data.room.name} established.`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true, ttl: 72 }];
                roomUsers[data.room.id] = [];
                unreadChatCount[data.room.id] = 0;
                renderRoomsList();
            }
            break;

        case 'CHANNEL_DELETED':
            rooms = rooms.filter(r => r.id !== data.roomId);
            delete chatMessages[data.roomId];
            joinedRoomIds.delete(data.roomId);
            if (currentRoomId === data.roomId) switchRoom('public-lobby');
            else renderRoomsList();
            break;

        case 'CHAT_MESSAGE':
            if (!chatMessages[data.roomId]) chatMessages[data.roomId] = [];
            if (!chatMessages[data.roomId].some(m => m.id === data.message.id)) {
                let decryptedMsg = { ...data.message };
                if (typeof decryptedMsg.text === 'object') {
                    decryptedMsg.text = await decryptPayload(decryptedMsg.text);
                }
                chatMessages[data.roomId].push(decryptedMsg);

                const targetRoom = rooms.find(r => r.id === data.roomId);
                if (targetRoom) targetRoom.lastActive = Date.now();

                const isViewingThisRoomFeed = (data.roomId === currentRoomId && activeTab === 'feed' && !activeP2PSessionId);
                if (isViewingThisRoomFeed) {
                    unreadChatCount[data.roomId] = 0;
                    renderChatMessages();
                    scrollToBottomChat();
                    playBeepNotification(880, 0.06);
                } else if (joinedRoomIds.has(data.roomId)) {
                    unreadChatCount[data.roomId] = (unreadChatCount[data.roomId] || 0) + 1;
                    updateChatBadge();
                    renderRoomsList();
                    playBeepNotification(880, 0.08);
                    updateTabTitleAlert();
                }

                if (decryptedMsg.audioData && decryptedMsg.senderId !== currentUser.id && joinedRoomIds.has(data.roomId)) {
                    playIncomingAudioRealtime(decryptedMsg);
                }
            }
            break;

        case 'PTT_STATE':
            if (roomUsers[data.roomId]) {
                const u = roomUsers[data.roomId].find(user => user.id === data.userId);
                if (u) {
                    u.isSpeaking = data.isSpeaking;
                    if (data.roomId === currentRoomId && activeTab === 'users') renderOnlineUsers();
                    if (joinedRoomIds.has(data.roomId)) {
                        const ind = document.getElementById('ptt-live-indicator');
                        if (data.isSpeaking) {
                            ind.textContent = `[LIVE PTT: ${u.name}]`;
                            playBeepNotification(620, 0.05);
                        } else {
                            ind.textContent = 'AES-GCM-256 E2EE';
                        }
                    }
                }
            }
            break;

        case 'P2P_REQUEST':
            if (data.targetName && data.targetName.toLowerCase() === currentUser.name.toLowerCase()) {
                openP2PApprovalModal(data);
            }
            break;

        case 'P2P_APPROVED':
            if (p2pChats[data.sessionId] || data.initiatorId === currentUser.id) {
                upsertP2PSession(data.sessionId, data.members);
                if (data.initiatorId === currentUser.id) {
                    switchToP2PChat(data.sessionId);
                } else {
                    renderRoomsList();
                    if (activeP2PSessionId === data.sessionId) renderOnlineUsers();
                }
            }
            break;

        case 'P2P_MESSAGE':
            const session = p2pChats[data.sessionId];
            const isMember = session || (data.members && data.members.some(m => m.id === currentUser.id));
            if (isMember && data.senderId !== currentUser.id) {
                if (!p2pChats[data.sessionId]) {
                    upsertP2PSession(data.sessionId, data.members);
                }
                let decryptedMsg = { ...data.message };
                if (typeof decryptedMsg.text === 'object') {
                    decryptedMsg.text = await decryptPayload(decryptedMsg.text);
                }
                p2pChats[data.sessionId].messages.push(decryptedMsg);

                if (activeP2PSessionId === data.sessionId && activeTab === 'feed') {
                    p2pChats[data.sessionId].unread = 0;
                    renderChatMessages();
                    scrollToBottomChat();
                    playBeepNotification(920, 0.06);
                } else {
                    p2pChats[data.sessionId].unread = (p2pChats[data.sessionId].unread || 0) + 1;
                    renderRoomsList();
                    playBeepNotification(920, 0.08);
                    updateTabTitleAlert();
                }

                if (decryptedMsg.audioData) {
                    playIncomingAudioRealtime(decryptedMsg);
                }
            }
            break;

        case 'DELETE_MESSAGE':
            if (chatMessages[data.roomId]) {
                chatMessages[data.roomId] = chatMessages[data.roomId].filter(m => m.id !== data.messageId);
                if (data.roomId === currentRoomId && activeTab === 'feed' && !activeP2PSessionId) renderChatMessages();
            }
            Object.keys(p2pChats).forEach(sId => {
                if (p2pChats[sId].messages) {
                    p2pChats[sId].messages = p2pChats[sId].messages.filter(m => m.id !== data.messageId);
                    if (activeP2PSessionId === sId) renderChatMessages();
                }
            });
            break;

        case 'ADMIN_ACTION':
            executeRemoteAdminCommand(data);
            break;
    }
}

function broadcastPresence() {
    if (kickedNodeIds[currentUser.id] || !isAuthenticated) return;
    currentUser.currentRoom = currentRoomId;
    broadcastEvent({ type: 'PRESENCE', user: currentUser, roomId: currentRoomId });
}

function canCurrentChannelUsePTT() {
    if (activeP2PSessionId) return true;
    const room = rooms.find(r => r.id === currentRoomId);
    return Boolean(room && room.password && room.password.length > 0);
}

function updateChannelInputAndPTTState() {
    const pttBtn = document.getElementById('ptt-button');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-msg-btn');

    const isPublicLobbyDisabled = (currentRoomId === 'public-lobby' && !activeP2PSessionId && !publicChannelUsable && !currentUser.isAdmin);
    const isLocked = globalMaintenanceLock && !currentUser.isAdmin;

    if (isPublicLobbyDisabled || isLocked) {
        chatInput.disabled = true;
        chatInput.placeholder = isPublicLobbyDisabled ? "Public Channel disabled by administrator..." : "Platform locked for maintenance...";
        sendBtn.disabled = true;
    } else {
        chatInput.disabled = false;
        chatInput.placeholder = "Transmit encrypted message...";
        sendBtn.disabled = false;
    }

    if (canCurrentChannelUsePTT() && !isLocked) {
        pttBtn.classList.remove('hidden');
        pttBtn.classList.add('flex');
    } else {
        pttBtn.classList.add('hidden');
        pttBtn.classList.remove('flex');
    }
}

function setupPTTEvents() {
    const pttBtn = document.getElementById('ptt-button');
    pttBtn.addEventListener('mousedown', startSpeaking);
    window.addEventListener('mouseup', stopSpeaking);
    pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startSpeaking(); });
    window.addEventListener('touchend', stopSpeaking);

    window.addEventListener('keydown', (e) => {
        if (!isAuthenticated) return;
        if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !currentUser.isSpeaking) {
            if (!canCurrentChannelUsePTT()) return;
            e.preventDefault();
            startSpeaking();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && currentUser.isSpeaking) {
            e.preventDefault();
            stopSpeaking();
        }
    });
}

async function startSpeaking() {
    if (!canCurrentChannelUsePTT()) {
        showToast('PTT is disabled on public and passwordless channels.', 'error');
        return;
    }
    if (currentUser.isSpeaking || (globalMaintenanceLock && !currentUser.isAdmin)) return;
    currentUser.isSpeaking = true;

    document.getElementById('ptt-btn-text').textContent = 'TX LIVE...';
    document.getElementById('ptt-live-indicator').textContent = '[TRANSMITTING PTT AUDIO...]';
    playBeepNotification(640, 0.08);

    await beginPTTRecording();
    broadcastEvent({ type: 'PTT_STATE', userId: currentUser.id, isSpeaking: true, roomId: currentRoomId });
}

function stopSpeaking() {
    if (!currentUser.isSpeaking) return;
    currentUser.isSpeaking = false;

    document.getElementById('ptt-btn-text').textContent = 'HOLD PTT';
    document.getElementById('ptt-live-indicator').textContent = 'AES-GCM-256 E2EE';
    playBeepNotification(340, 0.08);

    endPTTRecording();
    broadcastEvent({ type: 'PTT_STATE', userId: currentUser.id, isSpeaking: false, roomId: currentRoomId });
}

function playIncomingAudioRealtime(msg) {
    if (!activeAudioElements[msg.id]) {
        const aEl = new Audio(msg.audioData);
        activeAudioElements[msg.id] = {
            audio: aEl,
            isPlaying: false,
            progress: 0,
            peaks: msg.waveformPeaks || generateDetailedWaveformPeaks(48)
        };
    }
    const entry = activeAudioElements[msg.id];
    entry.isPlaying = true;
    entry.audio.currentTime = 0;

    const icon = document.getElementById(`play-icon-${msg.id}`);
    const lbl = document.getElementById(`audio-label-${msg.id}`);
    if (icon) icon.className = 'fa-solid fa-stop';
    if (lbl) lbl.textContent = 'LIVE';

    entry.audio.onended = () => {
        entry.isPlaying = false;
        entry.progress = 0;
        const ic = document.getElementById(`play-icon-${msg.id}`);
        const lb = document.getElementById(`audio-label-${msg.id}`);
        if (ic) ic.className = 'fa-solid fa-play';
        if (lb) lb.textContent = 'PLAY';
        drawMessageWaveformCanvas(msg.id, currentTheme, cliColors);
        triggerAutoburnIfEnabled(msg.id, msg.burnOnRead);
    };
    entry.audio.play().catch(() => {
        entry.isPlaying = false;
        drawMessageWaveformCanvas(msg.id, currentTheme, cliColors);
    });
}

function toggleCustomAudioClip(msgId) {
    const entry = activeAudioElements[msgId];
    if (!entry) return;
    const btnIcon = document.getElementById(`play-icon-${msgId}`);
    const statusLabel = document.getElementById(`audio-label-${msgId}`);

    if (!entry.isPlaying) {
        entry.isPlaying = true;
        if (btnIcon) btnIcon.className = 'fa-solid fa-stop';
        if (statusLabel) statusLabel.textContent = 'STOP';
        entry.audio.play().catch(() => {});
    } else {
        entry.audio.pause();
        entry.audio.currentTime = 0;
        entry.isPlaying = false;
        entry.progress = 0;
        if (btnIcon) btnIcon.className = 'fa-solid fa-play';
        if (statusLabel) statusLabel.textContent = 'PLAY';
        drawMessageWaveformCanvas(msgId, currentTheme, cliColors);
    }
}

function toggleThemeMode() {
    if (currentTheme === 'modern') {
        currentTheme = 'cli';
        applyCliThemeColors();
        document.getElementById('theme-name').textContent = 'Modern Mode';
        document.body.classList.add('cli-font', 'cli-mode');
    } else {
        currentTheme = 'modern';
        resetThemeColors();
        document.getElementById('theme-name').textContent = 'CLI Mode';
        document.body.classList.remove('cli-font', 'cli-mode');
    }
    switchTab(activeTab);
    renderRoomsList();
    renderChatMessages();
    renderOnlineUsers();
}

function applyCliThemeColors() {
    const root = document.documentElement;
    root.style.setProperty('--cli-bg', cliColors.bg);
    root.style.setProperty('--cli-text', cliColors.text);
    document.getElementById('app-body').style.backgroundColor = cliColors.bg;
    document.getElementById('app-body').style.color = cliColors.text;
}

function resetThemeColors() {
    document.documentElement.style.removeProperty('--cli-bg');
    document.documentElement.style.removeProperty('--cli-text');
    document.getElementById('app-body').style.backgroundColor = '';
    document.getElementById('app-body').style.color = '';
}

function openCLIColorModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'CLI Phosphor Customizer';
    document.getElementById('modal-desc').textContent = 'Select foreground phosphor color and terminal background color.';
    document.getElementById('modal-content').innerHTML = `
        <div class="space-y-4">
            <div>
                <label class="text-xs font-bold block mb-1">Phosphor Foreground / Button Fill Color</label>
                <input type="color" id="cli-text-color" value="${cliColors.text}" class="w-full h-10 rounded cursor-pointer border">
            </div>
            <div>
                <label class="text-xs font-bold block mb-1">Terminal Background Color</label>
                <input type="color" id="cli-bg-color" value="${cliColors.bg}" class="w-full h-10 rounded cursor-pointer border">
            </div>
        </div>
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Apply Phosphor';
    document.getElementById('modal-confirm').onclick = function() {
        cliColors.text = document.getElementById('cli-text-color').value;
        cliColors.bg = document.getElementById('cli-bg-color').value;
        if (currentTheme === 'cli') applyCliThemeColors();
        renderChatMessages();
        closeModal();
    };
    overlay.classList.remove('hidden');
}

function toggleSidebarCollapse() {
    isSidebarCollapsed = !isSidebarCollapsed;
    const sidebar = document.getElementById('app-sidebar');
    const titleText = document.getElementById('sidebar-title-text');
    const createBtn = document.getElementById('create-room-btn');
    const collapsedCreate = document.getElementById('collapsed-create-box');

    if (isSidebarCollapsed) {
        sidebar.style.width = '68px';
        sidebar.style.minWidth = '68px';
        titleText.style.display = 'none';
        createBtn.style.display = 'none';
        collapsedCreate.style.display = 'flex';
    } else {
        sidebar.style.width = '18rem';
        sidebar.style.minWidth = '18rem';
        titleText.style.display = 'flex';
        createBtn.style.display = 'flex';
        collapsedCreate.style.display = 'none';
    }
    renderRoomsList();
}

function formatP2PSessionTitle(session) {
    const others = (session.members || []).filter(m => m.id !== currentUser.id).map(m => m.name);
    return others.length > 0 ? others.join(', ') : 'P2P Session';
}

function renderRoomsList() {
    const container = document.getElementById('rooms-list');
    container.innerHTML = '';
    
    rooms.filter(r => r.id === 'public-lobby' || joinedRoomIds.has(r.id)).forEach(room => {
        const isActive = (room.id === currentRoomId && !activeP2PSessionId);
        const unreadCount = unreadChatCount[room.id] || 0;
        const stateClass = isActive ? 'cli-item-active bg-indigo-600 text-white border-indigo-500' : 'cli-item-inactive bg-cardbg/60 border-slate-800 hover:bg-slate-800/80 text-slate-200';
        
        const div = document.createElement('div');
        if (isSidebarCollapsed) {
            div.className = `w-11 h-11 mx-auto rounded-xl cursor-pointer border transition flex items-center justify-center relative ${stateClass}`;
            div.title = room.name;
            div.onclick = () => attemptSwitchRoom(room.id);
            div.innerHTML = `
                <i class="fa-solid ${room.icon} text-sm"></i>
                ${unreadCount > 0 ? `<span class="absolute -top-1 -right-1 px-1 min-w-[18px] h-[18px] bg-rose-600 text-white text-[9px] rounded-full flex items-center justify-center font-bold">${unreadCount}</span>` : ''}
            `;
        } else {
            const unreadBadge = unreadCount > 0 ? `<span class="px-1.5 py-0.5 text-[10px] rounded font-bold border">[+${unreadCount}]</span>` : '';
            div.className = `p-2.5 rounded-xl cursor-pointer border transition flex items-center justify-between ${stateClass}`;
            div.onclick = () => attemptSwitchRoom(room.id);
            div.innerHTML = `
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-lg border flex items-center justify-center shrink-0">
                        <i class="fa-solid ${room.icon} text-xs"></i>
                    </div>
                    <div class="min-w-0">
                        <div class="font-semibold text-xs flex items-center gap-1.5 truncate">
                            <span>${room.name}</span> ${room.password ? '<i class="fa-solid fa-lock text-[10px]"></i>' : ''}
                        </div>
                        <p class="text-[10px] opacity-75 truncate">${room.desc}</p>
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">${unreadBadge}<i class="fa-solid fa-chevron-right text-[10px]"></i></div>
            `;
        }
        container.appendChild(div);
    });

    const sessionIds = Object.keys(p2pChats);
    if (sessionIds.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'pt-2 pb-1 border-t border-slate-800 text-[10px] font-bold uppercase tracking-wider px-1 opacity-75';
        sep.textContent = isSidebarCollapsed ? 'P2P' : 'Direct P2P Channels';
        container.appendChild(sep);

        sessionIds.forEach(sId => {
            const session = p2pChats[sId];
            const title = formatP2PSessionTitle(session);
            const isActive = (activeP2PSessionId === sId);
            const unreadP2P = session.unread || 0;
            const stateClass = isActive ? 'cli-item-active bg-indigo-600 text-white border-indigo-500' : 'cli-item-inactive bg-cardbg/60 border-slate-800 hover:bg-slate-800/80 text-slate-200';

            const div = document.createElement('div');
            if (isSidebarCollapsed) {
                div.className = `w-11 h-11 mx-auto rounded-xl cursor-pointer border transition flex items-center justify-center relative ${stateClass}`;
                div.title = `P2P: ${title}`;
                div.onclick = () => switchToP2PChat(sId);
                div.innerHTML = `
                    <i class="fa-solid fa-user-shield text-sm"></i>
                    ${unreadP2P > 0 ? `<span class="absolute -top-1 -right-1 px-1 min-w-[18px] h-[18px] bg-rose-600 text-white text-[9px] rounded-full flex items-center justify-center font-bold">${unreadP2P}</span>` : ''}
                `;
            } else {
                const unreadBadge = unreadP2P > 0 ? `<span class="px-1.5 py-0.5 text-[10px] rounded font-bold border">[+${unreadP2P}]</span>` : '';
                div.className = `p-2.5 rounded-xl cursor-pointer border transition flex items-center justify-between ${stateClass}`;
                div.onclick = () => switchToP2PChat(sId);
                div.innerHTML = `
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-8 h-8 rounded-lg border flex items-center justify-center shrink-0">
                            <i class="fa-solid fa-user-shield text-xs"></i>
                        </div>
                        <div class="min-w-0">
                            <div class="text-xs font-semibold truncate">${title}</div>
                            <div class="text-[10px] opacity-75 font-mono">${(session.members || []).length} Peers | PTT Active</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">${unreadBadge}<i class="fa-solid fa-chevron-right text-[10px]"></i></div>
                `;
            }
            container.appendChild(div);
        });
    }
}

function attemptSwitchRoom(roomId) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    if (room.password && !joinedRoomIds.has(roomId)) {
        openRoomPasswordModal(room);
    } else {
        switchRoom(roomId, true);
    }
}

function openRoomPasswordModal(room) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = `Authenticate Channel: ${room.name}`;
    document.getElementById('modal-desc').textContent = 'Enter channel password to decrypt and join this private room.';
    document.getElementById('modal-content').innerHTML = `
        <input type="password" id="room-pass-input" placeholder="Channel Password" autofocus
            class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-xs text-slate-100 focus:outline-none">
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Unlock';
    document.getElementById('modal-confirm').onclick = function() {
        const val = document.getElementById('room-pass-input').value;
        if (val === room.password) {
            joinedRoomIds.add(room.id);
            closeModal();
            switchRoom(room.id, true);
        } else {
            showToast('Invalid channel password.', 'error');
        }
    };
    overlay.classList.remove('hidden');
}

function switchRoom(roomId, clearUnread = true) {
    const oldRoomId = currentRoomId;
    currentRoomId = roomId;
    activeP2PSessionId = null;
    joinedRoomIds.add(roomId);
    if (clearUnread) unreadChatCount[roomId] = 0;

    const room = rooms.find(r => r.id === roomId) || rooms[0];
    document.getElementById('current-room-title').textContent = room.name;
    if (room.password) {
        document.getElementById('current-room-desc').textContent = 'Private Protected Channel: Unmasked handles, Roster & PTT active.';
    } else {
        document.getElementById('current-room-desc').textContent = (roomId === 'public-lobby' && !publicChannelUsable)
            ? 'PUBLIC CHANNEL DISABLED BY ADMINISTRATOR.'
            : 'Public/Passwordless Channel: Identities masked as "ANON". PTT & Roster disabled.';
    }
    document.getElementById('room-icon').innerHTML = `<i class="fa-solid ${room.icon}"></i>`;
    document.getElementById('leave-room-btn').style.display = roomId === 'public-lobby' ? 'none' : 'flex';
    document.getElementById('close-p2p-channel-btn').classList.add('hidden');
    document.getElementById('add-p2p-user-btn').classList.add('hidden');

    if (oldRoomId && roomUsers[oldRoomId]) {
        roomUsers[oldRoomId] = roomUsers[oldRoomId].filter(u => u.id !== currentUser.id);
    }
    if (!roomUsers[roomId]) roomUsers[roomId] = [];
    if (!roomUsers[roomId].some(u => u.id === currentUser.id)) {
        roomUsers[roomId].push({ ...currentUser });
    }

    updateChannelInputAndPTTState();
    broadcastPresence();
    updateChatBadge();
    updateOnlineCounter();
    renderRoomsList();
    renderChatMessages();
    renderOnlineUsers();
}

function leaveRoom() {
    joinedRoomIds.delete(currentRoomId);
    switchRoom('public-lobby', true);
}

function openDirectConnectModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Establish Direct P2P Channel';
    document.getElementById('modal-desc').textContent = 'Manually enter the exact username of the peer to request a connection.';
    document.getElementById('modal-content').innerHTML = `
        <input type="text" id="target-peer-handle" placeholder="Enter exact peer handle (e.g. Cyber-Falcon-412)" autofocus
            class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-xs text-slate-100 focus:outline-none font-mono">
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Request Handshake';
    document.getElementById('modal-confirm').onclick = function() {
        const targetHandle = document.getElementById('target-peer-handle').value.trim();
        if (!targetHandle || targetHandle.toLowerCase() === currentUser.name.toLowerCase()) {
            showToast('Please enter a valid remote peer username.', 'error');
            return;
        }
        const sessionId = 'p2p_' + Math.random().toString(36).substring(2, 9);
        broadcastEvent({
            type: 'P2P_REQUEST',
            sessionId: sessionId,
            targetName: targetHandle,
            sender: { id: currentUser.id, name: currentUser.name },
            existingMembers: [{ id: currentUser.id, name: currentUser.name }]
        });
        closeModal();
        showToast('Handshake request dispatched.');
    };
    overlay.classList.remove('hidden');
}

function openAddUserToP2PModal() {
    if (!activeP2PSessionId || !p2pChats[activeP2PSessionId]) return;
    const session = p2pChats[activeP2PSessionId];
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Add User to P2P Channel';
    document.getElementById('modal-desc').textContent = 'Manually enter the exact username of the additional user to invite into this P2P session.';
    document.getElementById('modal-content').innerHTML = `
        <input type="text" id="invite-peer-handle" placeholder="Enter exact username to add" autofocus
            class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-xs text-slate-100 focus:outline-none font-mono">
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Send Invite';
    document.getElementById('modal-confirm').onclick = function() {
        const targetHandle = document.getElementById('invite-peer-handle').value.trim();
        if (!targetHandle || targetHandle.toLowerCase() === currentUser.name.toLowerCase()) {
            showToast('Enter a valid username.', 'error');
            return;
        }
        broadcastEvent({
            type: 'P2P_REQUEST',
            sessionId: activeP2PSessionId,
            targetName: targetHandle,
            sender: { id: currentUser.id, name: currentUser.name },
            existingMembers: session.members
        });
        closeModal();
        showToast('Channel invitation dispatched.');
    };
    overlay.classList.remove('hidden');
}

function openP2PApprovalModal(reqData) {
    if (blockedPeers[reqData.sender.id]) return;
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Incoming P2P Handshake Request';
    document.getElementById('modal-desc').textContent = `User "${reqData.sender.name}" is inviting you to an encrypted P2P channel. Approve connection?`;
    document.getElementById('modal-content').innerHTML = '';
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = () => { closeModal(); };
    document.getElementById('modal-confirm').textContent = 'Approve';
    document.getElementById('modal-confirm').onclick = function() {
        const updatedMembers = [...(reqData.existingMembers || [reqData.sender])];
        if (!updatedMembers.some(m => m.id === currentUser.id)) {
            updatedMembers.push({ id: currentUser.id, name: currentUser.name });
        }
        upsertP2PSession(reqData.sessionId, updatedMembers);
        broadcastEvent({
            type: 'P2P_APPROVED',
            sessionId: reqData.sessionId,
            initiatorId: reqData.sender.id,
            members: updatedMembers
        });
        closeModal();
        switchToP2PChat(reqData.sessionId);
    };
    overlay.classList.remove('hidden');
}

function upsertP2PSession(sessionId, members) {
    if (!p2pChats[sessionId]) {
        p2pChats[sessionId] = {
            sessionId: sessionId,
            members: members,
            unread: 0,
            messages: [
                { id: 'p2p_sys_' + Date.now(), senderId: 'system', senderName: 'System', text: `Encrypted P2P session active (${members.map(m => m.name).join(', ')}). PTT & unmasked handles enabled.`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true }
            ]
        };
    } else {
        p2pChats[sessionId].members = members;
    }
    renderRoomsList();
}

function switchToP2PChat(sessionId) {
    activeP2PSessionId = sessionId;
    const session = p2pChats[sessionId];
    if (!session) return;
    session.unread = 0;

    const title = formatP2PSessionTitle(session);
    document.getElementById('current-room-title').textContent = `P2P: ${title}`;
    document.getElementById('current-room-desc').textContent = `Direct Encrypted P2P Channel (${session.members.length} participants). PTT & unmasked handles active.`;
    document.getElementById('room-icon').innerHTML = `<i class="fa-solid fa-user-shield"></i>`;
    document.getElementById('leave-room-btn').style.display = 'flex';
    document.getElementById('close-p2p-channel-btn').classList.remove('hidden');
    document.getElementById('add-p2p-user-btn').classList.remove('hidden');

    updateChannelInputAndPTTState();
    updateOnlineCounter();
    renderRoomsList();
    renderChatMessages();
    renderOnlineUsers();
    switchTab('feed');
}

function closeActiveP2PChannel() {
    if (!activeP2PSessionId) return;
    const sId = activeP2PSessionId;
    const session = p2pChats[sId];
    const title = session ? formatP2PSessionTitle(session) : 'Peer';

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Terminate P2P Channel';
    document.getElementById('modal-desc').textContent = `Exit and delete local P2P history with ${title}. Connection cannot resume unless re-established.`;
    document.getElementById('modal-content').innerHTML = `
        <label class="flex items-center gap-2 cursor-pointer mt-2 text-xs">
            <input type="checkbox" id="block-user-checkbox" class="rounded bg-slate-900 border-slate-700">
            <span>Block peer(s) from sending future handshake requests</span>
        </label>
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Terminate';
    document.getElementById('modal-confirm').onclick = function() {
        const shouldBlock = document.getElementById('block-user-checkbox').checked;
        if (shouldBlock && session && session.members) {
            session.members.forEach(m => {
                if (m.id !== currentUser.id) blockedPeers[m.id] = m.name;
            });
        }
        delete p2pChats[sId];
        activeP2PSessionId = null;
        closeModal();
        switchRoom('public-lobby', true);
    };
    overlay.classList.remove('hidden');
}

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    let messages = [];
    const isPublicContext = !activeP2PSessionId;
    const currentRoom = rooms.find(r => r.id === currentRoomId);
    const isPasswordRoom = Boolean(currentRoom && currentRoom.password);

    if (isPublicContext) {
        messages = chatMessages[currentRoomId] || [];
    } else {
        const session = p2pChats[activeP2PSessionId];
        messages = session ? session.messages : [];
    }

    const canvasesToDraw = [];

    messages.forEach(msg => {
        if (msg.isSystem) {
            const sysDiv = document.createElement('div');
            sysDiv.className = 'flex justify-center my-1';
            sysDiv.innerHTML = `<span class="text-[10px] border border-slate-800 px-3 py-0.5 rounded font-mono opacity-75">${msg.text}</span>`;
            container.appendChild(sysDiv);
            return;
        }

        const isSelf = msg.senderId === currentUser.id;
        const displayName = (isPublicContext && !isPasswordRoom) ? 'ANON' : msg.senderName;

        const wrapper = document.createElement('div');
        wrapper.className = `flex gap-2.5 relative group ${isSelf ? 'flex-row-reverse' : ''}`;
        
        const timestampTooltip = document.createElement('div');
        timestampTooltip.className = `absolute bottom-full mb-1 ${isSelf ? 'right-0' : 'left-0'} hidden group-hover:flex bg-slate-950 border border-slate-700 text-slate-200 text-[10px] px-2 py-0.5 rounded z-20 pointer-events-none font-mono`;
        timestampTooltip.textContent = `Timestamp: ${msg.time} (${msg.isoTime || ''}) | TTL: ${msg.ttl || 72}h`;

        const bubbleBox = document.createElement('div');
        bubbleBox.className = `max-w-[82%] relative`;

        const headerRow = document.createElement('div');
        headerRow.className = `flex items-center gap-2 mb-1 text-[11px] ${isSelf ? 'justify-end' : ''}`;
        headerRow.innerHTML = `
            <span class="font-bold font-mono">${displayName}</span>
            <span class="text-[10px] opacity-70">${msg.time}</span>
            ${msg.burnOnRead ? `<span class="text-[9px] border px-1 rounded font-mono">120s BURN</span>` : ''}
            <button onclick="window.VP.confirmDeleteMessage('${msg.id}')" class="px-1.5 py-0.5 rounded text-[10px] transition flex items-center gap-1" title="Delete Message">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;

        const contentBox = document.createElement('div');
        contentBox.className = `p-3 rounded-xl text-xs border ${isSelf ? 'bg-indigo-600/20 border-indigo-500/50 text-slate-100' : 'bg-cardbg border-slate-800 text-slate-200'}`;
        
        if (msg.fileType === 'image' && msg.fileData) {
            contentBox.innerHTML = `
                <div class="space-y-2">
                    <img src="${msg.fileData}" alt="Attachment" class="rounded max-h-56 object-cover cursor-pointer border" onclick="window.open('${msg.fileData}')">
                    <div class="flex items-center justify-between pt-1">
                        <span class="text-[10px] font-mono">${msg.fileName || 'image.png'}</span>
                        <a href="${msg.fileData}" download="${msg.fileName || 'image.png'}" class="cli-btn px-2 py-0.5 border rounded text-[10px] font-bold">SAVE</a>
                    </div>
                </div>
            `;
        } else if (msg.fileType === 'file' && msg.fileData) {
            contentBox.innerHTML = `
                <div class="flex items-center justify-between gap-4">
                    <div class="flex items-center gap-2 min-w-0">
                        <i class="fa-solid fa-file-shield text-base"></i>
                        <span class="font-semibold text-xs truncate">${msg.fileName}</span>
                    </div>
                    <a href="${msg.fileData}" download="${msg.fileName}" class="cli-btn px-2.5 py-1 border rounded text-[10px] font-bold shrink-0">DOWNLOAD</a>
                </div>
            `;
        } else if (msg.fileType === 'audio' && msg.audioData) {
            if (!activeAudioElements[msg.id]) {
                const aEl = new Audio(msg.audioData);
                const peaks = msg.waveformPeaks || generateDetailedWaveformPeaks(48);
                aEl.onended = () => {
                    if (activeAudioElements[msg.id]) {
                        activeAudioElements[msg.id].isPlaying = false;
                        activeAudioElements[msg.id].progress = 0;
                    }
                    const icon = document.getElementById(`play-icon-${msg.id}`);
                    const lbl = document.getElementById(`audio-label-${msg.id}`);
                    if (icon) icon.className = 'fa-solid fa-play';
                    if (lbl) lbl.textContent = 'PLAY';
                    drawMessageWaveformCanvas(msg.id, currentTheme, cliColors);
                    triggerAutoburnIfEnabled(msg.id, msg.burnOnRead);
                };
                activeAudioElements[msg.id] = { audio: aEl, isPlaying: false, progress: 0, peaks: peaks };
            }
            const isPlayingNow = activeAudioElements[msg.id].isPlaying;
            contentBox.innerHTML = `
                <div class="flex items-center gap-2.5">
                    <button type="button" onclick="window.VP.toggleCustomAudioClip('${msg.id}')" class="px-2.5 py-1.5 rounded text-[10px] font-bold flex items-center gap-1.5 border shrink-0">
                        <i id="play-icon-${msg.id}" class="fa-solid ${isPlayingNow ? 'fa-stop' : 'fa-play'}"></i>
                        <span id="audio-label-${msg.id}">${isPlayingNow ? 'STOP' : 'PLAY'}</span>
                    </button>
                    <div class="w-44 sm:w-56 h-8 bg-slate-950 border border-slate-800 rounded overflow-hidden flex items-center px-1 shrink-0">
                        <canvas id="waveform-canvas-${msg.id}" width="216" height="28" class="w-full h-full block"></canvas>
                    </div>
                    <a href="${msg.audioData}" download="ptt_${msg.id}.mp3" class="cli-btn px-2.5 py-1.5 rounded text-[10px] font-bold border flex items-center gap-1 shrink-0">
                        <i class="fa-solid fa-download"></i> MP3
                    </a>
                </div>
            `;
            canvasesToDraw.push(msg.id);
        } else {
            contentBox.textContent = msg.text;
        }

        if (msg.burnOnRead && msg.fileType !== 'audio' && !isSelf && !msg.readTriggered) {
            msg.readTriggered = true;
            setTimeout(() => { deleteMessage(msg.id); }, APP_CONSTANTS.AUTOBURN_DELAY_MS);
        }

        bubbleBox.appendChild(timestampTooltip);
        bubbleBox.appendChild(headerRow);
        bubbleBox.appendChild(contentBox);

        const avatarEl = document.createElement('div');
        avatarEl.className = 'w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xs shrink-0';
        avatarEl.innerHTML = `<i class="fa-solid fa-user-secret"></i>`;

        wrapper.appendChild(avatarEl);
        wrapper.appendChild(bubbleBox);
        container.appendChild(wrapper);
    });

    canvasesToDraw.forEach(id => drawMessageWaveformCanvas(id, currentTheme, cliColors));
}

function triggerAutoburnIfEnabled(msgId, burnOnReadFlag) {
    if (burnOnReadFlag === true) {
        setTimeout(() => { deleteMessage(msgId); }, APP_CONSTANTS.AUTOBURN_DELAY_MS);
    }
}

async function sendChatMessage(e) {
    e.preventDefault();
    if (currentRoomId === 'public-lobby' && !activeP2PSessionId && !publicChannelUsable && !currentUser.isAdmin) {
        showToast('Public Channel is currently disabled by administrator.', 'error');
        return;
    }
    if (globalMaintenanceLock && !currentUser.isAdmin) {
        showToast('Channel transmissions locked by administrator.', 'error');
        return;
    }
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    const ttlHours = parseInt(document.getElementById('msg-ttl-select').value) || 72;
    const burnOnRead = document.getElementById('msg-burn-read').checked;
    const encryptedText = await encryptPayload(text);

    const msg = {
        id: 'msg_' + Math.random().toString(36).substring(2, 10),
        senderId: currentUser.id,
        senderName: currentUser.name,
        text: encryptedText,
        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
        isoTime: new Date().toISOString(),
        timestamp: Date.now(),
        ttl: ttlHours,
        burnOnRead: burnOnRead
    };

    input.value = '';
    await dispatchAndRenderMessage(msg, text);
}

function handleFileAttachment(e, type) {
    if (currentRoomId === 'public-lobby' && !activeP2PSessionId && !publicChannelUsable && !currentUser.isAdmin) {
        showToast('Public Channel is currently disabled by administrator.', 'error');
        return;
    }
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(uploadEvent) {
        const fileData = uploadEvent.target.result;
        const ttlHours = parseInt(document.getElementById('msg-ttl-select').value) || 72;
        const burnOnRead = document.getElementById('msg-burn-read').checked;
        const label = type === 'image' ? '[Encrypted Image]' : `[Encrypted File: ${file.name}]`;
        const encryptedText = await encryptPayload(label);

        const msg = {
            id: 'file_' + Math.random().toString(36).substring(2, 10),
            senderId: currentUser.id,
            senderName: currentUser.name,
            text: encryptedText,
            fileData: fileData,
            fileName: file.name,
            fileType: type,
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            isoTime: new Date().toISOString(),
            timestamp: Date.now(),
            ttl: ttlHours,
            burnOnRead: burnOnRead
        };

        await dispatchAndRenderMessage(msg, label);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

function sendAudioClipMessage(audioUrl, blob, waveformPeaks) {
    const reader = new FileReader();
    reader.onload = async function(e) {
        const audioBase64 = e.target.result;
        const ttlHours = parseInt(document.getElementById('msg-ttl-select').value) || 72;
        const burnOnRead = document.getElementById('msg-burn-read').checked;
        const encryptedText = await encryptPayload('[PTT Voice Broadcast]');

        const msg = {
            id: 'ptt_' + Math.random().toString(36).substring(2, 10),
            senderId: currentUser.id,
            senderName: currentUser.name,
            text: encryptedText,
            audioData: audioBase64,
            waveformPeaks: waveformPeaks || generateDetailedWaveformPeaks(48),
            fileType: 'audio',
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            isoTime: new Date().toISOString(),
            timestamp: Date.now(),
            ttl: ttlHours,
            burnOnRead: burnOnRead
        };
        await dispatchAndRenderMessage(msg, '[PTT Voice Broadcast]');
    };
    reader.readAsDataURL(blob);
}

async function dispatchAndRenderMessage(networkMsg, localPlaintext) {
    const localMsg = { ...networkMsg, text: localPlaintext };
    if (!activeP2PSessionId) {
        if (!chatMessages[currentRoomId]) chatMessages[currentRoomId] = [];
        chatMessages[currentRoomId].push(localMsg);
        renderChatMessages();
        scrollToBottomChat();
        broadcastEvent({ type: 'CHAT_MESSAGE', roomId: currentRoomId, message: networkMsg });
    } else {
        const session = p2pChats[activeP2PSessionId];
        if (session) {
            session.messages.push(localMsg);
            renderChatMessages();
            scrollToBottomChat();
            broadcastEvent({
                type: 'P2P_MESSAGE',
                sessionId: activeP2PSessionId,
                members: session.members,
                senderId: currentUser.id,
                senderName: currentUser.name,
                message: networkMsg
            });
        }
    }
}

function confirmDeleteMessage(messageId) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Confirm Bilateral Deletion';
    document.getElementById('modal-desc').textContent = 'Permanently purge this message across all connected sessions?';
    document.getElementById('modal-content').innerHTML = '';
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Delete';
    document.getElementById('modal-confirm').onclick = function() {
        deleteMessage(messageId);
        closeModal();
    };
    overlay.classList.remove('hidden');
}

function deleteMessage(messageId) {
    broadcastEvent({ type: 'DELETE_MESSAGE', roomId: currentRoomId, messageId: messageId });
    if (chatMessages[currentRoomId]) chatMessages[currentRoomId] = chatMessages[currentRoomId].filter(m => m.id !== messageId);
    Object.keys(p2pChats).forEach(sId => {
        if (p2pChats[sId].messages) p2pChats[sId].messages = p2pChats[sId].messages.filter(m => m.id !== messageId);
    });
    delete activeAudioElements[messageId];
    renderChatMessages();
}

function scrollToBottomChat() {
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
}

function updateOnlineCounter() {
    if (activeP2PSessionId && p2pChats[activeP2PSessionId]) {
        document.getElementById('online-count').textContent = p2pChats[activeP2PSessionId].members.length;
        return;
    }
    const users = roomUsers[currentRoomId] || [];
    if (!users.some(u => u.id === currentUser.id)) users.push(currentUser);
    document.getElementById('online-count').textContent = users.length;
}

function renderOnlineUsers() {
    const container = document.getElementById('users-list-container');
    container.innerHTML = '';

    const currentRoom = rooms.find(r => r.id === currentRoomId);
    const isPrivateChannel = Boolean(activeP2PSessionId || (currentRoom && currentRoom.password));

    if (!isPrivateChannel && !currentUser.isAdmin) {
        const totalOnline = (roomUsers[currentRoomId] || []).length || 1;
        container.innerHTML = `
            <div class="bg-cardbg border border-slate-800 rounded-xl p-5 text-center space-y-3">
                <i class="fa-solid fa-eye-slash text-xl"></i>
                <div class="font-bold text-xs uppercase tracking-wider">Public Directory Redacted (${totalOnline} Connected)</div>
                <p class="text-[11px] opacity-80 max-w-md mx-auto">
                    User identities are strictly hidden on public and passwordless channels. To establish a bilateral P2P channel, you must manually enter the exact username of your peer.
                </p>
                <button onclick="window.VP.openDirectConnectModal()" class="px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2">
                    <i class="fa-solid fa-satellite-dish"></i> Enter Username to Connect
                </button>
            </div>
        `;
        return;
    }

    let users = [];
    if (activeP2PSessionId && p2pChats[activeP2PSessionId]) {
        users = p2pChats[activeP2PSessionId].members.map(m => {
            return (m.id === currentUser.id) ? currentUser : { id: m.id, name: m.name, isSpeaking: false };
        });
    } else {
        users = roomUsers[currentRoomId] || [];
        if (!users.some(u => u.id === currentUser.id)) users.push(currentUser);
    }

    document.getElementById('online-count').textContent = users.length;

    users.forEach(u => {
        if (blockedPeers[u.id]) return;
        const isYou = u.id === currentUser.id;
        const div = document.createElement('div');
        div.className = 'bg-cardbg border border-slate-800 rounded-xl p-3.5 flex items-center justify-between';
        div.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-sm">
                    <i class="fa-solid fa-user-secret"></i>
                </div>
                <div>
                    <div class="font-semibold text-xs text-slate-100 flex items-center gap-2 font-mono">
                        <span>${u.name}</span>
                        ${isYou ? '<span class="text-[10px] border px-1.5 py-0.2 rounded font-normal">YOU</span>' : ''}
                    </div>
                    <p class="text-[11px] text-emerald-400 flex items-center gap-1.5 mt-0.5">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 ${u.isSpeaking ? 'animate-ping' : ''}"></span>
                        ${u.isSpeaking ? 'Transmitting Voice...' : 'Authenticated Private Peer'}
                    </p>
                    ${currentUser.isAdmin ? `<p class="text-[10px] text-slate-400 font-mono mt-1">Node ID: ${u.id} | IP: ${u.ipApproximation || '10.24.0.1'} | ${u.os || 'OS'} (${u.browser || 'Browser'})</p>` : ''}
                </div>
            </div>
            <div class="text-[10px] font-mono opacity-75">
                ${isYou ? 'LOCAL NODE' : 'VERIFIED PEER'}
            </div>
        `;
        container.appendChild(div);
    });
}

function openSwitchUserModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Authenticate / Switch Identity';
    document.getElementById('modal-desc').textContent = 'Enter your username and password. New handles are registered automatically.';
    document.getElementById('modal-content').innerHTML = `
        <div class="space-y-3">
            <div>
                <label class="text-xs font-bold block mb-1">Username / Handle</label>
                <input type="text" id="auth-handle-input" value="${currentUser.name}" placeholder="Username" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 focus:outline-none font-mono">
            </div>
            <div>
                <label class="text-xs font-bold block mb-1">Password</label>
                <input type="password" id="auth-password-input" placeholder="Enter password" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 focus:outline-none font-mono">
            </div>
        </div>
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Authenticate';
    document.getElementById('modal-confirm').onclick = async function() {
        const handle = document.getElementById('auth-handle-input').value.trim();
        const pass = document.getElementById('auth-password-input').value;
        if (!handle || !pass) {
            showToast('Both username and password are required.', 'error');
            return;
        }
        const res = await verifyOrRegisterAccount(handle, pass);
        if (!res.ok) {
            showToast(res.error, 'error');
            return;
        }
        closeModal();
        completeUserSessionSetup(handle, res.isAdmin);
        if (res.isAdmin) openAdminDashboard();
    };
    overlay.classList.remove('hidden');
}

function openAdminDashboard() {
    if (!currentUser.isAdmin) return;
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'System Administration & Telemetry Console';
    document.getElementById('modal-desc').textContent = 'Authenticated as root administrator. Public profile disguised as ' + currentUser.name + '.';
    
    let allNodes = [];
    Object.keys(roomUsers).forEach(rId => {
        roomUsers[rId].forEach(node => {
            if (!allNodes.some(n => n.id === node.id)) allNodes.push({ ...node, activeChannel: rId });
        });
    });
    if (!allNodes.some(n => n.id === currentUser.id)) allNodes.push({ ...currentUser, activeChannel: currentRoomId });

    const nodesHtml = allNodes.map(n => `
        <div class="bg-slate-900 border border-slate-800 p-3 rounded-xl space-y-2 text-[11px]">
            <div class="flex items-center justify-between font-bold">
                <span class="font-mono">${n.name} [ID: ${n.id}]</span>
                <div class="flex items-center gap-1.5">
                    ${n.id !== currentUser.id ? `<button onclick="window.VP.adminKickNode('${n.id}')" class="px-2 py-0.5 rounded text-[10px]">Kick</button>` : '<span class="text-[10px] font-mono border px-1.5 rounded">ROOT</span>'}
                </div>
            </div>
            <div class="grid grid-cols-2 gap-1.5 text-[10px] font-mono opacity-85">
                <div>IP/Sub: ${n.ipApproximation}</div>
                <div>Device: ${n.device}</div>
                <div>OS/Arch: ${n.os} (${n.cores || 4} cores)</div>
                <div>Browser: ${n.browser}</div>
                <div>Screen: ${n.resolution || '1920x1080'}</div>
                <div>Zone/Loc: ${n.timezone} (${n.locale})</div>
                <div>Room: ${n.activeChannel}</div>
                <div>Joined: ${n.connectionTime}</div>
            </div>
        </div>
    `).join('');

    const channelsHtml = rooms.map(r => `
        <div class="flex items-center justify-between bg-slate-900 border border-slate-800 px-3 py-2 rounded-lg text-xs">
            <div>
                <span class="font-bold">${r.name}</span> <span class="text-[10px] font-mono">(${(chatMessages[r.id] || []).length} msgs)</span>
                ${r.password ? '<span class="text-[9px] border px-1 rounded ml-1">PW</span>' : ''}
            </div>
            <div class="flex items-center gap-1.5">
                <button onclick="window.VP.adminPurgeChannel('${r.id}')" class="px-2 py-0.5 rounded text-[10px]">Purge Msgs</button>
                ${r.id !== 'public-lobby' ? `<button onclick="window.VP.adminDeleteChannel('${r.id}')" class="px-2 py-0.5 rounded text-[10px]">Delete</button>` : ''}
            </div>
        </div>
    `).join('');

    document.getElementById('modal-content').innerHTML = `
        <div class="max-h-[400px] overflow-y-auto space-y-4 pr-1 text-xs">
            <div class="p-3 border border-slate-800 rounded-xl space-y-2.5">
                <div class="font-bold uppercase text-[10px] tracking-wider">Global Platform Controls</div>
                <div class="flex gap-2">
                    <input type="text" id="admin-broadcast-input" placeholder="System-wide alert message..." class="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1 text-xs">
                    <button onclick="window.VP.adminSendGlobalAlert()" class="px-3 py-1 rounded text-xs">Broadcast</button>
                </div>
                <div class="flex items-center justify-between pt-1">
                    <span>Public Channel Usability (${publicChannelUsable ? 'ENABLED' : 'DISABLED'})</span>
                    <button onclick="window.VP.adminTogglePublicChannelUsability()" class="px-2.5 py-1 rounded text-[10px]">${publicChannelUsable ? 'DISABLE PUBLIC CHANNEL' : 'ENABLE PUBLIC CHANNEL'}</button>
                </div>
                <div class="flex items-center justify-between pt-1">
                    <span>Global Maintenance Freeze (Lock All Non-Admin Activity)</span>
                    <button onclick="window.VP.adminToggleMaintenance()" class="px-2.5 py-1 rounded text-[10px]">${globalMaintenanceLock ? 'UNLOCK PLATFORM' : 'LOCK PLATFORM'}</button>
                </div>
                <div class="flex items-center justify-between pt-1">
                    <span>Export Telemetry Audit JSON</span>
                    <button onclick="window.VP.adminExportTelemetry()" class="px-2.5 py-1 rounded text-[10px]">Export JSON</button>
                </div>
            </div>

            <div class="space-y-1.5">
                <div class="font-bold uppercase text-[10px] tracking-wider">Channel Matrix & TTL Management (${rooms.length})</div>
                ${channelsHtml}
            </div>

            <div class="space-y-1.5">
                <div class="font-bold uppercase text-[10px] tracking-wider">Connected Node Telemetry (${allNodes.length})</div>
                ${nodesHtml}
            </div>
        </div>
    `;
    document.getElementById('modal-cancel').classList.add('hidden');
    document.getElementById('modal-confirm').textContent = 'Close Console';
    document.getElementById('modal-confirm').onclick = closeModal;
    overlay.classList.remove('hidden');
}

function adminTogglePublicChannelUsability() {
    publicChannelUsable = !publicChannelUsable;
    broadcastEvent({ type: 'ADMIN_ACTION', action: 'TOGGLE_PUBLIC_CHANNEL', usable: publicChannelUsable });
    updateChannelInputAndPTTState();
    if (currentRoomId === 'public-lobby' && !activeP2PSessionId) switchRoom('public-lobby', false);
    openAdminDashboard();
}

function adminSendGlobalAlert() {
    const val = document.getElementById('admin-broadcast-input').value.trim();
    if (!val) return;
    const alertMsg = { id: 'sys_' + Date.now(), sender: 'System', text: `[SYSTEM ALERT]: ${val}`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true, ttl: 72 };
    Object.keys(chatMessages).forEach(rId => chatMessages[rId].push(alertMsg));
    broadcastEvent({ type: 'ADMIN_ACTION', action: 'GLOBAL_ALERT', alertMsg });
    renderChatMessages();
    document.getElementById('admin-broadcast-input').value = '';
}

function adminPurgeChannel(roomId) {
    chatMessages[roomId] = [{ id: 'sys_' + Date.now(), sender: 'System', text: `Channel history purged by administrator.`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true, ttl: 72 }];
    broadcastEvent({ type: 'ADMIN_ACTION', action: 'PURGE_CHANNEL', roomId });
    renderChatMessages();
    openAdminDashboard();
}

function adminDeleteChannel(roomId) {
    if (roomId === 'public-lobby') return;
    rooms = rooms.filter(r => r.id !== roomId);
    delete chatMessages[roomId];
    joinedRoomIds.delete(roomId);
    broadcastEvent({ type: 'CHANNEL_DELETED', roomId });
    if (currentRoomId === roomId) switchRoom('public-lobby', true);
    else renderRoomsList();
    openAdminDashboard();
}

function adminKickNode(nodeId) {
    kickedNodeIds[nodeId] = true;
    Object.keys(roomUsers).forEach(rId => {
        roomUsers[rId] = roomUsers[rId].filter(u => u.id !== nodeId);
    });
    broadcastEvent({ type: 'ADMIN_ACTION', action: 'KICK_NODE', nodeId });
    renderOnlineUsers();
    openAdminDashboard();
}

function adminToggleMaintenance() {
    globalMaintenanceLock = !globalMaintenanceLock;
    broadcastEvent({ type: 'ADMIN_ACTION', action: 'MAINTENANCE_LOCK', locked: globalMaintenanceLock });
    updateChannelInputAndPTTState();
    openAdminDashboard();
}

function adminExportTelemetry() {
    const payload = JSON.stringify({ timestamp: new Date().toISOString(), rooms, roomUsers }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voicepulse_telemetry_${Date.now()}.json`;
    a.click();
}

function executeRemoteAdminCommand(data) {
    if (data.action === 'GLOBAL_ALERT' && data.alertMsg) {
        Object.keys(chatMessages).forEach(rId => chatMessages[rId].push(data.alertMsg));
        renderChatMessages();
        playBeepNotification(520, 0.15);
    } else if (data.action === 'PURGE_CHANNEL') {
        chatMessages[data.roomId] = [{ id: 'sys_' + Date.now(), sender: 'System', text: `Channel history purged by administrator.`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true, ttl: 72 }];
        renderChatMessages();
    } else if (data.action === 'KICK_NODE' && data.nodeId === currentUser.id) {
        kickedNodeIds[currentUser.id] = true;
        showToast('Session terminated by administrator.', 'error');
    } else if (data.action === 'MAINTENANCE_LOCK') {
        globalMaintenanceLock = data.locked;
        updateChannelInputAndPTTState();
    } else if (data.action === 'TOGGLE_PUBLIC_CHANNEL') {
        publicChannelUsable = data.usable;
        updateChannelInputAndPTTState();
        if (currentRoomId === 'public-lobby' && !activeP2PSessionId) switchRoom('public-lobby', false);
    }
}

function switchTab(tabKey) {
    activeTab = tabKey;
    const feedBtn = document.getElementById('tab-btn-feed');
    const usersBtn = document.getElementById('tab-btn-users');
    const feedContent = document.getElementById('tab-content-feed');
    const usersContent = document.getElementById('tab-content-users');

    if (tabKey === 'feed') {
        feedBtn.classList.remove('cli-tab-inactive', 'text-slate-400', 'bg-transparent');
        feedBtn.classList.add('bg-indigo-600', 'text-white');
        usersBtn.classList.add('cli-tab-inactive', 'text-slate-400', 'bg-transparent');
        usersBtn.classList.remove('bg-indigo-600', 'text-white');

        feedContent.classList.remove('hidden');
        usersContent.classList.add('hidden');

        if (!activeP2PSessionId) unreadChatCount[currentRoomId] = 0;
        updateChatBadge();
        renderRoomsList();
        renderChatMessages();
        scrollToBottomChat();
    } else {
        usersBtn.classList.remove('cli-tab-inactive', 'text-slate-400', 'bg-transparent');
        usersBtn.classList.add('bg-indigo-600', 'text-white');
        feedBtn.classList.add('cli-tab-inactive', 'text-slate-400', 'bg-transparent');
        feedBtn.classList.remove('bg-indigo-600', 'text-white');

        usersContent.classList.remove('hidden');
        feedContent.classList.add('hidden');
        renderOnlineUsers();
    }
}

function updateChatBadge() {
    const count = unreadChatCount[currentRoomId] || 0;
    const badge = document.getElementById('chat-badge');
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
}

function openJoinChannelByNameModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Join Channel by Name';
    document.getElementById('modal-desc').textContent = 'Enter the exact name of an existing channel to join. If it is password-protected, you will be prompted for the password next.';
    document.getElementById('modal-content').innerHTML = `
        <div class="space-y-3">
            <input type="text" id="join-room-name-input" placeholder="Enter exact Channel Name" autofocus class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 focus:outline-none font-mono">
        </div>
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Join Channel';
    document.getElementById('modal-confirm').onclick = function() {
        const targetName = document.getElementById('join-room-name-input').value.trim();
        if (!targetName) {
            showToast('Channel name is required.', 'error');
            return;
        }
        const targetRoom = rooms.find(r => r.name.toLowerCase() === targetName.toLowerCase());
        if (!targetRoom) {
            showToast(`Channel "${targetName}" not found.`, 'error');
            return;
        }
        closeModal();
        if (targetRoom.password && !joinedRoomIds.has(targetRoom.id)) {
            openRoomPasswordModal(targetRoom);
        } else {
            joinedRoomIds.add(targetRoom.id);
            renderRoomsList();
            switchRoom(targetRoom.id, true);
        }
    };
    overlay.classList.remove('hidden');
}

function openCreateRoomModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Create Communication Channel';
    document.getElementById('modal-desc').textContent = 'Password-protected channels enable PTT voice & user rosters. Passwordless channels are text/file only with hidden rosters.';
    document.getElementById('modal-content').innerHTML = `
        <div class="space-y-3">
            <input type="text" id="new-room-name" placeholder="Channel Name" autofocus class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 focus:outline-none">
            <input type="text" id="new-room-desc" placeholder="Topic / Description (Optional)" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 focus:outline-none">
            <input type="password" id="new-room-password" placeholder="Optional Password (Required to enable PTT & Roster)" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 focus:outline-none">
        </div>
    `;
    document.getElementById('modal-cancel').classList.remove('hidden');
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').textContent = 'Create';
    document.getElementById('modal-confirm').onclick = function() {
        const name = document.getElementById('new-room-name').value.trim();
        if (!name) { showToast('Channel name is required.', 'error'); return; }
        const password = document.getElementById('new-room-password').value;
        const newRoom = {
            id: 'room_' + Math.random().toString(36).substring(2, 7),
            name: name,
            desc: document.getElementById('new-room-desc').value.trim() || (password ? 'Private channel (PTT & Roster enabled)' : 'Passwordless channel (Text/File only)'),
            icon: password ? 'fa-lock' : 'fa-hashtag',
            password: password,
            createdAt: Date.now(),
            lastActive: Date.now()
        };
        rooms.push(newRoom);
        joinedRoomIds.add(newRoom.id);
        chatMessages[newRoom.id] = [{ id: 'sys_' + newRoom.id, sender: 'System', text: `Channel [${name}] created. ${password ? 'Private PTT & Roster enabled.' : 'Passwordless mode: PTT & Roster disabled.'}`, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}), isoTime: new Date().toISOString(), timestamp: Date.now(), isSystem: true, ttl: 72 }];
        roomUsers[newRoom.id] = [{ ...currentUser }];
        unreadChatCount[newRoom.id] = 0;

        broadcastEvent({ type: 'CHANNEL_CREATED', room: newRoom });
        closeModal();
        renderRoomsList();
        switchRoom(newRoom.id, true);
    };
    overlay.classList.remove('hidden');
}

function updateTabTitleAlert() {
    document.title = '[NEW ACTIVITY] - VoicePulse';
    window.addEventListener('focus', () => {
        document.title = 'VoicePulse - Anonymity-First PTT & E2EE Vault';
    }, { once: true });
}

function handleOutsideModalClick(e) {
    const box = document.getElementById('modal-box');
    if (box && !box.contains(e.target)) closeModal();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
}

function showToast(msg, type = 'notice') {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = type === 'error' ? 'System Alert' : 'System Notice';
    document.getElementById('modal-desc').textContent = msg;
    document.getElementById('modal-content').innerHTML = '';
    document.getElementById('modal-cancel').classList.add('hidden');
    document.getElementById('modal-confirm').textContent = 'OK';
    document.getElementById('modal-confirm').onclick = closeModal;
    overlay.classList.remove('hidden');
}

// Expose UI handlers to window.VP for HTML inline attributes
window.VP = {
    handleInitialAuthSubmit,
    fillRandomAuthHandle,
    toggleSidebarCollapse,
    toggleThemeMode,
    openCLIColorModal,
    openDirectConnectModal,
    openSwitchUserModal,
    openAdminDashboard,
    leaveRoom,
    openJoinChannelByNameModal,
    openCreateRoomModal,
    openAddUserToP2PModal,
    closeActiveP2PChannel,
    switchTab,
    sendChatMessage,
    handleFileAttachment,
    toggleCustomAudioClip,
    confirmDeleteMessage,
    handleOutsideModalClick,
    adminTogglePublicChannelUsability,
    adminSendGlobalAlert,
    adminPurgeChannel,
    adminDeleteChannel,
    adminKickNode,
    adminToggleMaintenance,
    adminExportTelemetry
};
