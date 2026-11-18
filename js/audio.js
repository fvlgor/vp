export const activeAudioElements = {};

let audioCtx = null;
let analyser = null;
let micStream = null;
let mediaRecorder = null;
let audioChunks = [];
let currentRecordingPeaks = [];
let peakSampleInterval = null;
let onClipReadyCallback = null;

export function setOnClipReadyCallback(cb) {
    onClipReadyCallback = cb;
}

export async function requestInitialAudioPermissions() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 128;
            const source = audioCtx.createMediaStreamSource(micStream);
            source.connect(analyser);

            mediaRecorder = new MediaRecorder(micStream);
            mediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
                const audioUrl = URL.createObjectURL(audioBlob);
                audioChunks = [];
                const capturedPeaks = currentRecordingPeaks.length > 8
                    ? [...currentRecordingPeaks]
                    : generateDetailedWaveformPeaks(48);
                if (onClipReadyCallback) onClipReadyCallback(audioUrl, audioBlob, capturedPeaks);
            };
        } catch (err) {
            console.warn("Microphone permission denied or unavailable on load.");
        }
    }
    document.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }, { once: true });
}

export function generateDetailedWaveformPeaks(seedCount = 48) {
    const peaks = [];
    let phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < seedCount; i++) {
        const env = Math.sin((i / seedCount) * Math.PI);
        const harmonic = Math.abs(Math.sin(i * 0.45 + phase) * 0.65 + Math.cos(i * 0.9 - phase) * 0.35);
        peaks.push(Math.max(0.12, Math.min(0.96, harmonic * env + 0.1)));
    }
    return peaks;
}

export function drawMessageWaveformCanvas(msgId, currentTheme, cliColors) {
    const canvas = document.getElementById(`waveform-canvas-${msgId}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const entry = activeAudioElements[msgId];
    const peaks = (entry && entry.peaks && entry.peaks.length > 0) ? entry.peaks : generateDetailedWaveformPeaks(48);
    const isPlaying = entry && entry.isPlaying;
    const progress = entry ? (entry.progress || 0) : 0;

    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    const bgCol = currentTheme === 'cli' ? cliColors.bg : '#090d16';
    const fgCol = currentTheme === 'cli' ? cliColors.text : '#818cf8';
    const playedCol = currentTheme === 'cli' ? cliColors.text : '#f43f5e';

    ctx.fillStyle = bgCol;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = fgCol;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    ctx.globalAlpha = 1.0;
    const len = peaks.length;
    const step = w / (len - 1);

    ctx.strokeStyle = fgCol;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
        const x = i * step;
        let amp = peaks[i] * (mid - 3);
        if (isPlaying) {
            amp *= (0.75 + 0.35 * Math.sin(Date.now() * 0.015 + i * 0.5));
        }
        const yTop = mid - amp;
        const yBot = mid + amp;
        if (i === 0) ctx.moveTo(x, yTop);
        else ctx.lineTo(x, yTop);
        ctx.lineTo(x, yBot);
    }
    ctx.stroke();

    if (isPlaying || progress > 0) {
        const playheadX = Math.min(w, Math.max(0, progress * w));
        ctx.strokeStyle = playedCol;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, h);
        ctx.stroke();
    }
}

export function startPerMessageWaveformAnimationLoop(getThemeState) {
    function tick() {
        requestAnimationFrame(tick);
        const { currentTheme, cliColors } = getThemeState();
        Object.keys(activeAudioElements).forEach(msgId => {
            const entry = activeAudioElements[msgId];
            if (entry && entry.isPlaying) {
                if (entry.audio && entry.audio.duration && !isNaN(entry.audio.duration)) {
                    entry.progress = entry.audio.currentTime / entry.audio.duration;
                } else {
                    entry.progress = ((entry.progress || 0) + 0.015) % 1;
                }
                drawMessageWaveformCanvas(msgId, currentTheme, cliColors);
            }
        });
    }
    requestAnimationFrame(tick);
}

export async function beginPTTRecording() {
    if (!micStream) await requestInitialAudioPermissions();
    currentRecordingPeaks = [];

    peakSampleInterval = setInterval(() => {
        if (analyser) {
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteTimeDomainData(data);
            let maxDev = 0;
            for (let i = 0; i < data.length; i++) {
                const d = Math.abs(data[i] - 128) / 128;
                if (d > maxDev) maxDev = d;
            }
            currentRecordingPeaks.push(Math.max(0.15, Math.min(0.95, maxDev * 2.2)));
        } else {
            currentRecordingPeaks.push(0.2 + Math.random() * 0.7);
        }
    }, 60);

    if (mediaRecorder && mediaRecorder.state === 'inactive') {
        audioChunks = [];
        mediaRecorder.start();
    }
}

export function endPTTRecording() {
    if (peakSampleInterval) clearInterval(peakSampleInterval);
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    } else if (!mediaRecorder) {
        const synthWav = createSyntheticVoiceWavBlob();
        const url = URL.createObjectURL(synthWav);
        const capturedPeaks = generateDetailedWaveformPeaks(48);
        if (onClipReadyCallback) onClipReadyCallback(url, synthWav, capturedPeaks);
    }
}

function createSyntheticVoiceWavBlob() {
    const sampleRate = 8000;
    const numSamples = sampleRate * 1.4;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const sample = (Math.sin(2 * Math.PI * 420 * t) + 0.5 * Math.sin(2 * Math.PI * 630 * t)) * Math.exp(-1.5 * t) * 0.25;
        view.setInt16(44 + i * 2, sample * 32767, true);
    }
    return new Blob([buffer], { type: 'audio/mp3' });
}

export function playBeepNotification(freq = 800, duration = 0.07) {
    const toggle = document.getElementById('audio-beeps-toggle');
    if (toggle && !toggle.checked) return;
    try {
        const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.06, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch (e) {}
}