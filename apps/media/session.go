package main

// One browser connection: a WebSocket (through the Portal) that carries signalling, the
// H.264-over-WebSocket fallback video, statistics, and input when WebRTC is unavailable.
//
// Watching and controlling are authorised separately. Anyone the Portal admits may watch; input
// is accepted only while the session is in control mode and the Manager lease check passes.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

type clientMsg struct {
	Type      string          `json:"type"`
	Mode      string          `json:"mode,omitempty"`
	Profile   string          `json:"profile,omitempty"`
	Transport string          `json:"transport,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	T         float64         `json:"t,omitempty"`
	Input     *InputMessage   `json:"input,omitempty"`
	Report    json.RawMessage `json:"report,omitempty"`
}

type Session struct {
	srv    *Server
	id     uint64
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	token  string
	remote string

	writeMu sync.Mutex

	mu        sync.Mutex
	mode      string // view | control
	transport string // webrtc | ws
	source    *Source
	sink      *wsSink
	pc        *webrtc.PeerConnection
	sender    *webrtc.RTPSender
	input     *InputSession
	unsize    func()
	ctlReason string
	report    json.RawMessage
	started   time.Time
	pcState   string
	pair      string
}

func (s *Session) send(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	if err := s.ws.Write(ctx, websocket.MessageText, data); err != nil {
		s.cancel()
	}
}

func (s *Session) sendBinary(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	return s.ws.Write(ctx, websocket.MessageBinary, data)
}

// wsSink is the fallback video path: a bounded per-viewer queue. A viewer that cannot keep up
// loses frames up to the next key frame; it never slows the source or other viewers.
type wsSink struct {
	s       *Session
	src     *Source
	ch      chan *Frame
	done    chan struct{}
	stop    sync.Once
	waiting atomic.Bool
	drops   atomic.Int64
	sent    atomic.Int64
}

func newWSSink(s *Session, src *Source, depth int) *wsSink {
	k := &wsSink{s: s, src: src, ch: make(chan *Frame, depth), done: make(chan struct{})}
	k.waiting.Store(true)
	return k
}

func (k *wsSink) WriteFrame(f *Frame) {
	if k.waiting.Load() {
		if !f.Key {
			k.drops.Add(1)
			return
		}
		k.waiting.Store(false)
	}
	select {
	case k.ch <- f:
	default:
		k.drops.Add(1)
		k.waiting.Store(true)
		for {
			select {
			case <-k.ch:
				k.drops.Add(1)
				continue
			default:
			}
			break
		}
		k.src.RequestKeyFrame("slow websocket viewer")
	}
}

// close stops the pump; the channel itself is never closed because the source may still hold a
// reference for one more frame.
func (k *wsSink) close() { k.stop.Do(func() { close(k.done) }) }

func (k *wsSink) pump() {
	header := make([]byte, 17)
	for {
		select {
		case <-k.s.ctx.Done():
			return
		case <-k.done:
			return
		case f := <-k.ch:
			// [flags][pts µs device clock][arrival µs server clock] + Annex-B access unit
			header[0] = 0
			if f.Key {
				header[0] = 1
			}
			binary.BigEndian.PutUint64(header[1:], f.PTS)
			binary.BigEndian.PutUint64(header[9:], uint64(f.Arrival.UnixMicro()))
			buf := make([]byte, 0, len(header)+len(f.Data))
			buf = append(append(buf, header...), f.Data...)
			if err := k.s.sendBinary(buf); err != nil {
				k.s.cancel()
				return
			}
			k.sent.Add(1)
		}
	}
}

func queueDepth(mode string, p Profile) int {
	if mode == "control" {
		return max(3, p.FPS/6) // ~150 ms: stale frames are worse than dropped ones when steering
	}
	return max(8, p.FPS) // ~1 s of smoothing for watchers
}

// attach subscribes this session to a profile, moving away from the previous one if needed.
func (s *Session) attach(profile string) error {
	src, err := s.srv.hub.Source(profile)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	old, oldSink := s.source, s.sink
	if old == src {
		return nil
	}
	var sink *wsSink
	if s.transport == "ws" {
		sink = newWSSink(s, src, queueDepth(s.mode, src.Profile()))
		src.Acquire(sink)
		go sink.pump()
	} else {
		src.Acquire(nil)
		if s.sender != nil {
			if err := s.sender.ReplaceTrack(src.Track()); err != nil {
				src.Release(nil)
				return err
			}
		}
	}
	s.source, s.sink = src, sink
	if s.unsize != nil {
		s.unsize()
	}
	s.unsize = src.OnSizeChange(func(int, int) {
		s.mu.Lock()
		in := s.input
		s.mu.Unlock()
		if in != nil {
			in.SizeChanged()
		}
	})
	if s.input != nil {
		s.input.Retarget(src)
	}
	if old != nil {
		if oldSink != nil {
			old.Release(oldSink)
			oldSink.close()
		} else {
			old.Release(nil)
		}
	}
	src.RequestKeyFrame("viewer joined")
	return nil
}

func (s *Session) detach() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unsize != nil {
		s.unsize()
		s.unsize = nil
	}
	if s.source != nil {
		if s.sink != nil {
			s.source.Release(s.sink)
			s.sink.close()
		} else {
			s.source.Release(nil)
		}
	}
	s.source, s.sink = nil, nil
}

// setMode switches between watching and controlling without reconnecting the video.
func (s *Session) setMode(mode string) {
	if mode != "control" {
		s.srv.dropController(s, "已切换到观看模式")
		s.mu.Lock()
		s.mode = "view"
		s.mu.Unlock()
		s.send(map[string]any{"type": "control", "active": false, "reason": "观看模式"})
		return
	}
	// The Manager republishes control.json once a second, so a lease taken a moment ago may not be
	// visible yet: retry briefly before refusing.
	var err error
	for deadline := time.Now().Add(3 * time.Second); ; {
		ctx, cancel := context.WithTimeout(s.ctx, 1500*time.Millisecond)
		err = s.srv.auth.Check(ctx, s.token)
		cancel()
		if err == nil || time.Now().After(deadline) || s.ctx.Err() != nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil {
		s.send(map[string]any{"type": "control", "active": false, "reason": err.Error()})
		return
	}
	s.mu.Lock()
	s.mode = "control"
	if s.input == nil {
		var target Target = s.source
		if s.source == nil {
			target = nullTarget{}
		}
		s.input = NewInputSession(target)
	}
	in := s.input
	s.mu.Unlock()
	s.srv.claimController(s)
	in.SetActive(true)
	s.send(map[string]any{"type": "control", "active": true})
}

type nullTarget struct{}

func (nullTarget) Control() (Capture, int, int, bool) { return nil, 0, 0, false }

func (s *Session) handleInput(m InputMessage) {
	s.mu.Lock()
	in := s.input
	mode := s.mode
	s.mu.Unlock()
	if in == nil || mode != "control" {
		return // watchers cannot send input; silently ignored
	}
	_ = in.Handle(m)
}

// ---- WebRTC --------------------------------------------------------------------------------

func (s *Session) answer(offer string) error {
	s.mu.Lock()
	src := s.source
	s.mu.Unlock()
	if src == nil {
		return errors.New("no profile selected")
	}
	began := time.Now()
	pc, err := s.srv.newPeerConnection()
	if err != nil {
		return err
	}
	sender, err := pc.AddTrack(src.Track())
	if err != nil {
		pc.Close()
		return err
	}
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range packets {
				switch p.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					s.mu.Lock()
					cur := s.source
					s.mu.Unlock()
					if cur != nil {
						cur.RequestKeyFrame("PLI/FIR")
					}
				}
			}
		}
	}()
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "input" {
			dc.Close()
			return
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			var m InputMessage
			if len(msg.Data) > 512 || json.Unmarshal(msg.Data, &m) != nil {
				return
			}
			s.handleInput(m)
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		s.mu.Lock()
		s.pcState = state.String()
		cur := s.source
		s.mu.Unlock()
		if state == webrtc.PeerConnectionStateConnected {
			if pair := selectedPair(pc); pair != "" {
				s.mu.Lock()
				s.pair = pair
				s.mu.Unlock()
				log.Printf("session %d (%s) webrtc connected via %s", s.id, s.remote, pair)
			}
			if cur != nil {
				cur.RequestKeyFrame("webrtc connected")
			}
		}
		s.send(map[string]any{"type": "rtc-state", "state": state.String(), "pair": s.pair})
		if state == webrtc.PeerConnectionStateFailed {
			log.Printf("session %d (%s) webrtc failed", s.id, s.remote)
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		pc.Close()
		return err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return err
	}
	select {
	case <-gathered:
	case <-time.After(3 * time.Second): // send what we have; STUN may be slow or blocked
	}
	s.mu.Lock()
	if s.pc != nil {
		s.pc.Close()
	}
	s.pc, s.sender = pc, sender
	s.mu.Unlock()
	log.Printf("session %d answer ready in %s", s.id, time.Since(began).Round(time.Millisecond))
	s.send(map[string]any{"type": "answer", "sdp": appendPublicCandidates(pc.LocalDescription().SDP, s.srv.cfg.publicIPs(), s.srv.cfg.UDPPort, s.srv.cfg.TCPPort)})
	return nil
}

func selectedPair(pc *webrtc.PeerConnection) string {
	sctp := pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		// no data channel yet: fall back to stats
	} else if pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
		return pair.Local.Typ.String() + "/" + pair.Local.Protocol.String() + " ↔ " + pair.Remote.Typ.String() + "/" + pair.Remote.Protocol.String()
	}
	for _, st := range pc.GetStats() {
		if p, ok := st.(webrtc.ICECandidatePairStats); ok && p.Nominated && p.State == webrtc.StatsICECandidatePairStateSucceeded {
			return "nominated pair " + p.LocalCandidateID + " ↔ " + p.RemoteCandidateID
		}
	}
	return ""
}

func (s *Session) closePeer() {
	s.mu.Lock()
	pc := s.pc
	s.pc, s.sender = nil, nil
	s.mu.Unlock()
	if pc != nil {
		pc.Close()
	}
}

// ---- lifecycle -----------------------------------------------------------------------------

func (s *Session) run(r *http.Request) {
	defer s.cancel()
	defer s.cleanup()
	s.ws.SetReadLimit(1 << 20)
	go s.statsLoop()
	for {
		typ, data, err := s.ws.Read(s.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var m clientMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "hello":
			s.mu.Lock()
			s.transport = map[bool]string{true: "ws", false: "webrtc"}[m.Transport == "ws"]
			s.mu.Unlock()
			profile := m.Profile
			if _, ok := Profiles[profile]; !ok {
				profile = "p15"
			}
			if err := s.attach(profile); err != nil {
				s.send(map[string]any{"type": "error", "message": err.Error()})
				continue
			}
			s.send(map[string]any{"type": "ready", "profile": profile, "transport": s.transport,
				"iceServers": s.srv.cfg.browserICEServers(), "profiles": Profiles})
			if m.Mode == "control" {
				s.setMode("control")
			}
		case "offer":
			if err := s.answer(m.SDP); err != nil {
				s.send(map[string]any{"type": "error", "message": "WebRTC: " + err.Error()})
			}
		case "transport":
			// fall back from WebRTC to WebSocket video (or back) without dropping the session
			want := map[bool]string{true: "ws", false: "webrtc"}[m.Transport == "ws"]
			s.mu.Lock()
			cur := s.source
			same := s.transport == want
			s.mu.Unlock()
			if same || cur == nil {
				continue
			}
			s.closePeer()
			s.detach()
			s.mu.Lock()
			s.transport = want
			s.mu.Unlock()
			_ = s.attach(cur.Profile().Name)
			s.send(map[string]any{"type": "ready", "profile": cur.Profile().Name, "transport": want,
				"iceServers": s.srv.cfg.browserICEServers(), "profiles": Profiles})
		case "profile":
			if err := s.attach(m.Profile); err != nil {
				s.send(map[string]any{"type": "error", "message": err.Error()})
			} else {
				s.send(map[string]any{"type": "profile", "profile": m.Profile})
			}
		case "mode":
			s.setMode(m.Mode)
		case "input":
			if m.Input != nil {
				s.handleInput(*m.Input)
			}
		case "keyframe":
			s.mu.Lock()
			cur := s.source
			s.mu.Unlock()
			if cur != nil {
				cur.RequestKeyFrame("decoder request")
			}
		case "ping":
			s.send(map[string]any{"type": "pong", "t": m.T, "server": float64(time.Now().UnixMicro()) / 1000})
		case "report":
			if len(m.Report) < 4096 {
				s.mu.Lock()
				s.report = m.Report
				s.mu.Unlock()
			}
		}
	}
}

func (s *Session) statsLoop() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
		}
		s.mu.Lock()
		src, sink, in, mode, transport := s.source, s.sink, s.input, s.mode, s.transport
		s.mu.Unlock()
		msg := map[string]any{"type": "stats", "mode": mode, "transport": transport, "server": time.Now().UnixMilli()}
		if src != nil {
			msg["source"] = src.Stats()
		}
		if sink != nil {
			msg["ws"] = map[string]any{"sent": sink.sent.Load(), "dropped": sink.drops.Load(), "queued": len(sink.ch)}
		}
		if in != nil {
			sent, dropped, down := in.Counters()
			msg["input"] = map[string]any{"sent": sent, "dropped": dropped, "down": down}
		}
		s.send(msg)
	}
}

func (s *Session) cleanup() {
	s.srv.dropController(s, "连接已断开")
	s.mu.Lock()
	in := s.input
	s.mu.Unlock()
	if in != nil {
		in.SetActive(false)
	}
	s.closePeer()
	s.detach()
	s.srv.forget(s)
	log.Printf("session %d (%s) closed", s.id, s.remote)
}

// appendPublicCandidates advertises the router's public address at the mux ports, for a router
// port-forward of MEDIA_ICE_PORT. The UDP/TCP muxes route by ICE username, so any destination
// address that reaches the port works. Without a forward these candidates simply fail and the
// STUN (srflx) or WebSocket paths are used instead.
func appendPublicCandidates(sdp string, ips []string, udpPort, tcpPort int) string {
	if len(ips) == 0 {
		return sdp
	}
	var extra []string
	for n, ip := range ips {
		if net.ParseIP(ip) == nil {
			continue
		}
		for c := 1; c <= 2; c++ {
			extra = append(extra, fmt.Sprintf("a=candidate:pub%d %d udp %d %s %d typ srflx raddr 0.0.0.0 rport %d", n, c, 1694498815-c+1, ip, udpPort, udpPort))
			if tcpPort > 0 {
				extra = append(extra, fmt.Sprintf("a=candidate:pubt%d %d tcp %d %s %d typ srflx raddr 0.0.0.0 rport %d tcptype passive", n, c, 1660944383-c+1, ip, tcpPort, tcpPort))
			}
		}
	}
	if len(extra) == 0 {
		return sdp
	}
	lines := strings.Split(sdp, "\r\n")
	out := make([]string, 0, len(lines)+len(extra)*2)
	for _, l := range lines {
		out = append(out, l)
		if strings.HasPrefix(l, "a=ice-pwd:") {
			out = append(out, extra...)
		}
	}
	return strings.Join(out, "\r\n")
}
