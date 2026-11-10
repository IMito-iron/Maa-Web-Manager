package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- fakes -------------------------------------------------------------------------------

type fakeCapture struct {
	mu      sync.Mutex
	msgs    [][]byte
	resets  int
	w, h    int
	stop    chan struct{}
	once    sync.Once
	fps     int
	started time.Time
}

func newFakeCapture(fps int) *fakeCapture {
	return &fakeCapture{w: 1280, h: 720, stop: make(chan struct{}), fps: fps, started: time.Now()}
}

func (f *fakeCapture) ReadFrames(onFrame func(*Frame), onSize func(w, h int)) error {
	onSize(f.w, f.h)
	t := time.NewTicker(time.Second / time.Duration(f.fps))
	defer t.Stop()
	n := 0
	for {
		select {
		case <-f.stop:
			return io.EOF
		case now := <-t.C:
			key := n%f.fps == 0
			onFrame(&Frame{Data: bytes.Repeat([]byte{byte(n)}, 4000), PTS: uint64(now.Sub(f.started).Microseconds()) + 1, Key: key, Arrival: now, Width: f.w, Height: f.h})
			n++
		}
	}
}
func (f *fakeCapture) SendControl(b []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, append([]byte(nil), b...))
	return nil
}
func (f *fakeCapture) ResetVideo() error { f.mu.Lock(); f.resets++; f.mu.Unlock(); return nil }
func (f *fakeCapture) Size() (int, int)  { return f.w, f.h }
func (f *fakeCapture) Close()            { f.once.Do(func() { close(f.stop) }) }
func (f *fakeCapture) messages() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.msgs...)
}

type fakeDevice struct {
	mu     sync.Mutex
	starts map[string]int
	caps   []*fakeCapture
}

func (d *fakeDevice) Start(p Profile) (Capture, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.starts == nil {
		d.starts = map[string]int{}
	}
	d.starts[p.Name]++
	c := newFakeCapture(p.FPS)
	d.caps = append(d.caps, c)
	return c, nil
}

type staticTarget struct{ c *fakeCapture }

func (t staticTarget) Control() (Capture, int, int, bool) { return t.c, t.c.w, t.c.h, true }

// ---- wire format -------------------------------------------------------------------------

func TestEncodeTouchMatchesScrcpyReader(t *testing.T) {
	b := EncodeTouch(actionDown, 3, 640, 360, 1280, 720, 1)
	if len(b) != 32 || b[0] != 2 || b[1] != 0 {
		t.Fatalf("header %v", b[:2])
	}
	if id := int64(binary.BigEndian.Uint64(b[2:])); id != 3 {
		t.Fatalf("pointer %d", id)
	}
	if x, y := int32(binary.BigEndian.Uint32(b[10:])), int32(binary.BigEndian.Uint32(b[14:])); x != 640 || y != 360 {
		t.Fatalf("pos %d,%d", x, y)
	}
	if w, h := binary.BigEndian.Uint16(b[18:]), binary.BigEndian.Uint16(b[20:]); w != 1280 || h != 720 {
		t.Fatalf("size %d,%d", w, h)
	}
	if p := binary.BigEndian.Uint16(b[22:]); p != 0xffff {
		t.Fatalf("pressure %x", p)
	}
	if !bytes.Equal(b[24:], make([]byte, 8)) {
		t.Fatal("buttons must be zero for finger touches")
	}
	k := EncodeKey(actionUp, keycodeBack)
	if len(k) != 14 || k[0] != 0 || k[1] != 1 || binary.BigEndian.Uint32(k[2:]) != 4 {
		t.Fatalf("key %v", k)
	}
}

func decodeTouch(b []byte) (action byte, id int64, x, y int32) {
	return b[1], int64(binary.BigEndian.Uint64(b[2:])), int32(binary.BigEndian.Uint32(b[10:])), int32(binary.BigEndian.Uint32(b[14:]))
}

// ---- input -------------------------------------------------------------------------------

func TestViewerInputIsDropped(t *testing.T) {
	c := newFakeCapture(30)
	in := NewInputSession(staticTarget{c})
	if err := in.Handle(InputMessage{T: "d", X: .5, Y: .5}); err == nil {
		t.Fatal("inactive session accepted input")
	}
	if len(c.messages()) != 0 {
		t.Fatal("viewer input reached the device")
	}
}

func TestPointerLifecycleOrderAndMapping(t *testing.T) {
	c := newFakeCapture(30)
	in := NewInputSession(staticTarget{c})
	in.SetActive(true)
	for _, m := range []InputMessage{{T: "m", X: .1, Y: .1}, {T: "d", X: 0, Y: 0}, {T: "m", X: .5, Y: .5}, {T: "m", X: 1, Y: 1}, {T: "u", X: 1, Y: 1}, {T: "u", X: 1, Y: 1}} {
		in.Handle(m)
	}
	msgs := c.messages()
	if len(msgs) != 4 {
		t.Fatalf("want down,move,move,up got %d messages", len(msgs))
	}
	want := []struct {
		a    byte
		x, y int32
	}{{actionDown, 0, 0}, {actionMove, 640, 360}, {actionMove, 1279, 719}, {actionUp, 1279, 719}}
	for i, w := range want {
		a, _, x, y := decodeTouch(msgs[i])
		if a != w.a || x != w.x || y != w.y {
			t.Fatalf("msg %d: got %d %d,%d want %+v", i, a, x, y, w)
		}
	}
}

func TestMultiTouchAndRevocationReleasesFingers(t *testing.T) {
	c := newFakeCapture(30)
	in := NewInputSession(staticTarget{c})
	in.SetActive(true)
	in.Handle(InputMessage{T: "d", I: 0, X: .2, Y: .2})
	in.Handle(InputMessage{T: "d", I: 1, X: .8, Y: .8})
	in.SetActive(false)
	msgs := c.messages()
	ups := 0
	for _, m := range msgs[2:] {
		if a, _, _, _ := decodeTouch(m); a == actionUp {
			ups++
		}
	}
	if ups != 2 {
		t.Fatalf("revocation must lift both fingers, got %d ups", ups)
	}
	if err := in.Handle(InputMessage{T: "d", X: .5, Y: .5}); err == nil {
		t.Fatal("revoked session accepted input")
	}
}

func TestSilentControllerReleasesLongPress(t *testing.T) {
	c := newFakeCapture(30)
	in := NewInputSession(staticTarget{c})
	in.SetActive(true)
	in.Handle(InputMessage{T: "d", X: .5, Y: .5})
	if in.ReleaseIfSilent(time.Hour) {
		t.Fatal("released too early")
	}
	in.mu.Lock()
	in.lastSeen = time.Now().Add(-4 * time.Second)
	in.mu.Unlock()
	if !in.ReleaseIfSilent(3 * time.Second) {
		t.Fatal("silent finger not released")
	}
	if a, _, _, _ := decodeTouch(c.messages()[1]); a != actionUp {
		t.Fatal("expected up")
	}
	// heartbeats keep a deliberate long press alive
	in.Handle(InputMessage{T: "d", X: .5, Y: .5})
	in.Handle(InputMessage{T: "hb"})
	if in.ReleaseIfSilent(3 * time.Second) {
		t.Fatal("heartbeat ignored")
	}
}

func TestRetargetLiftsOnOldCapture(t *testing.T) {
	a, b := newFakeCapture(30), newFakeCapture(60)
	in := NewInputSession(staticTarget{a})
	in.SetActive(true)
	in.Handle(InputMessage{T: "d", X: .5, Y: .5})
	in.Retarget(staticTarget{b})
	if act, _, _, _ := decodeTouch(a.messages()[1]); act != actionUp {
		t.Fatal("old capture keeps a stuck finger")
	}
	in.Handle(InputMessage{T: "m", X: .6, Y: .6})
	if len(b.messages()) != 0 {
		t.Fatal("move without down must not reach the new capture")
	}
}

func TestKeyAllowlist(t *testing.T) {
	c := newFakeCapture(30)
	in := NewInputSession(staticTarget{c})
	in.SetActive(true)
	if err := in.Handle(InputMessage{T: "k", K: "power"}); err == nil {
		t.Fatal("power key must not be allowed")
	}
	for _, k := range []string{"back", "home", "apps"} {
		if err := in.Handle(InputMessage{T: "k", K: k}); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.messages()) != 6 {
		t.Fatalf("each key is down+up, got %d", len(c.messages()))
	}
}

// ---- authority ---------------------------------------------------------------------------

func fakeManager(t *testing.T, status func(token string) (int, string)) string {
	dir := t.TempDir()
	sock := filepath.Join(dir, "control.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/control" || r.Header.Get("origin") != "https://maa.test" {
			w.WriteHeader(403)
			return
		}
		code, body := status(r.Header.Get("x-control-token"))
		w.WriteHeader(code)
		io.WriteString(w, body)
	})}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func writeState(t *testing.T, held bool, age time.Duration) string {
	p := filepath.Join(t.TempDir(), "control.json")
	data, _ := json.Marshal(map[string]any{"held": held, "checkedAt": time.Now().Add(-age).UnixMilli()})
	os.WriteFile(p, data, 0o644)
	return p
}

func TestAuthorityFailsClosed(t *testing.T) {
	owner := strings.Repeat("a", 64)
	other := strings.Repeat("b", 64)
	sock := fakeManager(t, func(token string) (int, string) {
		switch token {
		case owner:
			return 200, `{"held":true,"owned":true,"running":false}`
		case other:
			return 200, `{"held":true,"owned":false,"running":false}`
		}
		return 400, `{}`
	})
	fresh := writeState(t, true, 0)
	cases := []struct {
		name  string
		a     *ManagerAuthority
		token string
		ok    bool
	}{
		{"owner", &ManagerAuthority{Socket: sock, Origin: "https://maa.test", StatePath: fresh, MaxAge: 2500 * time.Millisecond}, owner, true},
		{"not-owner", &ManagerAuthority{Socket: sock, Origin: "https://maa.test", StatePath: fresh, MaxAge: 2500 * time.Millisecond}, other, false},
		{"no-token", &ManagerAuthority{Socket: sock, Origin: "https://maa.test", StatePath: fresh, MaxAge: 2500 * time.Millisecond}, "", false},
		{"stale-state", &ManagerAuthority{Socket: sock, Origin: "https://maa.test", StatePath: writeState(t, true, 5*time.Second), MaxAge: 2500 * time.Millisecond}, owner, false},
		{"not-held", &ManagerAuthority{Socket: sock, Origin: "https://maa.test", StatePath: writeState(t, false, 0), MaxAge: 2500 * time.Millisecond}, owner, false},
		{"missing-state", &ManagerAuthority{Socket: sock, Origin: "https://maa.test", StatePath: "/nonexistent", MaxAge: 2500 * time.Millisecond}, owner, false},
		{"manager-down", &ManagerAuthority{Socket: "/nonexistent.sock", Origin: "https://maa.test", StatePath: fresh, MaxAge: 2500 * time.Millisecond}, owner, false},
	}
	for _, c := range cases {
		err := c.a.Check(context.Background(), c.token)
		if (err == nil) != c.ok {
			t.Errorf("%s: err=%v want ok=%v", c.name, err, c.ok)
		}
	}
	running := fakeManager(t, func(string) (int, string) { return 200, `{"held":false,"owned":true,"running":true}` })
	a := &ManagerAuthority{Socket: running, Origin: "https://maa.test", StatePath: fresh, MaxAge: 2500 * time.Millisecond}
	if a.Check(context.Background(), owner) == nil {
		t.Error("running task must deny input")
	}
	bad := fakeManager(t, func(string) (int, string) { return 200, `not json` })
	a = &ManagerAuthority{Socket: bad, Origin: "https://maa.test", StatePath: fresh, MaxAge: 2500 * time.Millisecond}
	if a.Check(context.Background(), owner) == nil {
		t.Error("malformed answer must deny input")
	}
}

// ---- hub ---------------------------------------------------------------------------------

type countSink struct {
	n     atomic.Int64
	delay time.Duration
	keys  atomic.Int64
}

func (c *countSink) WriteFrame(f *Frame) {
	if c.delay > 0 {
		time.Sleep(c.delay)
	}
	c.n.Add(1)
	if f.Key {
		c.keys.Add(1)
	}
}

func TestOneCapturePerProfileAndIdleStop(t *testing.T) {
	dev := &fakeDevice{}
	hub := NewHub(dev, 200*time.Millisecond)
	src, _ := hub.Source("p30")
	sinks := []*countSink{{}, {}, {}}
	for _, s := range sinks {
		src.Acquire(s)
	}
	time.Sleep(500 * time.Millisecond)
	dev.mu.Lock()
	starts := dev.starts["p30"]
	dev.mu.Unlock()
	if starts != 1 {
		t.Fatalf("three viewers started %d captures", starts)
	}
	for _, s := range sinks {
		if s.n.Load() < 10 {
			t.Fatalf("viewer got %d frames", s.n.Load())
		}
		src.Release(s)
	}
	time.Sleep(500 * time.Millisecond)
	if st := src.Stats(); st.State != "idle" || st.Subscribers != 0 {
		t.Fatalf("not stopped after idle grace: %+v", st)
	}
	select {
	case <-dev.caps[0].stop:
	default:
		t.Fatal("capture not closed")
	}
	// a returning viewer within the grace period reuses the capture
	src.Acquire(nil)
	time.Sleep(100 * time.Millisecond)
	src.Release(nil)
	src.Acquire(nil)
	time.Sleep(300 * time.Millisecond)
	dev.mu.Lock()
	starts = dev.starts["p30"]
	dev.mu.Unlock()
	if starts != 2 {
		t.Fatalf("expected one restart after idle stop, got %d starts", starts)
	}
	src.Release(nil)
}

func TestProfilesAreRealEncoderSettings(t *testing.T) {
	if Profiles["p15"].FPS != 15 || Profiles["p30"].FPS != 30 || Profiles["p60"].FPS != 60 {
		t.Fatal("tiers")
	}
	args := strings.Join(InstanceOptions{MaxSize: 1280, MaxFPS: 15, BitRate: 1500000, IFrameSec: 2}.Args(0x1234), " ")
	for _, want := range []string{"max_fps=15", "video_bit_rate=1500000", "max_size=1280", "scid=00001234", "audio=false", "power_on=false", "cleanup=false", "tunnel_forward=true", "5.0.1"} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %s in %s", want, args)
		}
	}
	if strings.Contains(args, "turn_screen_off") || strings.Contains(args, "stay_awake=true") || strings.Contains(args, "show_touches=true") {
		t.Error("instance must not change display power or settings")
	}
}

func TestSlowWebSocketViewerDoesNotSlowOthers(t *testing.T) {
	dev := &fakeDevice{}
	hub := NewHub(dev, time.Second)
	src, _ := hub.Source("p60")
	fast := &countSink{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sess := &Session{ctx: ctx, cancel: cancel}
	slow := newWSSink(sess, src, 4) // never pumped: its queue fills immediately
	src.Acquire(fast)
	src.Acquire(slow)
	time.Sleep(time.Second)
	got := fast.n.Load()
	if got < 45 {
		t.Fatalf("fast viewer got %d frames in 1s at 60 fps", got)
	}
	if slow.drops.Load() == 0 {
		t.Fatal("slow viewer should be dropping")
	}
	if !slow.waiting.Load() && len(slow.ch) == cap(slow.ch) {
		t.Fatal("full slow viewer must wait for a key frame")
	}
	if src.Stats().Resets == 0 {
		t.Fatal("slow viewer should have requested a key frame")
	}
	src.Release(fast)
	src.Release(slow)
}

func TestWSSinkStartsAtKeyFrame(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	k := newWSSink(&Session{ctx: ctx, cancel: cancel}, &Source{}, 10)
	k.WriteFrame(&Frame{Key: false})
	if len(k.ch) != 0 {
		t.Fatal("delta frame delivered before key frame")
	}
	k.WriteFrame(&Frame{Key: true})
	k.WriteFrame(&Frame{Key: false})
	if len(k.ch) != 2 {
		t.Fatalf("queued %d", len(k.ch))
	}
}

func TestKeyFrameRequestsAreRateLimited(t *testing.T) {
	dev := &fakeDevice{}
	hub := NewHub(dev, time.Second)
	src, _ := hub.Source("p15")
	src.Acquire(nil)
	time.Sleep(150 * time.Millisecond)
	for i := 0; i < 20; i++ {
		src.RequestKeyFrame("test")
	}
	time.Sleep(1200 * time.Millisecond)
	dev.mu.Lock()
	c := dev.caps[0]
	dev.mu.Unlock()
	c.mu.Lock()
	resets := c.resets
	c.mu.Unlock()
	if resets != 2 {
		t.Fatalf("20 requests within a second must coalesce into 2 resets, got %d", resets)
	}
	src.Release(nil)
}

// ---- scrcpy stream -----------------------------------------------------------------------

func TestReadFramesParsesScrcpyStream(t *testing.T) {
	var buf bytes.Buffer
	session := func(w, h uint32) {
		var b [12]byte
		binary.BigEndian.PutUint32(b[0:], 0x80000000)
		binary.BigEndian.PutUint32(b[4:], w)
		binary.BigEndian.PutUint32(b[8:], h)
		buf.Write(b[:])
	}
	packet := func(head uint64, payload []byte) {
		var b [12]byte
		binary.BigEndian.PutUint64(b[0:], head)
		binary.BigEndian.PutUint32(b[8:], uint32(len(payload)))
		buf.Write(b[:])
		buf.Write(payload)
	}
	sps := []byte{0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3}
	session(1280, 720)
	packet(flagConfig, sps)
	packet(flagKeyFrame|1000, []byte{0, 0, 0, 1, 0x65, 9})
	packet(34333, []byte{0, 0, 0, 1, 0x41, 8})
	session(720, 1280)
	packet(flagConfig, sps)
	packet(flagKeyFrame|70000, []byte{0, 0, 0, 1, 0x65, 7})
	client, server := net.Pipe()
	go func() { server.Write(buf.Bytes()); server.Close() }()
	inst := &Instance{video: client, done: make(chan struct{})}
	var frames []*Frame
	var sizes [][2]int
	inst.ReadFrames(func(f *Frame) { frames = append(frames, f) }, func(w, h int) { sizes = append(sizes, [2]int{w, h}) })
	if len(frames) != 3 || len(sizes) != 2 {
		t.Fatalf("frames %d sizes %v", len(frames), sizes)
	}
	if !frames[0].Key || !bytes.HasPrefix(frames[0].Data, sps) || frames[0].PTS != 1000 || frames[0].Width != 1280 {
		t.Fatalf("key frame %+v", frames[0])
	}
	if frames[1].Key || frames[1].PTS != 34333 || bytes.HasPrefix(frames[1].Data, sps) {
		t.Fatalf("delta frame %+v", frames[1])
	}
	if frames[2].Width != 720 || frames[2].Height != 1280 {
		t.Fatalf("rotation not tracked: %+v", frames[2])
	}
}

// ---- adb protocol ------------------------------------------------------------------------

func TestADBTransportAndPush(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	var pushed bytes.Buffer
	var services []string
	var mu sync.Mutex
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				read := func() string {
					var n [4]byte
					io.ReadFull(r, n[:])
					var size int
					fmt.Sscanf(string(n[:]), "%04x", &size)
					b := make([]byte, size)
					io.ReadFull(r, b)
					return string(b)
				}
				first := read()
				mu.Lock()
				services = append(services, first)
				mu.Unlock()
				if first == "host:devices-l" {
					body := "FAKEUSB0001   device usb:1-2 product:x model:FakePhone\nemulator-5554 device product:y\n10.0.0.2:5555 device product:z\n"
					fmt.Fprintf(c, "OKAY%04x%s", len(body), body)
					return
				}
				c.Write([]byte("OKAY"))
				svc := read()
				mu.Lock()
				services = append(services, svc)
				mu.Unlock()
				c.Write([]byte("OKAY"))
				if svc == "sync:" {
					for {
						var h [8]byte
						if _, err := io.ReadFull(r, h[:]); err != nil {
							return
						}
						n := binary.LittleEndian.Uint32(h[4:])
						switch string(h[:4]) {
						case "SEND":
							io.CopyN(io.Discard, r, int64(n))
						case "DATA":
							io.CopyN(&pushed, r, int64(n))
						case "DONE":
							c.Write([]byte("OKAY\x00\x00\x00\x00"))
						case "QUIT":
							return
						}
					}
				}
			}(c)
		}
	}()
	adb := &ADB{Addr: l.Addr().String()}
	if err := adb.ResolveUSB("FAKEUSB0001"); err != nil {
		t.Fatal(err)
	}
	if err := adb.ResolveUSB("10.0.0.2:5555"); err == nil {
		t.Fatal("a network device must not satisfy a USB configuration")
	}
	if err := adb.Resolve("10.0.0.2:5555", "tcp"); err != nil {
		t.Fatalf("configured network device: %v", err)
	}
	if err := adb.Resolve("FAKEUSB0001", "tcp"); err == nil {
		t.Fatal("a USB phone must not satisfy a tcp configuration")
	}
	jar := filepath.Join(t.TempDir(), "server")
	payload := bytes.Repeat([]byte("x"), 150000)
	os.WriteFile(jar, payload, 0o644)
	if err := adb.Push("FAKEUSB0001", jar, "/data/local/tmp/s.jar", 0o644); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pushed.Bytes(), payload) {
		t.Fatalf("pushed %d bytes", pushed.Len())
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(strings.Join(services, "|"), "host:transport:FAKEUSB0001|sync:") {
		t.Fatalf("services %v", services)
	}
}

func TestShellQuote(t *testing.T) {
	got := shellQuote([]string{"CLASSPATH=/data/local/tmp/a.jar", "app_process", "video_codec_options=i-frame-interval:int=2", "a b", "it's"})
	want := `CLASSPATH=/data/local/tmp/a.jar app_process video_codec_options=i-frame-interval:int=2 'a b' 'it'\''s'`
	if got != want {
		t.Fatalf("%s", got)
	}
}

func TestRTPTimestampsFollowArrivalIncludingStillGaps(t *testing.T) {
	a := rtpEpoch.Add(10 * time.Second)
	b := a.Add(5 * time.Second) // the encoder was silent for 5 s (still screen)
	c := b.Add(33 * time.Millisecond)
	if d := rtpTimestamp(b) - rtpTimestamp(a); d != 450000 {
		t.Fatalf("5 s gap must be 450000 ticks, got %d", d)
	}
	if d := rtpTimestamp(c) - rtpTimestamp(b); d != 2970 {
		t.Fatalf("33 ms must be 2970 ticks, got %d", d)
	}
}

func TestAppendPublicCandidates(t *testing.T) {
	sdp := "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=candidate:1 1 udp 1 192.0.2.10 8189 typ host\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-pwd:y\r\n"
	got := appendPublicCandidates(sdp, []string{"60.134.241.191", "bogus"}, 8189, 8189)
	if strings.Count(got, "60.134.241.191 8189 typ srflx") != 8 { // 2 sections x 2 components x udp+tcp
		t.Fatalf("%s", got)
	}
	if strings.Contains(got, "bogus") || appendPublicCandidates(sdp, nil, 8189, 8189) != sdp {
		t.Fatal("only valid IPs; nothing when unset")
	}
}

func TestReadDeviceTransports(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		body, serial, transport string
		ok                      bool
	}{
		{`{"version":1,"transport":"usb","serial":"ABC"}`, "ABC", "usb", true},
		{`{"version":2,"transport":"usb","serial":"ABC"}`, "ABC", "usb", true},
		{`{"version":2,"transport":"tcp","address":"emulator.local:5555"}`, "emulator.local:5555", "tcp", true},
		{`{"version":2,"transport":"tcp","address":"10.0.0.2:05555"}`, "10.0.0.2:5555", "tcp", true},
		{`{"version":1,"transport":"tcp","address":"10.0.0.2:5555"}`, "", "", false},
		{`{"version":2,"transport":"tcp","address":"10.0.0.2"}`, "", "", false},
		{`{"version":2,"transport":"tcp","address":"[::1]:5555"}`, "", "", false},
		{`{"version":2,"transport":"tcp","address":"host:70000"}`, "", "", false},
	}
	for i, c := range cases {
		path := filepath.Join(dir, fmt.Sprintf("d%d.json", i))
		os.WriteFile(path, []byte(c.body), 0o600)
		serial, transport, err := readDevice(path)
		if (err == nil) != c.ok || serial != c.serial || transport != c.transport {
			t.Fatalf("%s: got %q %q %v", c.body, serial, transport, err)
		}
	}
}
