package main

// One scrcpy-server process on the phone: hardware H.264 capture plus scrcpy's own control socket.
//
// Protocol (scrcpy 5.0.1, server/src/main/java/com/genymobile/scrcpy/device/{DesktopConnection,
// Streamer}.java): with tunnel_forward=true the server listens on localabstract:scrcpy_<scid>; the
// first accepted socket (video) receives one dummy byte, then a 4-byte codec id, then a sequence of
// 12-byte headers. A header whose bit 63 is set is a session packet (flags, width, height: the
// capture size, re-sent on rotation); otherwise it is pts|flags (bit 62 config, bit 61 key frame)
// followed by a 4-byte payload size. The second socket is the control socket.

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	scrcpyVersion   = "5.0.1"
	codecH264       = 0x68323634
	flagSession     = uint64(1) << 63
	flagConfig      = uint64(1) << 62
	flagKeyFrame    = uint64(1) << 61
	maxPacketBytes  = 8 << 20
	controlResetVid = 17
)

// Frame is one encoded access unit, Annex-B, with the parameter sets prepended to key frames.
type Frame struct {
	Data    []byte
	PTS     uint64 // device capture timestamp, µs (device clock)
	Key     bool
	Arrival time.Time
	Width   int
	Height  int
}

type InstanceOptions struct {
	Serial    string
	ServerJar string // path on the phone
	MaxSize   int
	MaxFPS    int
	BitRate   int
	IFrameSec int
	Encoder   string // optional explicit encoder name
	LogPrefix string
}

// Args builds the scrcpy-server argument list. Everything that would change device state is off:
// no power-on, no cleanup process, no clipboard sync, no stay-awake, no show-touches, no audio.
// The display-power state set by the existing noVNC mirror (--turn-screen-off) is left alone.
func (o InstanceOptions) Args(scid uint32) []string {
	args := []string{
		"CLASSPATH=" + o.ServerJar, "app_process", "/", "com.genymobile.scrcpy.Server", scrcpyVersion,
		fmt.Sprintf("scid=%08x", scid), "log_level=info", "tunnel_forward=true",
		"audio=false", "control=true", "video_codec=h264",
		fmt.Sprintf("max_size=%d", o.MaxSize), fmt.Sprintf("max_fps=%d", o.MaxFPS),
		fmt.Sprintf("video_bit_rate=%d", o.BitRate),
		fmt.Sprintf("video_codec_options=i-frame-interval:int=%d", max(1, o.IFrameSec)),
		"power_on=false", "cleanup=false", "clipboard_autosync=false", "send_device_meta=false",
		"stay_awake=false", "show_touches=false",
	}
	if o.Encoder != "" {
		args = append(args, "video_encoder="+o.Encoder)
	}
	return args
}

type Instance struct {
	opts    InstanceOptions
	scid    uint32
	shell   net.Conn
	video   net.Conn
	control net.Conn
	ctlMu   sync.Mutex
	done    chan struct{}
	once    sync.Once
	err     error
	logMu   sync.Mutex
	logTail string

	sizeMu sync.RWMutex
	width  int
	height int
}

func shellQuote(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		if a != "" && strings.IndexFunc(a, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("=_-./:,", r))
		}) < 0 {
			quoted[i] = a
		} else {
			quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
	}
	return strings.Join(quoted, " ")
}

// StartInstance launches the server and connects its video and control sockets.
func StartInstance(adb *ADB, opts InstanceOptions) (*Instance, error) {
	inst := &Instance{opts: opts, scid: rand.Uint32() & 0x7fffffff, done: make(chan struct{})}
	shell, err := adb.Open(opts.Serial, "shell:"+shellQuote(opts.Args(inst.scid)))
	if err != nil {
		return nil, fmt.Errorf("start scrcpy-server: %w", err)
	}
	inst.shell = shell
	go inst.readShell()
	name := fmt.Sprintf("localabstract:scrcpy_%08x", inst.scid)
	deadline := time.Now().Add(8 * time.Second)
	for {
		if time.Now().After(deadline) {
			inst.Close()
			return nil, fmt.Errorf("scrcpy-server did not accept connections: %s", inst.LogTail())
		}
		select {
		case <-inst.done:
			return nil, fmt.Errorf("scrcpy-server exited: %s", inst.LogTail())
		default:
		}
		conn, err := adb.Open(opts.Serial, name)
		if err != nil {
			time.Sleep(60 * time.Millisecond)
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		var dummy [1]byte
		if _, err := io.ReadFull(conn, dummy[:]); err != nil {
			// The abstract socket does not exist yet; adbd closes the stream immediately.
			conn.Close()
			time.Sleep(60 * time.Millisecond)
			continue
		}
		inst.video = conn
		break
	}
	ctl, err := adb.Open(opts.Serial, name)
	if err != nil {
		inst.Close()
		return nil, fmt.Errorf("connect control socket: %w", err)
	}
	inst.control = ctl
	go func() { _, _ = io.Copy(io.Discard, ctl) }() // device messages (clipboard etc.) are not used
	_ = inst.video.SetReadDeadline(time.Now().Add(5 * time.Second))
	var codec [4]byte
	if _, err := io.ReadFull(inst.video, codec[:]); err != nil {
		inst.Close()
		return nil, fmt.Errorf("read codec id: %w", err)
	}
	if id := binary.BigEndian.Uint32(codec[:]); id != codecH264 {
		inst.Close()
		return nil, fmt.Errorf("unexpected codec id %#x (0/1 = stream disabled/error): %s", id, inst.LogTail())
	}
	_ = inst.video.SetReadDeadline(time.Time{})
	return inst, nil
}

func (i *Instance) readShell() {
	buf := make([]byte, 4096)
	for {
		n, err := i.shell.Read(buf)
		if n > 0 {
			i.logMu.Lock()
			i.logTail = (i.logTail + string(buf[:n]))
			if len(i.logTail) > 8192 {
				i.logTail = i.logTail[len(i.logTail)-8192:]
			}
			i.logMu.Unlock()
			for _, line := range strings.Split(strings.TrimSpace(string(buf[:n])), "\n") {
				if line != "" {
					log.Printf("%s scrcpy: %s", i.opts.LogPrefix, strings.TrimSpace(line))
				}
			}
		}
		if err != nil {
			i.closeWith(errors.New("scrcpy-server process ended"))
			return
		}
	}
}

func (i *Instance) LogTail() string {
	i.logMu.Lock()
	defer i.logMu.Unlock()
	return strings.TrimSpace(i.logTail)
}

func (i *Instance) Size() (int, int) {
	i.sizeMu.RLock()
	defer i.sizeMu.RUnlock()
	return i.width, i.height
}

// ReadFrames parses the video socket until it fails; onSize is called on every session packet.
func (i *Instance) ReadFrames(onFrame func(*Frame), onSize func(w, h int)) error {
	r := bufio.NewReaderSize(i.video, 1<<18)
	var header [12]byte
	var config []byte
	for {
		if _, err := io.ReadFull(r, header[:]); err != nil {
			i.closeWith(err)
			return err
		}
		head := binary.BigEndian.Uint64(header[:8])
		if head&flagSession != 0 {
			w := int(binary.BigEndian.Uint32(header[4:8]))
			h := int(binary.BigEndian.Uint32(header[8:12]))
			i.sizeMu.Lock()
			i.width, i.height = w, h
			i.sizeMu.Unlock()
			if onSize != nil {
				onSize(w, h)
			}
			continue
		}
		size := binary.BigEndian.Uint32(header[8:12])
		if size == 0 || size > maxPacketBytes {
			err := fmt.Errorf("invalid packet size %d", size)
			i.closeWith(err)
			return err
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(r, payload); err != nil {
			i.closeWith(err)
			return err
		}
		arrival := time.Now()
		if head&flagConfig != 0 {
			config = payload
			continue
		}
		key := head&flagKeyFrame != 0
		data := payload
		if key && len(config) > 0 && !bytes.HasPrefix(payload, config) {
			data = make([]byte, 0, len(config)+len(payload))
			data = append(append(data, config...), payload...)
		}
		w, h := i.Size()
		onFrame(&Frame{Data: data, PTS: head &^ (flagConfig | flagKeyFrame), Key: key, Arrival: arrival, Width: w, Height: h})
	}
}

// SendControl writes one complete scrcpy control message. Messages are written whole and in
// order under a mutex, so concurrent callers never interleave bytes.
func (i *Instance) SendControl(msg []byte) error {
	i.ctlMu.Lock()
	defer i.ctlMu.Unlock()
	if i.control == nil {
		return errors.New("no control socket")
	}
	_ = i.control.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := i.control.Write(msg)
	if err != nil {
		i.closeWith(err)
	}
	return err
}

// ResetVideo asks the server to restart capture/encoding, which yields a fresh key frame.
func (i *Instance) ResetVideo() error { return i.SendControl([]byte{controlResetVid}) }

func (i *Instance) Done() <-chan struct{} { return i.done }

func (i *Instance) closeWith(err error) {
	i.once.Do(func() {
		i.err = err
		for _, c := range []net.Conn{i.video, i.control, i.shell} {
			if c != nil {
				c.Close()
			}
		}
		close(i.done)
	})
}

// Close stops the server: closing its sockets makes scrcpy-server exit on the phone.
func (i *Instance) Close() { i.closeWith(errors.New("closed")) }
