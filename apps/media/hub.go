package main

// Fan-out of one capture per frame-rate tier to every viewer of that tier.
//
// A tier ("profile") owns at most one scrcpy-server instance on the phone, no matter how many
// browsers watch it; it is started on the first subscriber and stopped after an idle grace period
// once the last one leaves. Tiers are real encoder settings (max_fps, bit rate), not client-side
// frame dropping: a 15 fps viewer receives a 15 fps encode.

import (
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"sync"
	"time"

	"math/rand/v2"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

type Profile struct {
	Name    string `json:"name"`
	FPS     int    `json:"fps"`
	MaxSize int    `json:"maxSize"`
	BitRate int    `json:"bitRate"`
}

// Profiles are the tiers a browser may ask for. 1280 is the long edge: the phone's game display
// is overridden to 1280x720, so this is a 1:1 capture of it.
var Profiles = map[string]Profile{
	"p15": {Name: "p15", FPS: 15, MaxSize: 1280, BitRate: 1_500_000},
	"p30": {Name: "p30", FPS: 30, MaxSize: 1280, BitRate: 3_000_000},
	"p60": {Name: "p60", FPS: 60, MaxSize: 1280, BitRate: 5_000_000},
}

// Sink receives frames; implementations must never block the source.
type Sink interface {
	WriteFrame(*Frame)
}

// Device abstracts how an instance is started, so the hub can be tested without a phone.
type Device interface {
	Start(p Profile) (Capture, error)
}

// Capture is a running encoder with its control socket.
type Capture interface {
	ReadFrames(onFrame func(*Frame), onSize func(w, h int)) error
	SendControl([]byte) error
	ResetVideo() error
	Size() (int, int)
	Close()
}

type Hub struct {
	dev     Device
	idle    time.Duration
	mu      sync.Mutex
	sources map[string]*Source
}

func NewHub(dev Device, idle time.Duration) *Hub {
	return &Hub{dev: dev, idle: idle, sources: map[string]*Source{}}
}

func (h *Hub) Source(name string) (*Source, error) {
	p, ok := Profiles[name]
	if !ok {
		return nil, fmt.Errorf("unknown profile %q", name)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sources[name]
	if s == nil {
		track, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
				SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"},
			"video", "android-"+name)
		if err != nil {
			return nil, err
		}
		s = &Source{hub: h, prof: p, sinks: map[Sink]struct{}{}, track: track, state: "idle", seq: uint16(rand.Uint32())}
		h.sources[name] = s
	}
	return s, nil
}

func (h *Hub) Snapshot() []SourceStats {
	h.mu.Lock()
	list := make([]*Source, 0, len(h.sources))
	for _, s := range h.sources {
		list = append(list, s)
	}
	h.mu.Unlock()
	out := make([]SourceStats, 0, len(list))
	for _, s := range list {
		out = append(out, s.Stats())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FPSTier < out[j].FPSTier })
	return out
}

type Source struct {
	hub   *Hub
	prof  Profile
	track *webrtc.TrackLocalStaticRTP
	pay   codecs.H264Payloader
	seq   uint16

	mu        sync.Mutex
	refs      int
	sinks     map[Sink]struct{}
	cap       Capture
	state     string
	lastErr   string
	gen       int
	stopTimer *time.Timer
	starts    int
	lastPTS   uint64
	width     int
	height    int
	sizeSubs  map[int]func(w, h int)
	sizeSeq   int

	resetAt      time.Time
	resetPending bool
	resets       int

	win      statWindow
	last     windowResult
	transitM transitTracker
}

type statWindow struct {
	start   time.Time
	frames  int
	keys    int
	bytes   int
	maxGap  time.Duration
	lastArr time.Time
}

type windowResult struct {
	At          time.Time `json:"at"`
	FPS         float64   `json:"fps"`
	KeyFrames   int       `json:"keyFrames"`
	BitRate     float64   `json:"bitRate"`
	AvgFrame    float64   `json:"avgFrameBytes"`
	MaxGapMs    float64   `json:"maxGapMs"`
	Static      bool      `json:"static"`
	QueueMs     float64   `json:"deviceToServerQueueMs"`
	QueueJitter float64   `json:"deviceToServerJitterMs"`
}

// transitTracker estimates how long frames wait between capture on the phone and arrival here.
// The phone clock is unrelated to ours, so the absolute offset is unknown; the minimum observed
// (arrival - pts) over a sliding window is taken as the floor and the excess is queueing delay
// (USB, encoder output, adb). It is an estimate and is labelled as such in the UI.
type transitTracker struct {
	samples []float64
	floor   float64
	floorAt time.Time
}

func (t *transitTracker) add(arrival time.Time, pts uint64) {
	d := float64(arrival.UnixMicro()) - float64(pts)
	if len(t.samples) == 0 || d < t.floor || time.Since(t.floorAt) > 10*time.Second {
		t.floor, t.floorAt = d, arrival
	}
	t.samples = append(t.samples, (d-t.floor)/1000)
}

func (t *transitTracker) take() (mean, jitter float64) {
	if len(t.samples) == 0 {
		return 0, 0
	}
	var sum float64
	for _, v := range t.samples {
		sum += v
	}
	mean = sum / float64(len(t.samples))
	for _, v := range t.samples {
		jitter += (v - mean) * (v - mean)
	}
	jitter = sqrt(jitter / float64(len(t.samples)))
	t.samples = t.samples[:0]
	return
}

func sqrt(x float64) float64 {
	if x <= 0 {
		return 0
	}
	z := x
	for i := 0; i < 30; i++ {
		z = (z + x/z) / 2
	}
	return z
}

type SourceStats struct {
	Profile     string       `json:"profile"`
	FPSTier     int          `json:"fpsTier"`
	BitRateTier int          `json:"bitRateTier"`
	State       string       `json:"state"`
	Error       string       `json:"error,omitempty"`
	Subscribers int          `json:"subscribers"`
	Starts      int          `json:"starts"`
	Resets      int          `json:"keyFrameRequests"`
	Width       int          `json:"width"`
	Height      int          `json:"height"`
	Window      windowResult `json:"window"`
}

func (s *Source) Profile() Profile         { return s.prof }
func (s *Source) Track() webrtc.TrackLocal { return s.track }

// rtpEpoch is shared by every tier so a viewer moved to another tier keeps a continuous clock.
var rtpEpoch = time.Now()

// rtpTimestamp is taken from the frame's arrival here, not from the encoder: the encoder emits
// nothing while the screen is still, and gaps of seconds must appear as gaps. With arrival-based
// timestamps the receiver sees inter-arrival = timestamp delta, so its jitter buffer stays minimal.
func rtpTimestamp(at time.Time) uint32 {
	return uint32(at.Sub(rtpEpoch).Microseconds() * 9 / 100)
}

// writeRTP packetises one access unit (Annex-B) into RTP and fans it out to every bound viewer.
// Only the source's reader goroutine calls it.
func (s *Source) writeRTP(f *Frame) error {
	payloads := s.pay.Payload(1200, f.Data)
	ts := rtpTimestamp(f.Arrival)
	var firstErr error
	for i, p := range payloads {
		pkt := &rtp.Packet{Header: rtp.Header{Version: 2, Marker: i == len(payloads)-1, SequenceNumber: s.seq, Timestamp: ts}, Payload: p}
		s.seq++
		if err := s.track.WriteRTP(pkt); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Source) Stats() SourceStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SourceStats{Profile: s.prof.Name, FPSTier: s.prof.FPS, BitRateTier: s.prof.BitRate, State: s.state,
		Error: s.lastErr, Subscribers: s.refs, Starts: s.starts, Resets: s.resets, Width: s.width, Height: s.height, Window: s.last}
}

// Acquire registers interest (and an optional frame sink). The capture starts if needed.
func (s *Source) Acquire(sink Sink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refs++
	if sink != nil {
		s.sinks[sink] = struct{}{}
	}
	if s.stopTimer != nil {
		s.stopTimer.Stop()
		s.stopTimer = nil
	}
	if s.state == "idle" || s.state == "stopping" {
		s.gen++
		s.state = "starting"
		go s.run(s.gen)
	}
}

func (s *Source) Release(sink Sink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sink != nil {
		delete(s.sinks, sink)
	}
	if s.refs > 0 {
		s.refs--
	}
	if s.refs == 0 && s.stopTimer == nil {
		gen := s.gen
		s.stopTimer = time.AfterFunc(s.hub.idle, func() { s.stopIdle(gen) })
	}
}

func (s *Source) stopIdle(gen int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopTimer = nil
	if s.refs > 0 || gen != s.gen {
		return
	}
	s.gen++ // tells run() to stop retrying
	s.state = "idle"
	if s.cap != nil {
		log.Printf("[%s] no subscribers for %s; stopping capture", s.prof.Name, s.hub.idle)
		s.cap.Close()
	}
}

func (s *Source) run(gen int) {
	backoff := time.Second
	for {
		s.mu.Lock()
		if gen != s.gen {
			s.mu.Unlock()
			return
		}
		s.starts++
		s.mu.Unlock()
		capture, err := s.hub.dev.Start(s.prof)
		s.mu.Lock()
		if gen != s.gen {
			s.mu.Unlock()
			if capture != nil {
				capture.Close()
			}
			return
		}
		if err != nil {
			s.state, s.lastErr = "error", err.Error()
			s.mu.Unlock()
			log.Printf("[%s] start failed: %v", s.prof.Name, err)
			time.Sleep(backoff)
			backoff = min(backoff*2, 10*time.Second)
			continue
		}
		s.cap, s.state, s.lastErr = capture, "running", ""
		s.win = statWindow{start: time.Now()}
		s.mu.Unlock()
		backoff = time.Second
		log.Printf("[%s] capture running (%d fps, %d bps)", s.prof.Name, s.prof.FPS, s.prof.BitRate)
		stop := make(chan struct{})
		go s.statsLoop(gen, stop)
		err = capture.ReadFrames(s.onFrame, s.onSize)
		close(stop)
		s.mu.Lock()
		s.cap = nil
		if gen != s.gen {
			s.mu.Unlock()
			return
		}
		s.state, s.lastErr = "error", fmt.Sprintf("capture ended: %v", err)
		s.mu.Unlock()
		log.Printf("[%s] capture ended: %v", s.prof.Name, err)
		time.Sleep(backoff)
	}
}

// rollWindow closes the current one-second statistics window. It runs on a timer, not on frame
// arrival: a phone whose screen does not change sends no frames for seconds, and that silence is
// exactly what the window must show.
func (s *Source) rollWindow(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := &s.win
	el := now.Sub(w.start)
	if el < 900*time.Millisecond {
		return
	}
	secs := el.Seconds()
	if !w.lastArr.IsZero() {
		if gap := now.Sub(w.lastArr); gap > w.maxGap {
			w.maxGap = gap
		}
	}
	mean, jitter := s.transitM.take()
	res := windowResult{At: now, FPS: float64(w.frames) / secs, KeyFrames: w.keys,
		BitRate: float64(w.bytes*8) / secs, MaxGapMs: float64(w.maxGap.Microseconds()) / 1000,
		QueueMs: mean, QueueJitter: jitter}
	if w.frames > 0 {
		res.AvgFrame = float64(w.bytes) / float64(w.frames)
	}
	// The encoder only emits frames when the screen changes (plus a short repeat). Far fewer frames
	// than the tier with long gaps between them means a still picture, not a slow pipeline.
	res.Static = res.FPS < float64(s.prof.FPS)*0.5 && w.maxGap >= 300*time.Millisecond
	s.last = res
	*w = statWindow{start: now, lastArr: w.lastArr}
}

func (s *Source) statsLoop(gen int, done <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case now := <-t.C:
			s.mu.Lock()
			stale := gen != s.gen
			s.mu.Unlock()
			if stale {
				return
			}
			s.rollWindow(now)
		}
	}
}

func (s *Source) onSize(w, h int) {
	s.mu.Lock()
	changed := s.width != 0 && (s.width != w || s.height != h)
	s.width, s.height = w, h
	subs := make([]func(int, int), 0, len(s.sizeSubs))
	for _, f := range s.sizeSubs {
		subs = append(subs, f)
	}
	s.mu.Unlock()
	if changed {
		for _, f := range subs {
			f(w, h)
		}
	}
}

// OnSizeChange registers a callback for capture size changes (rotation); returns an unsubscribe.
func (s *Source) OnSizeChange(f func(w, h int)) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sizeSubs == nil {
		s.sizeSubs = map[int]func(int, int){}
	}
	s.sizeSeq++
	id := s.sizeSeq
	s.sizeSubs[id] = f
	return func() { s.mu.Lock(); delete(s.sizeSubs, id); s.mu.Unlock() }
}

func (s *Source) onFrame(f *Frame) {
	s.mu.Lock()
	s.lastPTS = f.PTS
	w := &s.win
	if !w.lastArr.IsZero() {
		if gap := f.Arrival.Sub(w.lastArr); gap > w.maxGap {
			w.maxGap = gap
		}
	}
	w.lastArr = f.Arrival
	w.frames++
	w.bytes += len(f.Data)
	if f.Key {
		w.keys++
	}
	s.transitM.add(f.Arrival, f.PTS)
	sinks := make([]Sink, 0, len(s.sinks))
	for k := range s.sinks {
		sinks = append(sinks, k)
	}
	s.mu.Unlock()
	if err := s.writeRTP(f); err != nil && !errors.Is(err, os.ErrClosed) {
		log.Printf("[%s] rtp write: %v", s.prof.Name, err)
	}
	for _, k := range sinks {
		k.WriteFrame(f)
	}
}

// RequestKeyFrame asks the encoder for a fresh key frame, at most once per second; requests that
// arrive in between are coalesced into one delayed reset.
func (s *Source) RequestKeyFrame(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cap == nil || s.resetPending {
		return
	}
	wait := time.Until(s.resetAt.Add(time.Second))
	if wait <= 0 {
		s.resetAt = time.Now()
		s.resets++
		go s.cap.ResetVideo()
		return
	}
	s.resetPending = true
	time.AfterFunc(wait, func() {
		s.mu.Lock()
		s.resetPending = false
		c := s.cap
		if c != nil {
			s.resetAt = time.Now()
			s.resets++
		}
		s.mu.Unlock()
		if c != nil {
			_ = c.ResetVideo()
		}
	})
}

// Control returns the running capture's control socket and current capture size.
func (s *Source) Control() (Capture, int, int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cap == nil || s.state != "running" {
		return nil, 0, 0, false
	}
	w, h := s.cap.Size()
	if w == 0 || h == 0 {
		return nil, 0, 0, false
	}
	return s.cap, w, h, true
}

// ---- real device -------------------------------------------------------------------------

type PhoneDevice struct {
	ADB       *ADB
	Serial    string
	Transport string // "usb" (default) or "tcp"
	LocalJar  string
	RemoteJar string
	Encoder   string
	IFrameSec int
	pushMu    sync.Mutex
	pushed    bool
}

func (d *PhoneDevice) Start(p Profile) (Capture, error) {
	transport := d.Transport
	if transport == "" {
		transport = "usb"
	}
	if err := d.ADB.Resolve(d.Serial, transport); err != nil {
		return nil, err
	}
	d.pushMu.Lock()
	if !d.pushed {
		if err := d.ADB.Push(d.Serial, d.LocalJar, d.RemoteJar, 0o644); err != nil {
			d.pushMu.Unlock()
			return nil, fmt.Errorf("push scrcpy-server: %w", err)
		}
		d.pushed = true
	}
	d.pushMu.Unlock()
	inst, err := StartInstance(d.ADB, InstanceOptions{Serial: d.Serial, ServerJar: d.RemoteJar,
		MaxSize: p.MaxSize, MaxFPS: p.FPS, BitRate: p.BitRate, IFrameSec: d.IFrameSec, Encoder: d.Encoder,
		LogPrefix: "[" + p.Name + "]"})
	if err != nil {
		// A rebooted phone loses /data/local/tmp contents only rarely, but re-push on the next try.
		d.pushMu.Lock()
		d.pushed = false
		d.pushMu.Unlock()
		return nil, err
	}
	return inst, nil
}
