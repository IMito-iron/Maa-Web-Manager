// Browser side of the low-latency Android stream.
//
// One WebSocket to /media/ws carries signalling and statistics. Video arrives over WebRTC when the
// network allows it; if ICE does not connect in time (or fails later) the same session switches to
// H.264 over that WebSocket, decoded with WebCodecs. Input goes over a WebRTC data channel when
// one is open, otherwise over the WebSocket. The server decides whether input is accepted.

import {avcCodecString} from './streamInput';
import type {InputEvent} from './streamInput';

export type Transport = 'webrtc' | 'ws';
export type Mode = 'view' | 'control';

export type ClientStats = {
  transport: Transport;
  pair?: string;            // WebRTC candidate pair, e.g. "host/udp"
  receiveFps?: number;      // frames arriving at the browser
  decodeFps?: number;
  renderFps?: number;       // frames actually presented
  kbps?: number;
  lossPct?: number;
  rttMs?: number;
  jitterBufferMs?: number;
  decodeMs?: number;
  framesDropped?: number;
  width?: number;
  height?: number;
};

export type SessionEvents = {
  onState?: (state: string, detail?: string) => void;
  onControl?: (active: boolean, reason?: string) => void;
  onStats?: (client: ClientStats, server: any) => void;
  onProfile?: (profile: string) => void;
};

const RTC_CONNECT_TIMEOUT_MS = 6000;

export class MediaSession {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private decoder?: VideoDecoder;
  private codec?: string;
  private closed = false;
  private transport: Transport = 'webrtc';
  private rtcTimer?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private rendered = 0;
  private wsReceived = 0;
  private wsBytes = 0;
  private wsDecoded = 0;
  private decodeTimeSum = 0;
  private decodeInFlight = new Map<number, number>();
  private rttMs?: number;
  private prev?: {at: number; bytes: number; recv: number; dec: number; rendered: number; lost: number; pkts: number; jb: number; jbn: number; dt: number; wsRecv: number; wsDec: number; wsBytes: number};
  private lastServer: any = null;
  private rvfc?: number;
  private needKey = true;
  private profile: string;

  constructor(private video: HTMLVideoElement, private canvas: HTMLCanvasElement, profile: string,
    private mode: Mode, private events: SessionEvents, private preferWs = false) {
    this.profile = profile;
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/media/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.events.onState?.('connecting');
    ws.onopen = () => {
      this.transport = this.preferWs || typeof RTCPeerConnection === 'undefined' ? 'ws' : 'webrtc';
      this.sendJSON({type: 'hello', transport: this.transport, profile: this.profile, mode: this.mode});
    };
    ws.onmessage = event => {
      if (typeof event.data !== 'string') return this.onBinary(new Uint8Array(event.data));
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = () => { if (!this.closed) this.events.onState?.('closed', 'disconnected'); this.teardownMedia(); };
    this.statsTimer = setInterval(() => void this.collectStats(), 1000);
    this.pingTimer = setInterval(() => this.sendJSON({type: 'ping', t: performance.now()}), 2000);
    this.countRendered();
  }

  private sendJSON(v: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(v)); }

  private async onMessage(msg: any) {
    switch (msg.type) {
      case 'ready':
        this.transport = msg.transport;
        this.events.onProfile?.(msg.profile);
        if (msg.transport === 'webrtc') await this.startRTC(msg.iceServers || []);
        else this.startWS();
        break;
      case 'answer':
        try { await this.pc?.setRemoteDescription({type: 'answer', sdp: msg.sdp}); }
        catch (e: any) { this.fallback('answer rejected: ' + e?.message); }
        break;
      case 'rtc-state':
        if (msg.state === 'failed') this.fallback('ICE failed');
        break;
      case 'control':
        this.events.onControl?.(!!msg.active, msg.reason);
        break;
      case 'profile':
        this.profile = msg.profile;
        this.events.onProfile?.(msg.profile);
        break;
      case 'pong':
        this.rttMs = performance.now() - msg.t;
        break;
      case 'stats':
        this.lastServer = msg;
        break;
      case 'error':
        this.events.onState?.('error', msg.message);
        break;
    }
  }

  // ---- WebRTC ----

  private async startRTC(iceServers: RTCIceServer[]) {
    const pc = new RTCPeerConnection({iceServers, bundlePolicy: 'max-bundle'});
    this.pc = pc;
    pc.addTransceiver('video', {direction: 'recvonly'});
    this.dc = pc.createDataChannel('input', {ordered: true});
    pc.ontrack = event => {
      const [stream] = event.streams.length ? event.streams : [new MediaStream([event.track])];
      this.video.srcObject = stream;
      this.applyLatencyHint();
      void this.video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(this.rtcTimer);
        this.events.onState?.('playing', 'webrtc');
      }
      if (pc.connectionState === 'failed') this.fallback('ICE failed');
    };
    this.rtcTimer = setTimeout(() => { if (pc.connectionState !== 'connected') this.fallback('ICE timeout'); }, RTC_CONNECT_TIMEOUT_MS);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { if (pc.iceGatheringState === 'complete') resolve(); };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 2000); // do not wait for slow/blocked STUN
    });
    this.sendJSON({type: 'offer', sdp: pc.localDescription?.sdp});
  }

  /** Control wants the smallest jitter buffer; watchers keep the browser default for smoothness. */
  private applyLatencyHint() {
    for (const r of this.pc?.getReceivers() ?? []) {
      const receiver = r as any;
      const target = this.mode === 'control' ? 0 : null;
      try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = target; } catch {}
      try { if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = this.mode === 'control' ? 0 : undefined; } catch {}
    }
  }

  private fallback(reason: string) {
    if (this.transport === 'ws' || this.closed) return;
    this.events.onState?.('fallback', reason);
    this.transport = 'ws';
    this.closeRTC();
    this.sendJSON({type: 'transport', transport: 'ws'});
  }

  private closeRTC() {
    clearTimeout(this.rtcTimer);
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.pc = undefined; this.dc = undefined;
    this.video.srcObject = null;
  }

  // ---- H.264 over WebSocket ----

  private startWS() {
    if (typeof VideoDecoder === 'undefined') {
      this.events.onState?.('error', 'nowebcodecs');
      return;
    }
    this.needKey = true;
    this.events.onState?.('playing', 'ws');
  }

  private makeDecoder(codec: string) {
    this.decoder?.close?.();
    const ctx = this.canvas.getContext('2d');
    this.decoder = new VideoDecoder({
      output: frame => {
        const started = this.decodeInFlight.get(frame.timestamp);
        if (started != null) { this.decodeTimeSum += performance.now() - started; this.decodeInFlight.delete(frame.timestamp); }
        this.wsDecoded++;
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
          this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight;
        }
        ctx?.drawImage(frame, 0, 0);
        this.rendered++;
        frame.close();
      },
      error: () => { this.needKey = true; this.sendJSON({type: 'keyframe'}); },
    });
    this.decoder.configure({codec, optimizeForLatency: true} as VideoDecoderConfig);
    this.codec = codec;
  }

  private onBinary(buf: Uint8Array) {
    if (buf.length < 18 || this.transport !== 'ws') return;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const key = (buf[0] & 1) === 1;
    const pts = Number(view.getBigUint64(1));
    const au = buf.subarray(17);
    this.wsReceived++;
    this.wsBytes += au.length;
    if (key) {
      const codec = avcCodecString(au);
      if (codec && (codec !== this.codec || !this.decoder || this.decoder.state === 'closed')) this.makeDecoder(codec);
      this.needKey = false;
    }
    if (this.needKey || !this.decoder || this.decoder.state !== 'configured') return;
    // A decoder that falls behind adds latency; drop to the next key frame instead.
    if (this.decoder.decodeQueueSize > (this.mode === 'control' ? 2 : 8)) {
      this.needKey = true; this.sendJSON({type: 'keyframe'}); return;
    }
    this.decodeInFlight.set(pts, performance.now());
    if (this.decodeInFlight.size > 120) this.decodeInFlight.clear();
    try { this.decoder.decode(new EncodedVideoChunk({type: key ? 'key' : 'delta', timestamp: pts, data: au})); }
    catch { this.needKey = true; this.sendJSON({type: 'keyframe'}); }
  }

  // ---- control & input ----

  setMode(mode: Mode) {
    this.mode = mode;
    this.applyLatencyHint();
    this.sendJSON({type: 'mode', mode});
  }

  setProfile(profile: string) { this.sendJSON({type: 'profile', profile}); }

  sendInput(event: InputEvent) {
    const payload = JSON.stringify(event);
    if (this.dc?.readyState === 'open') this.dc.send(payload);
    else this.sendJSON({type: 'input', input: event});
  }

  get currentTransport() { return this.transport; }

  // ---- statistics ----

  private countRendered() {
    const video = this.video as any;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = () => { if (this.closed) return; this.rendered++; this.rvfc = video.requestVideoFrameCallback(tick); };
      this.rvfc = video.requestVideoFrameCallback(tick);
    }
  }

  private async collectStats() {
    const now = performance.now();
    const out: ClientStats = {transport: this.transport, rttMs: this.rttMs};
    let bytes = 0, recv = 0, dec = 0, lost = 0, pkts = 0, jb = 0, jbn = 0, dt = 0;
    if (this.pc && this.transport === 'webrtc') {
      const report: any = await this.pc.getStats();
      let pairId: string | undefined;
      report.forEach((s: any) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          bytes = s.bytesReceived ?? 0; recv = s.framesReceived ?? 0; dec = s.framesDecoded ?? 0;
          lost = s.packetsLost ?? 0; pkts = s.packetsReceived ?? 0; jb = s.jitterBufferDelay ?? 0;
          jbn = s.jitterBufferEmittedCount ?? 0; dt = s.totalDecodeTime ?? 0;
          out.framesDropped = s.framesDropped; out.width = s.frameWidth; out.height = s.frameHeight;
        }
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      if (pairId) {
        const pair: any = report.get(pairId);
        const local: any = pair && report.get(pair.localCandidateId);
        const remote: any = pair && report.get(pair.remoteCandidateId);
        if (pair?.currentRoundTripTime != null) out.rttMs = pair.currentRoundTripTime * 1000;
        if (local && remote) out.pair = `${local.candidateType}/${local.protocol} ↔ ${remote.candidateType}`;
      }
    } else {
      out.width = this.canvas.width || undefined; out.height = this.canvas.height || undefined;
    }
    const p = this.prev;
    if (p) {
      const s = (now - p.at) / 1000;
      if (this.transport === 'webrtc') {
        out.receiveFps = (recv - p.recv) / s;
        out.decodeFps = (dec - p.dec) / s;
        out.kbps = (bytes - p.bytes) * 8 / s / 1000;
        const dl = lost - p.lost, dp = pkts - p.pkts;
        out.lossPct = dl + dp > 0 ? 100 * Math.max(0, dl) / (dl + dp) : 0;
        out.jitterBufferMs = jbn > p.jbn ? (jb - p.jb) * 1000 / (jbn - p.jbn) : undefined;
        out.decodeMs = dec > p.dec ? (dt - p.dt) * 1000 / (dec - p.dec) : undefined;
      } else {
        out.receiveFps = (this.wsReceived - p.wsRecv) / s;
        out.decodeFps = (this.wsDecoded - p.wsDec) / s;
        out.kbps = (this.wsBytes - p.wsBytes) * 8 / s / 1000;
        out.decodeMs = this.wsDecoded > p.wsDec ? this.decodeTimeSum / (this.wsDecoded - p.wsDec) : undefined;
        this.decodeTimeSum = 0;
      }
      out.renderFps = (this.rendered - p.rendered) / s;
    }
    this.prev = {at: now, bytes, recv, dec, rendered: this.rendered, lost, pkts, jb, jbn, dt, wsRecv: this.wsReceived, wsDec: this.wsDecoded, wsBytes: this.wsBytes};
    this.events.onStats?.(out, this.lastServer);
    if (p) this.sendJSON({type: 'report', report: {...out, at: Date.now(), ua: navigator.userAgent.slice(0, 120)}});
  }

  private teardownMedia() {
    clearInterval(this.statsTimer); clearInterval(this.pingTimer);
    this.closeRTC();
    try { this.decoder?.close(); } catch {}
    this.decoder = undefined;
  }

  close() {
    this.closed = true;
    this.teardownMedia();
    try { this.ws?.close(); } catch {}
    const video = this.video as any;
    if (this.rvfc != null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(this.rvfc);
  }
}
