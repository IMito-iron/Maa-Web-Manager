// probe is a measurement client for the media service: N concurrent viewers over WebRTC or the
// WebSocket fallback, counting the frames that actually arrive (distinct RTP timestamps with the
// marker bit / binary WS messages). It measures delivery, not browser rendering.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

var (
	url       = flag.String("url", "ws://127.0.0.1:8090/ws", "")
	transport = flag.String("transport", "webrtc", "webrtc|ws")
	profile   = flag.String("profile", "p15", "")
	seconds   = flag.Int("seconds", 10, "")
	viewers   = flag.Int("n", 1, "")
	slowMs    = flag.Int("slow", 0, "first WS viewer sleeps this long per frame (slow consumer)")
	origin    = flag.String("origin", "", "Origin header")
	cookie    = flag.String("cookie", "", "Cookie header")
	token     = flag.String("token", "", "X-Control-Token header (direct-to-media tests only)")
	control   = flag.Bool("control", false, "viewer 0 requests control and sends a tap")
	ice       = flag.String("ice", "", "force candidate filter: host|srflx (WebRTC)")
)

type result struct {
	ID          int
	Frames      int
	Bytes       int
	FirstFrame  time.Duration
	FirstKey    time.Duration
	Lost        int
	Expected    int
	Pair        string
	ControlMsgs []string
	ServerFPS   float64
	Err         string
	window      time.Duration
}

func dial(ctx context.Context) (*websocket.Conn, error) {
	h := http.Header{}
	if *origin != "" {
		h.Set("Origin", *origin)
	}
	if *cookie != "" {
		h.Set("Cookie", *cookie)
	}
	if *token != "" {
		h.Set("X-Control-Token", *token)
	}
	c, _, err := websocket.Dial(ctx, *url, &websocket.DialOptions{HTTPHeader: h})
	if err == nil {
		c.SetReadLimit(16 << 20)
	}
	return c, err
}

func send(ctx context.Context, c *websocket.Conn, v any) {
	b, _ := json.Marshal(v)
	c.Write(ctx, websocket.MessageText, b)
}

func isKeyRTP(p []byte) bool {
	if len(p) < 2 {
		return false
	}
	t := p[0] & 0x1f
	switch t {
	case 5, 7:
		return true
	case 24: // STAP-A
		return len(p) > 3 && (p[3]&0x1f == 7 || p[3]&0x1f == 5)
	case 28: // FU-A start of IDR
		return p[1]&0x80 != 0 && p[1]&0x1f == 5
	}
	return false
}

func viewer(id int, start time.Time, out chan<- result) {
	r := result{ID: id}
	defer func() { out <- r }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*seconds+15)*time.Second)
	defer cancel()
	c, err := dial(ctx)
	if err != nil {
		r.Err = err.Error()
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	joined := time.Now()
	mode := "view"
	if *control && id == 0 {
		mode = "control"
	}
	send(ctx, c, map[string]any{"type": "hello", "transport": *transport, "profile": *profile, "mode": mode})
	var mu sync.Mutex
	measureFrom := joined.Add(3 * time.Second) // skip warm-up (encoder start, ICE)
	measureTo := measureFrom.Add(time.Duration(*seconds) * time.Second)
	count := func(n int, key bool) {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if r.FirstFrame == 0 {
			r.FirstFrame = now.Sub(joined)
		}
		if key && r.FirstKey == 0 {
			r.FirstKey = now.Sub(joined)
		}
		if now.After(measureFrom) && now.Before(measureTo) {
			r.Frames++
			r.Bytes += n
		}
	}
	var pc *webrtc.PeerConnection
	var dc *webrtc.DataChannel
	done := make(chan struct{})
	go func() {
		time.Sleep(time.Until(measureTo))
		close(done)
	}()
	type wsMsg struct {
		typ  websocket.MessageType
		data []byte
	}
	msgs := make(chan wsMsg, 256)
	readErr := make(chan error, 1)
	go func() {
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				readErr <- err
				return
			}
			msgs <- wsMsg{typ, data}
		}
	}()
	for {
		var typ websocket.MessageType
		var data []byte
		select {
		case <-done:
			r.window = time.Duration(*seconds) * time.Second
			if pc != nil {
				for _, st := range pc.GetStats() {
					if p, ok := st.(webrtc.ICECandidatePairStats); ok && p.Nominated {
						r.Pair = p.LocalCandidateID + "/" + p.RemoteCandidateID
					}
				}
				pc.Close()
			}
			return
		case err := <-readErr:
			r.Err = err.Error()
			return
		case m := <-msgs:
			typ, data = m.typ, m.data
		}
		if typ == websocket.MessageBinary {
			if *slowMs > 0 && id == 0 {
				time.Sleep(time.Duration(*slowMs) * time.Millisecond)
			}
			count(len(data)-17, len(data) > 0 && data[0]&1 == 1)
			continue
		}
		var m map[string]any
		json.Unmarshal(data, &m)
		switch m["type"] {
		case "ready":
			if *transport != "webrtc" || pc != nil {
				continue
			}
			m2 := &webrtc.MediaEngine{}
			m2.RegisterDefaultCodecs()
			reg := &interceptor.Registry{}
			webrtc.RegisterDefaultInterceptors(m2, reg)
			api := webrtc.NewAPI(webrtc.WithMediaEngine(m2), webrtc.WithInterceptorRegistry(reg))
			pc, _ = api.NewPeerConnection(webrtc.Configuration{})
			pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
			ordered := true
			dc, _ = pc.CreateDataChannel("input", &webrtc.DataChannelInit{Ordered: &ordered})
			pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
				var lastTS uint32
				var lastSeq uint16
				var size int
				var key, have bool
				for {
					p, _, err := t.ReadRTP()
					if err != nil {
						return
					}
					if have {
						gap := int(p.SequenceNumber - lastSeq)
						if gap > 1 && gap < 1000 {
							mu.Lock()
							r.Lost += gap - 1
							mu.Unlock()
						}
					}
					mu.Lock()
					r.Expected++
					mu.Unlock()
					lastSeq, have = p.SequenceNumber, true
					if p.Timestamp != lastTS {
						size, key = 0, false
						lastTS = p.Timestamp
					}
					size += len(p.Payload)
					key = key || isKeyRTP(p.Payload)
					if p.Marker {
						count(size, key)
					}
				}
			})
			offer, _ := pc.CreateOffer(nil)
			g := webrtc.GatheringCompletePromise(pc)
			pc.SetLocalDescription(offer)
			<-g
			send(ctx, c, map[string]any{"type": "offer", "sdp": pc.LocalDescription().SDP})
		case "answer":
			sdp := m["sdp"].(string)
			if *ice != "" {
				var keep []string
				for _, line := range strings.Split(sdp, "\r\n") {
					if strings.HasPrefix(line, "a=candidate") && !strings.Contains(line, "typ "+*ice) {
						continue
					}
					keep = append(keep, line)
				}
				sdp = strings.Join(keep, "\r\n")
			}
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
				r.Err = err.Error()
				return
			}
		case "control":
			r.ControlMsgs = append(r.ControlMsgs, fmt.Sprintf("active=%v %v", m["active"], m["reason"]))
			if m["active"] == true {
				go func() {
					msgs := []map[string]any{{"t": "d", "x": 0.5, "y": 0.5}, {"t": "m", "x": 0.55, "y": 0.5}, {"t": "u", "x": 0.55, "y": 0.5}}
					time.Sleep(4 * time.Second)
					for _, im := range msgs {
						if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
							b, _ := json.Marshal(im)
							dc.SendText(string(b))
						} else {
							send(ctx, c, map[string]any{"type": "input", "input": im})
						}
					}
				}()
			}
		case "stats":
			if s, ok := m["source"].(map[string]any); ok {
				if w, ok := s["window"].(map[string]any); ok {
					mu.Lock()
					r.ServerFPS, _ = w["fps"].(float64)
					mu.Unlock()
				}
			}
		case "error":
			r.Err = fmt.Sprint(m["message"])
		}
	}
}

func main() {
	flag.Parse()
	out := make(chan result, *viewers)
	start := time.Now()
	for i := 0; i < *viewers; i++ {
		go viewer(i, start, out)
	}
	var results []result
	for i := 0; i < *viewers; i++ {
		results = append(results, <-out)
	}
	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	enc := json.NewEncoder(os.Stdout)
	for _, r := range results {
		secs := float64(*seconds)
		loss := 0.0
		if r.Expected+r.Lost > 0 {
			loss = float64(r.Lost) / float64(r.Expected+r.Lost) * 100
		}
		enc.Encode(map[string]any{"viewer": r.ID, "transport": *transport, "profile": *profile,
			"receivedFps": float64(r.Frames) / secs, "kbps": float64(r.Bytes*8) / secs / 1000,
			"firstFrameMs": r.FirstFrame.Milliseconds(), "firstKeyMs": r.FirstKey.Milliseconds(),
			"lossPct": loss, "serverSourceFps": r.ServerFPS, "pair": r.Pair, "control": r.ControlMsgs, "error": r.Err})
	}
	if len(results) > 0 && results[0].Err != "" {
		log.Printf("viewer 0 error: %s", results[0].Err)
	}
}
