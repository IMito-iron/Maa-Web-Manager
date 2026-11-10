package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

type Config struct {
	Listen      string
	ADBAddr     string
	DeviceCfg   string
	LocalJar    string
	RemoteJar   string
	Encoder     string
	IFrameSec   int
	UDPPort     int
	TCPPort     int
	HostIPs     []string // advertised instead of container addresses (the host's LAN IP)
	PublicIPs   []string // appended as srflx at the mux port (router port-forward), or "auto"
	STUN        []string
	IdleStop    time.Duration
	Origin      string
	RunnerSock  string
	ControlPath string

	publicMu   sync.RWMutex
	publicAuto []string
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func list(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func loadConfig() *Config {
	atoi := func(name string, def int) int {
		n, err := strconv.Atoi(env(name, strconv.Itoa(def)))
		if err != nil {
			return def
		}
		return n
	}
	return &Config{
		Listen:      env("MEDIA_LISTEN", ":8090"),
		ADBAddr:     env("MEDIA_ADB", "device:5037"),
		DeviceCfg:   env("DEVICE_CONFIG", "/device-config/devices.json"),
		LocalJar:    env("MEDIA_SERVER_JAR", "/opt/scrcpy/scrcpy-server"),
		RemoteJar:   env("MEDIA_REMOTE_JAR", "/data/local/tmp/maa-media-scrcpy-server-5.0.1.jar"),
		Encoder:     env("MEDIA_ENCODER", ""),
		IFrameSec:   atoi("MEDIA_IFRAME_SEC", 2),
		UDPPort:     atoi("MEDIA_UDP_PORT", 8189),
		TCPPort:     atoi("MEDIA_TCP_PORT", 8189),
		HostIPs:     list(env("MEDIA_HOST_IPS", "")),
		PublicIPs:   list(env("MEDIA_PUBLIC_IPS", "")),
		STUN:        list(env("MEDIA_STUN", "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302")),
		IdleStop:    time.Duration(atoi("MEDIA_IDLE_STOP_SEC", 15)) * time.Second,
		Origin:      env("PUBLIC_ORIGIN", ""),
		RunnerSock:  env("RUNNER_SOCKET", "/control/control.sock"),
		ControlPath: env("CONTROL_STATE", "/control-state/control.json"),
	}
}

func (c *Config) browserICEServers() []map[string]any {
	if len(c.STUN) == 0 {
		return nil
	}
	return []map[string]any{{"urls": c.STUN}}
}

func (c *Config) publicIPs() []string {
	if len(c.PublicIPs) == 1 && c.PublicIPs[0] == "auto" {
		c.publicMu.RLock()
		defer c.publicMu.RUnlock()
		return append([]string(nil), c.publicAuto...)
	}
	return c.PublicIPs
}

// discoverPublicIP learns the router's public IPv4 through STUN so a router port-forward of the
// mux port can be advertised. The address changes with the ISP lease, hence the refresh loop.
func (c *Config) discoverPublicIP() {
	for _, server := range c.STUN {
		addr := strings.TrimPrefix(server, "stun:")
		conn, err := stun.Dial("udp4", addr)
		if err != nil {
			continue
		}
		var ip string
		_ = conn.Do(stun.MustBuild(stun.TransactionID, stun.BindingRequest), func(res stun.Event) {
			var x stun.XORMappedAddress
			if res.Error == nil && x.GetFrom(res.Message) == nil {
				ip = x.IP.String()
			}
		})
		conn.Close()
		if ip != "" {
			c.publicMu.Lock()
			changed := len(c.publicAuto) != 1 || c.publicAuto[0] != ip
			c.publicAuto = []string{ip}
			c.publicMu.Unlock()
			if changed {
				log.Printf("public IPv4 via STUN: %s", ip)
			}
			return
		}
	}
}

type Server struct {
	cfg  *Config
	hub  *Hub
	auth Authority

	udpMux ice.UDPMux
	tcpMux ice.TCPMux

	mu         sync.Mutex
	sessions   map[*Session]struct{}
	controller *Session
	nextID     atomic.Uint64
}

func (srv *Server) newPeerConnection() (*webrtc.PeerConnection, error) {
	se := webrtc.SettingEngine{}
	se.SetICEUDPMux(srv.udpMux)
	if srv.tcpMux != nil {
		se.SetICETCPMux(srv.tcpMux)
	}
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	se.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	var rules []webrtc.ICEAddressRewriteRule
	if len(srv.cfg.HostIPs) > 0 {
		rules = append(rules, webrtc.ICEAddressRewriteRule{External: srv.cfg.HostIPs,
			AsCandidateType: webrtc.ICECandidateTypeHost, Mode: webrtc.ICEAddressRewriteReplace})
	}
	if len(rules) > 0 {
		if err := se.SetICEAddressRewriteRules(rules...); err != nil {
			return nil, err
		}
	}
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
			SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "transport-cc"}}},
		PayloadType: 102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	reg := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, reg); err != nil {
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(reg), webrtc.WithSettingEngine(se))
	var servers []webrtc.ICEServer
	if len(srv.cfg.STUN) > 0 {
		servers = []webrtc.ICEServer{{URLs: srv.cfg.STUN}}
	}
	return api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
}

// claimController makes s the only session allowed to inject input; a previous controller
// (another tab with the same lease cookie, or a stale reconnect) loses input immediately.
func (srv *Server) claimController(s *Session) {
	srv.mu.Lock()
	prev := srv.controller
	srv.controller = s
	srv.mu.Unlock()
	if prev != nil && prev != s {
		prev.revoke("另一个连接接管了控制")
	}
}

func (srv *Server) dropController(s *Session, reason string) {
	srv.mu.Lock()
	was := srv.controller == s
	if was {
		srv.controller = nil
	}
	srv.mu.Unlock()
	if was {
		s.revoke(reason)
	}
}

func (s *Session) revoke(reason string) {
	s.mu.Lock()
	in := s.input
	wasControl := s.mode == "control"
	s.mode = "view"
	s.mu.Unlock()
	if in != nil {
		in.SetActive(false)
	}
	if wasControl {
		log.Printf("session %d control ended: %s", s.id, reason)
		s.send(map[string]any{"type": "control", "active": false, "reason": reason})
	}
}

// authorityLoop re-validates the controller twice a second and lifts stuck fingers.
func (srv *Server) authorityLoop(ctx context.Context) {
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		srv.mu.Lock()
		s := srv.controller
		srv.mu.Unlock()
		if s == nil {
			continue
		}
		c, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		err := srv.auth.Check(c, s.token)
		cancel()
		if err != nil {
			srv.dropController(s, err.Error())
			continue
		}
		s.mu.Lock()
		in := s.input
		s.mu.Unlock()
		if in != nil && in.ReleaseIfSilent(3*time.Second) {
			log.Printf("session %d: controller silent with a finger down; released", s.id)
		}
	}
}

func (srv *Server) forget(s *Session) {
	srv.mu.Lock()
	delete(srv.sessions, s)
	srv.mu.Unlock()
}

func (srv *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Only the Portal reaches this port (internal network). It forwards the lease cookie as a
	// header; the browser cannot set it because the Portal overwrites it.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{srv: srv, id: srv.nextID.Add(1), ws: conn, ctx: ctx, cancel: cancel,
		token: r.Header.Get("X-Control-Token"), remote: r.Header.Get("X-Real-IP"), mode: "view",
		transport: "webrtc", started: time.Now()}
	srv.mu.Lock()
	srv.sessions[s] = struct{}{}
	srv.mu.Unlock()
	log.Printf("session %d (%s) opened", s.id, s.remote)
	s.run(r)
	conn.Close(websocket.StatusNormalClosure, "")
}

func (srv *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	srv.mu.Lock()
	type sessionInfo struct {
		ID        uint64          `json:"id"`
		Mode      string          `json:"mode"`
		Transport string          `json:"transport"`
		Profile   string          `json:"profile"`
		RTC       string          `json:"rtcState,omitempty"`
		Pair      string          `json:"pair,omitempty"`
		Seconds   int             `json:"seconds"`
		Report    json.RawMessage `json:"report,omitempty"`
		Dropped   int64           `json:"wsDropped,omitempty"`
	}
	var sessions []sessionInfo
	ctl := uint64(0)
	if srv.controller != nil {
		ctl = srv.controller.id
	}
	for s := range srv.sessions {
		s.mu.Lock()
		info := sessionInfo{ID: s.id, Mode: s.mode, Transport: s.transport, RTC: s.pcState, Pair: s.pair,
			Seconds: int(time.Since(s.started).Seconds()), Report: s.report}
		if s.source != nil {
			info.Profile = s.source.Profile().Name
		}
		if s.sink != nil {
			info.Dropped = s.sink.drops.Load()
		}
		s.mu.Unlock()
		sessions = append(sessions, info)
	}
	srv.mu.Unlock()
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"sources": srv.hub.Snapshot(), "sessions": sessions,
		"controller": ctl, "publicIPs": srv.cfg.publicIPs(), "hostIPs": srv.cfg.HostIPs,
		"udpPort": srv.cfg.UDPPort, "tcpPort": srv.cfg.TCPPort})
}

type deviceFile struct {
	Version   int    `json:"version"`
	Transport string `json:"transport"`
	Serial    string `json:"serial"`
	Address   string `json:"address"`
}

// readDevice returns the adb identifier and transport from DEVICE_CONFIG, mirroring the server's
// device-policy.js: version 1 is USB only; version 2 adds "tcp" with an exact "host:port".
func readDevice(path string) (string, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	var d deviceFile
	if err := json.Unmarshal(raw, &d); err != nil {
		return "", "", err
	}
	switch {
	case (d.Version == 1 || d.Version == 2) && d.Transport == "usb" && d.Serial != "":
		return d.Serial, "usb", nil
	case d.Version == 2 && d.Transport == "tcp":
		host, port, err := net.SplitHostPort(d.Address)
		n, perr := strconv.Atoi(port)
		if err != nil || perr != nil || host == "" || strings.Contains(host, ":") || n < 1 || n > 65535 {
			return "", "", errors.New(`tcp transport requires address "host:port"`)
		}
		return fmt.Sprintf("%s:%d", host, n), "tcp", nil
	}
	return "", "", errors.New(`device config must be version 1 (usb + serial) or 2 (usb + serial | tcp + address)`)
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	cfg := loadConfig()
	serial, transport, err := readDevice(cfg.DeviceCfg)
	if err != nil {
		log.Fatalf("device config: %v", err)
	}
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{Port: cfg.UDPPort})
	if err != nil {
		log.Fatalf("udp: %v", err)
	}
	srv := &Server{cfg: cfg, sessions: map[*Session]struct{}{},
		auth: &ManagerAuthority{Socket: cfg.RunnerSock, Origin: cfg.Origin, StatePath: cfg.ControlPath, MaxAge: 2500 * time.Millisecond}}
	srv.udpMux = ice.NewUniversalUDPMuxDefault(ice.UniversalUDPMuxParams{UDPConn: udp})
	if cfg.TCPPort > 0 {
		tcp, err := net.ListenTCP("tcp4", &net.TCPAddr{Port: cfg.TCPPort})
		if err != nil {
			log.Fatalf("tcp: %v", err)
		}
		srv.tcpMux = webrtc.NewICETCPMux(nil, tcp, 64)
	}
	dev := &PhoneDevice{ADB: &ADB{Addr: cfg.ADBAddr}, Serial: serial, Transport: transport, LocalJar: cfg.LocalJar, RemoteJar: cfg.RemoteJar,
		Encoder: cfg.Encoder, IFrameSec: cfg.IFrameSec}
	srv.hub = NewHub(dev, cfg.IdleStop)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go srv.authorityLoop(ctx)
	if len(cfg.PublicIPs) == 1 && cfg.PublicIPs[0] == "auto" {
		go func() {
			for {
				cfg.discoverPublicIP()
				select {
				case <-ctx.Done():
					return
				case <-time.After(10 * time.Minute):
				}
			}
		}()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", srv.handleWS)
	mux.HandleFunc("GET /stats", srv.handleStats)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	hs := &http.Server{Addr: cfg.Listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		srv.mu.Lock()
		for s := range srv.sessions {
			s.cancel()
		}
		srv.mu.Unlock()
		sh, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = hs.Shutdown(sh)
	}()
	log.Printf("media listening on %s (udp/tcp ICE %d/%d, %s device %s, host IPs %v, public %v)", cfg.Listen, cfg.UDPPort, cfg.TCPPort, transport, serial, cfg.HostIPs, cfg.PublicIPs)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
