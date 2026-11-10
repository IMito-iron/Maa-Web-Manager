package main

// Device input. The media service never decides on its own who may control the phone: every
// input session is backed by the Manager's existing exclusive lease (DeviceControl) and re-checked
// continuously. Two independent gates must both pass:
//   1. Manager GET /api/control with the browser's lease token says owned && !running;
//   2. the Manager's published /control-state/control.json says held (lease held, no task running,
//      not shutting down) and is fresh (< 2.5 s), the same rule that gates x11vnc.
// Losing either gate, a disconnect, or a silent controller releases every pointer that is still
// down and stops accepting input immediately.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"
)

const (
	actionDown = 0
	actionUp   = 1
	actionMove = 2

	keycodeHome      = 3
	keycodeBack      = 4
	keycodeAppSwitch = 187
)

// EncodeTouch builds scrcpy's INJECT_TOUCH_EVENT (32 bytes, ControlMessageReader.parseInjectTouchEvent).
func EncodeTouch(action byte, pointerID int64, x, y, w, h int, pressure float64) []byte {
	b := make([]byte, 32)
	b[0] = 2
	b[1] = action
	binary.BigEndian.PutUint64(b[2:], uint64(pointerID))
	binary.BigEndian.PutUint32(b[10:], uint32(int32(x)))
	binary.BigEndian.PutUint32(b[14:], uint32(int32(y)))
	binary.BigEndian.PutUint16(b[18:], uint16(w))
	binary.BigEndian.PutUint16(b[20:], uint16(h))
	p := math.Max(0, math.Min(1, pressure))
	fixed := uint16(0xffff)
	if p < 1 {
		fixed = uint16(p * 65536)
	}
	binary.BigEndian.PutUint16(b[22:], fixed)
	// actionButton and buttons stay 0: these are finger touches, not mouse buttons.
	return b
}

// EncodeKey builds INJECT_KEYCODE (14 bytes).
func EncodeKey(action byte, keycode int) []byte {
	b := make([]byte, 14)
	b[0] = 0
	b[1] = action
	binary.BigEndian.PutUint32(b[2:], uint32(keycode))
	return b
}

// ---- authority ---------------------------------------------------------------------------

type Authority interface {
	// Check returns nil when the token currently owns the Manager lease and no task runs.
	Check(ctx context.Context, token string) error
}

var tokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type ManagerAuthority struct {
	Socket    string
	Origin    string
	StatePath string
	MaxAge    time.Duration
	client    *http.Client
	once      sync.Once
}

func (m *ManagerAuthority) http() *http.Client {
	m.once.Do(func() {
		m.client = &http.Client{Timeout: 1500 * time.Millisecond, Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", m.Socket)
			},
			MaxIdleConns: 2,
		}}
	})
	return m.client
}

type controlStatus struct {
	Held    bool `json:"held"`
	Owned   bool `json:"owned"`
	Running bool `json:"running"`
}

type controlState struct {
	Held      bool  `json:"held"`
	CheckedAt int64 `json:"checkedAt"`
}

func (m *ManagerAuthority) Check(ctx context.Context, token string) error {
	if !tokenPattern.MatchString(token) {
		return errors.New("没有控制凭据，请先进入控制")
	}
	raw, err := os.ReadFile(m.StatePath)
	if err != nil {
		return errors.New("控制状态不可用")
	}
	var state controlState
	if json.Unmarshal(raw, &state) != nil {
		return errors.New("控制状态无效")
	}
	age := time.Since(time.UnixMilli(state.CheckedAt))
	if !state.Held || age < 0 || age > m.MaxAge {
		return errors.New("控制未持有、已过期或自动任务正在运行")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://manager/api/control", nil)
	req.Header.Set("origin", m.Origin)
	req.Header.Set("x-control-token", token)
	res, err := m.http().Do(req)
	if err != nil {
		return errors.New("无法向 Manager 校验控制权")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Manager 拒绝控制校验 (%d)", res.StatusCode)
	}
	var status controlStatus
	if err := json.NewDecoder(http.MaxBytesReader(nil, res.Body, 4096)).Decode(&status); err != nil {
		return errors.New("Manager 控制状态无效")
	}
	if status.Running {
		return errors.New("自动任务正在运行，人工输入已禁止")
	}
	if !status.Owned {
		return errors.New("控制已释放、过期或被其他浏览器持有")
	}
	return nil
}

// ---- input session -----------------------------------------------------------------------

// InputMessage is what the browser sends. Coordinates are normalised to the video picture
// (0..1), so they are independent of the browser's scaling and of the capture tier.
type InputMessage struct {
	T string  `json:"t"` // d(own) m(ove) u(p) c(ancel) k(ey) hb
	I int     `json:"i"` // pointer slot 0..9
	X float64 `json:"x"`
	Y float64 `json:"y"`
	P float64 `json:"p"`
	K string  `json:"k"`
}

type pointer struct{ x, y float64 }

// Target is where input is written: the control socket of the capture the controller watches.
type Target interface {
	Control() (Capture, int, int, bool)
}

// InputSession serialises one controller's input. All writes go through one mutex in arrival
// order, so down/move/up ordering is preserved exactly.
type InputSession struct {
	mu       sync.Mutex
	target   Target
	pointers map[int]pointer
	lastSeen time.Time
	active   bool
	sent     int
	dropped  int
}

func NewInputSession(target Target) *InputSession {
	return &InputSession{target: target, pointers: map[int]pointer{}, lastSeen: time.Now()}
}

func (s *InputSession) SetActive(active bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active && !active {
		s.releaseLocked()
	}
	s.active = active
}

// Retarget moves input to another capture (tier switch), releasing pointers on the old one first.
func (s *InputSession) Retarget(t Target) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked()
	s.target = t
}

func clamp01(v float64) float64 {
	if math.IsNaN(v) {
		return 0
	}
	return math.Max(0, math.Min(1, v))
}

func (s *InputSession) Handle(m InputMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen = time.Now()
	if m.T == "hb" {
		return nil
	}
	if !s.active {
		s.dropped++
		return errors.New("input not authorised")
	}
	capture, w, h, ok := s.target.Control()
	if !ok {
		s.dropped++
		return errors.New("capture not running")
	}
	send := func(msg []byte) error {
		if err := capture.SendControl(msg); err != nil {
			return err
		}
		s.sent++
		return nil
	}
	px := func(x, y float64) (int, int) {
		return int(math.Round(clamp01(x) * float64(w-1))), int(math.Round(clamp01(y) * float64(h-1)))
	}
	switch m.T {
	case "d", "m", "u", "c":
		if m.I < 0 || m.I > 9 {
			return errors.New("invalid pointer")
		}
		_, down := s.pointers[m.I]
		x, y := px(m.X, m.Y)
		pressure := m.P
		if pressure <= 0 {
			pressure = 1
		}
		switch m.T {
		case "d":
			action := byte(actionDown)
			if down {
				action = actionMove
			}
			s.pointers[m.I] = pointer{clamp01(m.X), clamp01(m.Y)}
			return send(EncodeTouch(action, int64(m.I), x, y, w, h, pressure))
		case "m":
			if !down {
				return nil // a move without a down is a hover; fingers cannot hover
			}
			s.pointers[m.I] = pointer{clamp01(m.X), clamp01(m.Y)}
			return send(EncodeTouch(actionMove, int64(m.I), x, y, w, h, pressure))
		default: // up and cancel both lift the finger where it is
			if !down {
				return nil
			}
			delete(s.pointers, m.I)
			return send(EncodeTouch(actionUp, int64(m.I), x, y, w, h, 0))
		}
	case "k":
		code := map[string]int{"back": keycodeBack, "home": keycodeHome, "apps": keycodeAppSwitch}[m.K]
		if code == 0 {
			return errors.New("key not allowed")
		}
		if err := send(EncodeKey(actionDown, code)); err != nil {
			return err
		}
		return send(EncodeKey(actionUp, code))
	}
	return errors.New("unknown input")
}

// Silent releases pointers when the controller has gone quiet (lost network, frozen tab) while a
// finger is down, so a long press can never get stuck.
func (s *InputSession) ReleaseIfSilent(limit time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pointers) == 0 || time.Since(s.lastSeen) < limit {
		return false
	}
	s.releaseLocked()
	return true
}

// SizeChanged lifts every finger after a rotation: scrcpy drops events for the old size, so the
// up must be expressed in the new geometry.
func (s *InputSession) SizeChanged() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked()
}

func (s *InputSession) Release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked()
}

func (s *InputSession) releaseLocked() {
	if len(s.pointers) == 0 {
		return
	}
	capture, w, h, ok := s.target.Control()
	for id, p := range s.pointers {
		if ok {
			x := int(math.Round(p.x * float64(w-1)))
			y := int(math.Round(p.y * float64(h-1)))
			_ = capture.SendControl(EncodeTouch(actionUp, int64(id), x, y, w, h, 0))
		}
		delete(s.pointers, id)
	}
}

func (s *InputSession) Counters() (sent, dropped, down int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sent, s.dropped, len(s.pointers)
}
