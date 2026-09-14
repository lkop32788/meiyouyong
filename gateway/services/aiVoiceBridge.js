'use strict';

/**
 * AI Voice Bridge — ported from wabapanel's aiCallBridge.js / groqBridge.js,
 * adapted to OmniClick's gateway.
 *
 * Terminates the WhatsApp/Meta WebRTC call server-side (werift) and bridges its
 * Opus 48k audio to an AI voice engine:
 *   - openai       : OpenAI Realtime WebSocket (PCM16 24k, server VAD, barge-in)
 *   - groq_sarvam  : Groq Whisper STT → Groq LLM → Sarvam TTS (budget loop)
 *
 * Session lifecycle + transcripts are reported to the Laravel backend via its
 * internal API, and broadcast to the UI through the Redis event channel that
 * the realtime server already consumes.
 */

const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');
let OpusEncoder = null;
try { ({ OpusEncoder } = require('@discordjs/opus')); } catch { /* AI voice disabled without native opus */ }
const WebSocket = require('ws');

const GRAPH = 'https://graph.facebook.com/v21.0';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';

// active bridges keyed by Meta callId
const bridges = new Map();

const opusPT = (sdp) => {
    const m = (sdp || '').match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    return m ? parseInt(m[1], 10) : 111;
};

const nowIso = () => new Date().toISOString();

// ── Backend + UI notifications ────────────────────────────────────────────────

async function reportSession(deps, { sessionId, companyId, agentId, callId, status, patch }) {
    const { redis, logger } = deps;
    try {
        const base = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8000';
        await fetch(`${base}/internal/voice/session-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY || '' },
            body: JSON.stringify({ session_id: sessionId, call_id: callId, status, ...patch }),
        });
    } catch (e) {
        logger?.warn?.({ err: e.message }, '[voice] session-status report failed');
    }
    try {
        // UI event on the same Redis channel the realtime server consumes
        await redis.publish(`channel:events:${companyId}`, JSON.stringify({
            type: 'CALL_UPDATE',
            payload: { session_id: sessionId, call_id: callId, agent_id: agentId, status, ...patch },
        }));
    } catch { /* UI notification is best-effort */ }
}

// ── RTP plumbing ──────────────────────────────────────────────────────────────

// Re-originate RTP with our own continuous seq/ts/SSRC (Meta restarts streams
// mid-call with a new SSRC; passthrough would desync the destination SRTP).
const makeRewriter = (track, getPt) => {
    const st = { seq: Math.floor(Math.random() * 30000), ts: Math.floor(Math.random() * 1000000) >>> 0, lastSrcSsrc: null, lastSrcTs: null };
    return (rtp) => {
        try {
            const h = rtp.header;
            let delta = 960;
            if (st.lastSrcSsrc === h.ssrc && st.lastSrcTs !== null) {
                const d = (h.timestamp - st.lastSrcTs) >>> 0;
                if (d > 0 && d < 48000 * 5) delta = d;
            }
            st.lastSrcSsrc = h.ssrc;
            st.lastSrcTs = h.timestamp;
            st.ts = (st.ts + delta) >>> 0;
            st.seq = (st.seq + 1) & 0xffff;
            h.payloadType = getPt();
            h.sequenceNumber = st.seq;
            h.timestamp = st.ts;
            h.extension = false;
            h.extensions = [];
            h.csrc = [];
            h.csrcLength = 0;
            track.writeRtp(rtp);
        } catch { /* noop */ }
    };
};

// Smooth 20ms playback pacer — WS legs deliver audio in bursts.
function makePacer(send) {
    const FRAME = 20;
    const MAX_BACKLOG = 3000;
    const q = [];
    let timer = null;
    let nextAt = 0;
    const tick = () => {
        const now = Date.now();
        while (q.length && now >= nextAt) {
            const pkt = q.shift();
            try { send(pkt); } catch { /* noop */ }
            nextAt += FRAME;
        }
        if (!q.length && timer) { clearInterval(timer); timer = null; }
    };
    const pacer = (rtp) => {
        q.push(rtp);
        if (q.length > MAX_BACKLOG) q.splice(0, q.length - MAX_BACKLOG);
        if (!timer) { nextAt = Date.now(); timer = setInterval(tick, 5); }
    };
    pacer.stop = () => { if (timer) { clearInterval(timer); timer = null; } q.length = 0; };
    return pacer;
}

// werift only routes SSRCs announced in the SDP; route unknown audio SSRCs
// (Meta restarts) to the audio receiver so audio never dies mid-call.
function patchRouter(pc) {
    try {
        const router = pc.router;
        const orig = router.routeRtp;
        router.routeRtp = (packet) => {
            const ssrc = packet.header.ssrc;
            if (!router.ssrcTable[ssrc]) {
                const tr = pc.getTransceivers().find((t) => t.kind === 'audio');
                const receiver = tr && tr.receiver;
                if (receiver) {
                    let track = receiver.tracks[0];
                    if (!track) {
                        track = new MediaStreamTrack({ kind: 'audio', remote: true });
                        tr.addTrack(track);
                    }
                    receiver.trackBySSRC[ssrc] = track;
                    router.registerRtpReceiver(receiver, ssrc);
                }
            }
            return orig(packet);
        };
    } catch { /* noop */ }
}

// Build the Meta peer that answers the customer's offer SDP.
async function connectMeta({ offerSdp, onCustomerRtp }) {
    const pc = new RTCPeerConnection();
    patchRouter(pc);
    const localTrack = new MediaStreamTrack({ kind: 'audio' });
    pc.addTransceiver(localTrack, { direction: 'sendrecv' });
    pc.onTrack.subscribe((remote) => {
        remote.onReceiveRtp.subscribe((rtp) => { try { onCustomerRtp(rtp); } catch { /* noop */ } });
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { pc, localTrack, answerSdp: pc.localDescription.sdp, metaPT: opusPT(offerSdp) };
}

// Build the Meta peer for a business-initiated call (our offer; answer later).
async function connectMetaOffer({ onCustomerRtp }) {
    const pc = new RTCPeerConnection();
    patchRouter(pc);
    const localTrack = new MediaStreamTrack({ kind: 'audio' });
    pc.addTransceiver(localTrack, { direction: 'sendrecv' });
    pc.onTrack.subscribe((remote) => {
        remote.onReceiveRtp.subscribe((rtp) => { try { onCustomerRtp(rtp); } catch { /* noop */ } });
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return { pc, localTrack, offerSdp: pc.localDescription.sdp, metaPT: null };
}

// ── OpenAI Realtime leg ───────────────────────────────────────────────────────

async function connectOpenAI({ apiKey, instructions, greeting, voice, onAiRtp, context, maxDurationSec }) {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    const dc = {
        send: (s) => { if (ws.readyState === WebSocket.OPEN) ws.send(s); },
        get readyState() { return ws.readyState === WebSocket.OPEN ? 'open' : 'closed'; },
    };
    if (context) context._dc = dc;

    // AI audio out: PCM16 24k deltas → Opus → RTP (48k clock, 960 ts/20ms)
    const encoder = new OpusEncoder(24000, 1);
    try { encoder.applyEncoderCTL(4002, 64000); } catch { /* OPUS_SET_BITRATE */ }
    const OUT_SSRC = (Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    let outSeq = Math.floor(Math.random() * 30000);
    let outTs = Math.floor(Math.random() * 1000000) >>> 0;
    let outBuf = Buffer.alloc(0);
    const pushAiAudio = (b64) => {
        const pcm24 = Buffer.from(b64, 'base64');
        outBuf = outBuf.length ? Buffer.concat([outBuf, pcm24]) : pcm24;
        const FRAME = 480 * 2; // 20ms @24k mono s16
        while (outBuf.length >= FRAME) {
            const frame = outBuf.subarray(0, FRAME);
            outBuf = outBuf.subarray(FRAME);
            let payload;
            try { payload = encoder.encode(frame); } catch { continue; }
            outSeq = (outSeq + 1) & 0xffff;
            outTs = (outTs + 960) >>> 0;
            const pkt = new RtpPacket(new RtpHeader({ ssrc: OUT_SSRC, payloadType: 111, sequenceNumber: outSeq, timestamp: outTs }), payload);
            try { onAiRtp(pkt); } catch { /* noop */ }
        }
    };
    const clearAiAudio = () => { outBuf = Buffer.alloc(0); };

    // Customer audio in: Opus RTP → PCM16 24k → input_audio_buffer.append
    const decoder = new OpusEncoder(24000, 1);
    let inBatch = [];
    let inFlushTimer = null;
    const flushIn = () => {
        if (!inBatch.length) return;
        const buf = Buffer.concat(inBatch);
        inBatch = [];
        dc.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
    };
    const localTrack = {
        writeRtp: (rtp) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            let pcm24;
            try { pcm24 = decoder.decode(rtp.payload); } catch { return; }
            inBatch.push(pcm24);
            if (inBatch.length >= 3) flushIn();
            else { clearTimeout(inFlushTimer); inFlushTimer = setTimeout(flushIn, 80); }
        },
    };

    const pingTimer = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.ping(); } catch { /* noop */ } }, 15000);
    const pc = {
        close: () => { clearInterval(pingTimer); try { ws.close(); } catch { /* noop */ } },
        get connectionState() { return ws.readyState === WebSocket.OPEN ? 'connected' : 'closed'; },
        connectionStateChange: { subscribe: () => {} },
    };

    ws.on('message', async (raw) => {
        try {
            const ev = JSON.parse(raw.toString());
            if (ev.type === 'response.output_audio.delta' && ev.delta) {
                if (context) context._aiSpeaking = true;
                pushAiAudio(ev.delta);
            }
            if (ev.type === 'input_audio_buffer.speech_started') {
                clearAiAudio(); // caller barged in
                if (context) { context._lastSpeechDetected = Date.now(); context._aiSpeaking = false; }
            }
            if (ev.type === 'response.created' && context) context._responseActive = true;
            if (ev.type === 'response.done' && context) {
                context._responseActive = false;
                context._lastResponseDone = Date.now();
                if ((ev.response?.output || []).length > 0) context._lastContentResponse = Date.now();
                setTimeout(() => { if (context) context._aiSpeaking = false; }, 500);
            }
            if (ev.type === 'response.output_audio_transcript.done' && ev.transcript && context) {
                context.transcript.push({ role: 'assistant', text: ev.transcript });
            }
            if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript && context) {
                context.transcript.push({ role: 'user', text: ev.transcript });
            }
            if (ev.type === 'response.function_call_arguments.done') {
                const result = await executeVoiceTool(ev.name, JSON.parse(ev.arguments || '{}'), context || {});
                dc.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) },
                }));
                dc.send(JSON.stringify({ type: 'response.create' }));
            }
            if (ev.type === 'error') context?.deps?.logger?.warn?.({ err: JSON.stringify(ev).slice(0, 300) }, '[voice] realtime error event');
        } catch { /* non-JSON */ }
    });
    ws.on('close', () => clearInterval(pingTimer));
    ws.on('error', () => { /* handled by watchdogs */ });

    const sessionConfig = {
        type: 'realtime',
        instructions: (instructions || '你是客服语音助手。像真人接线员一样自然对话，回复简短（1-2 句），一次只问一个问题。')
            + '\n\nSTYLE: 像真人打电话一样自然，口语化，不要像 AI。只在客户说话后回应，不主动开启新话题。'
            + '\n\nLANGUAGE: 默认说简体中文；客户换语言就跟换。',
        audio: {
            input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'whisper-1' },
                turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
            },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: voice || 'alloy' },
        },
        tools: [
            {
                type: 'function',
                name: 'send_whatsapp_message',
                description: '在通话中应客户要求，给客户发送一条 WhatsApp 文字消息（如链接、地址、价格等）。',
                parameters: { type: 'object', properties: { text: { type: 'string', description: '要发送的消息内容' } }, required: ['text'] },
            },
            {
                type: 'function',
                name: 'transfer_to_human',
                description: '客户要求人工客服时调用。调用后告知客户稍后会有同事联系。',
                parameters: { type: 'object', properties: {}, required: [] },
            },
            {
                type: 'function',
                name: 'end_call',
                description: '客户明确说再见/结束通话，或问题已解决时调用。',
                parameters: { type: 'object', properties: {}, required: [] },
            },
        ],
    };
    ws.on('open', () => {
        dc.send(JSON.stringify({ type: 'session.update', session: sessionConfig }));
        if (greeting) {
            dc.send(JSON.stringify({ type: 'response.create', response: { instructions: `向客户问好并说明来意：「${greeting}」之后正常对话。` } }));
        }
    });

    return { pc, localTrack, oaiPT: 111, ws, clearAiAudio };
}

// ── Voice tools (OpenAI path) ─────────────────────────────────────────────────

async function sendWaText(ctx, to, text) {
    try {
        await fetch(`${GRAPH}/${ctx.phoneNumberId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function executeVoiceTool(name, args, ctx) {
    if (name === 'send_whatsapp_message') {
        const r = await sendWaText(ctx, ctx.phone, args.text || '');
        return r.ok ? { ok: true, sent: true } : { ok: false, error: r.error };
    }
    if (name === 'transfer_to_human') {
        if (ctx.transferNumber) {
            await sendWaText(ctx, ctx.phone, `稍后会有同事通过 WhatsApp（${ctx.transferNumber}）与您联系，请留意消息。`);
        }
        ctx.transferRequested = true;
        return { ok: true, transferred: true };
    }
    if (name === 'end_call') {
        ctx.endRequested = true;
        return { ok: true };
    }
    return { ok: false, error: 'unknown tool' };
}

// ── Groq/Sarvam budget leg ────────────────────────────────────────────────────

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const SARVAM_SPEAKERS = ['priya', 'karun', 'hitesh', 'radha', 'arya', 'amol', 'shaan', 'peter', 'pooja'];
const FRAME_20MS_48K = 960; // samples

function rmsEnergy(pcm16) {
    const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.length / 2));
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (samples.length || 1));
}

function downsample48kTo16k(pcm48) {
    const src = new Int16Array(pcm48.buffer, pcm48.byteOffset, Math.floor(pcm48.length / 2));
    const out = new Int16Array(Math.floor(src.length / 3));
    for (let i = 0; i < out.length; i++) out[i] = src[i * 3];
    return Buffer.from(out.buffer);
}

function wavHeader(dataLen) {
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
    return buf;
}

function resampleTo48k(pcm, srcRate) {
    if (srcRate === 48000) return pcm;
    const src = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const out = new Int16Array(Math.floor(src.length * 48000 / srcRate));
    const ratio = srcRate / 48000;
    for (let i = 0; i < out.length; i++) {
        const idx = Math.min(src.length - 1, Math.floor(i * ratio));
        out[i] = src[idx];
    }
    return Buffer.from(out.buffer);
}

class GroqSarvamBridge {
    constructor({ groqApiKey, sarvamApiKey, voiceId, instructions, greeting, onRtp, deps }) {
        this.groq = groqApiKey;
        this.sarvam = sarvamApiKey;
        this.voiceId = SARVAM_SPEAKERS.includes((voiceId || '').toLowerCase()) ? voiceId.toLowerCase() : 'priya';
        this.instructions = instructions || '你是客服语音助手，回复保持简短口语化。';
        this.history = [];
        this.onRtp = onRtp;
        this.deps = deps;

        this.dec = new OpusEncoder(48000, 1);
        this.enc = new OpusEncoder(48000, 1);
        this.speechBuf = [];
        this.silenceMs = 0;
        this.sawSpeech = false;
        this.busy = false;
        this.closed = false;
        this.outSSRC = (Math.floor(Math.random() * 0x7fffffff)) >>> 0;
        this.outSeq = Math.floor(Math.random() * 30000);
        this.outTs = Math.floor(Math.random() * 1000000) >>> 0;

        // greet immediately
        this.speak(greeting || '您好！请问有什么可以帮您？');
    }

    feedCustomerRtp(rtp) {
        if (this.closed) return;
        let pcm48;
        try { pcm48 = this.dec.decode(rtp.payload); } catch { return; }
        const energy = rmsEnergy(pcm48);
        if (energy > 300) {
            this.speechBuf.push(pcm48);
            this.silenceMs = 0;
            this.sawSpeech = true;
        } else if (this.speechBuf.length) {
            this.silenceMs += 20;
            this.speechBuf.push(pcm48); // keep trailing silence for natural STT
            if (this.silenceMs >= 800) this.flushTurn();
        }
        // hard cap: 30s of audio per turn
        if (this.speechBuf.length > 1500) this.flushTurn();
    }

    flushTurn() {
        if (this.busy || !this.sawSpeech || this.closed) { this.speechBuf = []; this.sawSpeech = false; this.silenceMs = 0; return; }
        const pcm48 = Buffer.concat(this.speechBuf);
        this.speechBuf = [];
        this.sawSpeech = false;
        this.silenceMs = 0;
        if (pcm48.length < 4800 * 4) return; // <400ms of speech — ignore
        this.busy = true;
        this.processTurn(pcm48)
            .catch((e) => this.deps?.logger?.warn?.({ err: e.message }, '[voice][groq] turn failed'))
            .finally(() => { this.busy = false; });
    }

    async processTurn(pcm48) {
        const wav16k = Buffer.concat([wavHeader(pcm48.length / 3), downsample48kTo16k(pcm48)]);
        // 1. STT
        const form = new FormData();
        form.append('file', new Blob([wav16k], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', 'whisper-large-v3');
        const sttResp = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.groq}` },
            body: form,
        });
        if (!sttResp.ok) throw new Error(`STT ${sttResp.status}`);
        const stt = await sttResp.json();
        const userText = (stt.text || '').trim();
        if (!userText) return;
        this.transcript.push({ role: 'user', text: userText });

        // 2. LLM
        const chatResp = await fetch(`${GROQ_BASE}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.groq}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: this.instructions },
                    ...this.history.slice(-10),
                    { role: 'user', content: userText },
                ],
                max_tokens: 300,
                temperature: 0.5,
            }),
        });
        if (!chatResp.ok) throw new Error(`LLM ${chatResp.status}`);
        const chat = await chatResp.json();
        const reply = (chat.choices?.[0]?.message?.content || '').trim();
        if (!reply) return;
        this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
        this.transcript.push({ role: 'assistant', text: reply });

        // 3. TTS
        await this.speak(reply);
    }

    async speak(text) {
        const resp = await fetch('https://api.sarvam.ai/text-to-speech', {
            method: 'POST',
            headers: { 'api-subscription-key': this.sarvam, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model: 'bulbul:v3', speaker: this.voiceId, target_language_code: 'hi-IN', speech_sample_rate: 48000 }),
        });
        if (!resp.ok) throw new Error(`Sarvam TTS ${resp.status}`);
        const body = await resp.json();
        const wav = Buffer.from(body.audios?.[0] || '', 'base64');
        if (wav.length <= 44) return;
        const pcm48 = resampleTo48k(wav.subarray(44), 48000);
        this.playPcm(pcm48);
    }

    playPcm(pcm48) {
        const FRAME = FRAME_20MS_48K * 2;
        for (let off = 0; off + FRAME <= pcm48.length; off += FRAME) {
            let payload;
            try { payload = this.enc.encode(pcm48.subarray(off, off + FRAME)); } catch { continue; }
            this.outSeq = (this.outSeq + 1) & 0xffff;
            this.outTs = (this.outTs + 960) >>> 0;
            const pkt = new RtpPacket(new RtpHeader({ ssrc: this.outSSRC, payloadType: 111, sequenceNumber: this.outSeq, timestamp: this.outTs }), payload);
            try { this.onRtp(pkt); } catch { /* noop */ }
        }
    }

    close() { this.closed = true; }
}
function buildInstructions(agent) {
    let t = agent.system_prompt || '';
    if (agent.transfer_number) t += '\n\n如客户要求人工客服，调用 transfer_to_human 工具。';
    return t;
}

// Attach session bookkeeping to deps so reportSession/finishSession can use it.
function withSession(deps, session) {
    return { ...deps, _session: session, _transcript: session.transcript, _startedAt: Date.now(), _summaryKey: session.summaryKey, _summaryBase: session.summaryBase, _summaryModel: session.summaryModel };
}

// ── Inbound (customer called us) ──────────────────────────────────────────────

async function startInbound(cfg) {
    const { callId, offerSdp, agent, backend, deps } = cfg;
    if (bridges.has(callId)) return { ok: true, already: true };
    if (!OpusEncoder) return { ok: false, error: 'AI voice requires @discordjs/opus (not installed)' };

    const context = {
        phone: cfg.from,
        transcript: [],
        accessToken: cfg.access_token,
        phoneNumberId: cfg.phone_number_id,
        transferNumber: agent.transfer_number || null,
    };

    let meta, oai, toAi, toMeta;
    const pace = makePacer((rtp) => { if (toMeta) toMeta(rtp); });

    const cleanup = once(() => {
        clearInterval(context.statTimer);
        try { oai?.pc?.close(); } catch { /* noop */ }
        try { meta?.pc?.close(); } catch { /* noop */ }
        pace.stop();
        bridges.delete(callId);
        finishSession(backend, { status: 'completed' });
    });

    meta = await connectMeta({
        offerSdp,
        onCustomerRtp: (rtp) => { if (toAi) toAi(rtp); },
    });

    if (agent.engine === 'groq_sarvam') {
        if (!agent.groq_api_key || !agent.sarvam_api_key) {
            return { ok: false, error: 'groq_sarvam 引擎需要 Groq API Key 和 Sarvam API Key' };
        }
        const bridge = new GroqSarvamBridge({
            groqApiKey: agent.groq_api_key,
            sarvamApiKey: agent.sarvam_api_key,
            voiceId: agent.voice_id,
            instructions: buildInstructions(agent),
            greeting: agent.greeting,
            onRtp: pace,
            deps,
        });
        bridge.transcript = context.transcript;
        context.bridge = bridge;
        toAi = (rtp) => bridge.feedCustomerRtp(rtp);
    } else {
        if (!cfg.realtime_api_key) return { ok: false, error: '缺少 OpenAI Realtime API Key（在语音坐席里配置，或设置 OPENAI_API_KEY）' };
        oai = await connectOpenAI({
            apiKey: cfg.realtime_api_key,
            instructions: buildInstructions(agent),
            greeting: agent.greeting,
            voice: agent.voice,
            onAiRtp: pace,
            context,
        });
        toAi = makeRewriter(oai.localTrack, () => oai.oaiPT);
    }

    toMeta = makeRewriter(meta.localTrack, () => meta.metaPT);

    // Accept the call: hand our SDP answer to Meta
    await fetch(`${GRAPH}/${cfg.phone_number_id}/calls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', call_id: callId, action: 'accept', session: { sdp_type: 'answer', sdp: meta.answerSdp } }),
    });

    // Max duration + graceful end (end_call tool)
    const sessionDeps = withSession(backend, {
        sessionId: cfg.sessionId, companyId: cfg.company_id, agentId: agent.id, callId,
        transcript: context.transcript,
        summaryKey: cfg.summary_key, summaryBase: cfg.summary_base, summaryModel: cfg.summary_model,
    });
    const startedAt = Date.now();
    context.statTimer = setInterval(() => {
        if (Date.now() - startedAt > (agent.max_duration_seconds || 300) * 1000 || context.endRequested) {
            terminate({ ...cfg, callId }).finally(cleanup);
            return;
        }
    }, 5000);

    meta.pc.connectionStateChange.subscribe((s) => {
        if (['closed', 'disconnected', 'failed'].includes(s)) cleanup();
    });

    bridges.set(callId, { meta, oai, pace, context, cleanup, startedAt, sessionDeps });
    reportSession(deps, { sessionId: cfg.sessionId, companyId: cfg.company_id, agentId: agent.id, callId, status: 'ai-connected' }).catch(() => {});
    return { ok: true };
}

// ── Outbound (business-initiated; answer SDP arrives later via webhook) ──────

const pendingOutbound = new Map();

async function startOutbound(cfg) {
    if (!OpusEncoder) return { ok: false, error: 'AI voice requires @discordjs/opus (not installed)' };
    const { agent, backend, deps } = cfg;

    const context = {
        phone: cfg.to,
        transcript: [],
        accessToken: cfg.access_token,
        phoneNumberId: cfg.phone_number_id,
        transferNumber: agent.transfer_number || null,
    };

    let toAi = null;
    let toMeta = null;
    const pace = makePacer((rtp) => { if (toMeta) toMeta(rtp); });
    const meta = await connectMetaOffer({
        onCustomerRtp: (rtp) => { if (toAi) toAi(rtp); },
    });

    // Offer → Meta Calls API
    const resp = await fetch(`${GRAPH}/${cfg.phone_number_id}/calls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: cfg.to,
            action: 'connect',
            session: { sdp_type: 'offer', sdp: meta.offerSdp },
        }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        try { meta.pc.close(); } catch { /* noop */ }
        pace.stop();
        const err = body?.error?.message || `HTTP ${resp.status}`;
        let hint = '';
        if (body?.error?.code === 138006) hint = '（客户未授权来电，需先请求通话权限）';
        if (body?.error?.code === 138000) hint = '（该 WhatsApp 号码未开通通话功能）';
        if (body?.error?.code === 138013) hint = '（该地区不支持商家外呼）';
        return { ok: false, error: err + hint };
    }
    const callId = body?.calls?.[0]?.id;
    if (!callId) {
        try { meta.pc.close(); } catch { /* noop */ }
        pace.stop();
        return { ok: false, error: 'Meta Calls API 未返回 call id' };
    }

    // Park the half-built bridge until Meta's answer SDP arrives via webhook
    pendingOutbound.set(callId, { cfg, meta, pace, context, setToAi: (fn) => { toAi = fn; } });

    // Safety: drop pending after 60s if the customer never answers
    setTimeout(() => {
        const p = pendingOutbound.get(callId);
        if (p) {
            pendingOutbound.delete(callId);
            try { p.meta.pc.close(); } catch { /* noop */ }
            p.pace.stop();
        }
    }, 60000);

    return { ok: true, call_id: callId, to: cfg.to };
}

// Called from the calls webhook when Meta delivers the answer SDP for our offer.
async function completeOutbound(callId, answerSdp) {
    const p = pendingOutbound.get(callId);
    if (!p) return false;
    pendingOutbound.delete(callId);
    const { cfg, meta, pace, context, setToAi } = p;
    const { agent, deps } = cfg;

    await meta.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    let oai = null;
    if (agent.engine === 'groq_sarvam') {
        const bridge = new GroqSarvamBridge({
            groqApiKey: agent.groq_api_key,
            sarvamApiKey: agent.sarvam_api_key,
            voiceId: agent.voice_id,
            instructions: buildInstructions(agent),
            greeting: agent.greeting,
            onRtp: pace,
            deps,
        });
        bridge.transcript = context.transcript;
        context.bridge = bridge;
        setToAi((rtp) => bridge.feedCustomerRtp(rtp));
    } else {
        if (!cfg.realtime_api_key) throw new Error('缺少 OpenAI Realtime API Key');
        oai = await connectOpenAI({
            apiKey: cfg.realtime_api_key,
            instructions: buildInstructions(agent),
            greeting: agent.greeting,
            voice: agent.voice,
            onAiRtp: pace,
            context,
        });
        setToAi(makeRewriter(oai.localTrack, () => oai.oaiPT));
    }

    const cleanup = once(() => {
        clearInterval(context.statTimer);
        try { oai?.pc?.close(); } catch { /* noop */ }
        try { meta?.pc?.close(); } catch { /* noop */ }
        pace.stop();
        bridges.delete(callId);
        finishSession(cfg.backend, { status: 'completed' });
    });

    const sessionDeps = withSession(cfg.backend, {
        sessionId: cfg.sessionId, companyId: cfg.company_id, agentId: agent.id, callId,
        transcript: context.transcript,
        summaryKey: cfg.summary_key, summaryBase: cfg.summary_base, summaryModel: cfg.summary_model,
    });
    const startedAt = Date.now();
    context.statTimer = setInterval(() => {
        if (Date.now() - startedAt > (agent.max_duration_seconds || 300) * 1000 || context.endRequested) {
            terminate({ ...cfg, callId }).finally(cleanup);
            return;
        }
    }, 5000);

    meta.pc.connectionStateChange.subscribe((s) => {
        if (['closed', 'disconnected', 'failed'].includes(s)) cleanup();
    });

    bridges.set(callId, { meta, oai, pace, context, cleanup, startedAt, sessionDeps });
    reportSession(deps, { sessionId: cfg.sessionId, companyId: cfg.company_id, agentId: agent.id, callId, status: 'ai-connected' }).catch(() => {});
    return true;
}

async function terminate(cfg) {
    try {
        await fetch(`${GRAPH}/${cfg.phone_number_id}/calls`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', call_id: cfg.callId, action: 'terminate' }),
        });
    } catch { /* noop */ }
}

// Stop a bridge (webhook terminate event or backend request).
function stop(callId) {
    const b = bridges.get(callId);
    if (!b) return false;
    if (b.cleanup) b.cleanup();
    else {
        clearInterval(b?.context?.statTimer);
        try { b.oai?.pc?.close(); } catch { /* noop */ }
        try { b.meta?.pc?.close(); } catch { /* noop */ }
        b.pace?.stop?.();
        bridges.delete(callId);
    }
    return true;
}

function once(fn) {
    let called = false;
    return (...args) => {
        if (called) return;
        called = true;
        try { fn(...args); } catch { /* noop */ }
    };
}

// On bridge end: write transcript + duration + AI summary to the backend.
async function finishSession(deps, { status }) {
    if (!deps?._session) return;
    const { sessionId, companyId, agentId, callId, transcript, summaryKey, summaryBase, summaryModel } = deps._session;
    let duration = deps._startedAt ? Math.round((Date.now() - deps._startedAt) / 1000) : 0;

    let summary = null;
    const lastText = (transcript || []).map((t) => `${t.role === 'user' ? '客户' : '坐席'}: ${t.text}`).join('\n').slice(0, 4000);
    if (lastText && summaryKey && summaryBase) {
        try {
            const r = await fetch(`${summaryBase}/chat/completions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${summaryKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: summaryModel || 'gpt-4o-mini',
                    messages: [{ role: 'user', content: `用 2-3 句简体中文总结这次客服电话：\n${lastText}` }],
                    max_tokens: 150,
                }),
            });
            if (r.ok) summary = (await r.json()).choices?.[0]?.message?.content?.trim() || null;
        } catch { /* summary is best-effort */ }
    }

    await reportSession(deps, {
        sessionId, companyId, agentId, callId,
        status,
        patch: { transcript, duration_seconds: duration, summary, ended: true },
    });
}

module.exports = { startInbound, startOutbound, completeOutbound, stop, _bridges: bridges };
