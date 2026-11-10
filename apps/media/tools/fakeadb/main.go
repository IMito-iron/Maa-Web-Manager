// fakeadb is an ISOLATED TEST FIXTURE: it emulates an ADB server plus scrcpy-server 5.0.1 so the
// media service can be exercised end to end without a phone. Video is a pre-encoded x264 clip
// replayed at each instance's max_fps. Numbers measured against it validate the plumbing only and
// are never reported as device performance.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

var (
	listen = flag.String("listen", ":5037", "")
	serial = flag.String("serial", "FAKEUSB0001", "")
	clip   = flag.String("clip", "clip.h264", "Annex-B H.264 with AUDs")
)

type instance struct {
	fps    int
	conns  int
	reset  atomic.Bool
	closed chan struct{}
}

var (
	mu        sync.Mutex
	instances = map[string]*instance{}
	touches   atomic.Int64
	keys      atomic.Int64
	resets    atomic.Int64
	units     [][]byte // access units
	config    []byte
)

func splitNALs(b []byte) [][]byte {
	var out [][]byte
	start := -1
	for i := 0; i+3 < len(b); i++ {
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 {
			s := i
			if i > 0 && b[i-1] == 0 {
				s = i - 1
			}
			if start >= 0 {
				out = append(out, b[start:s])
			}
			start = s
			i += 2
		}
	}
	if start >= 0 {
		out = append(out, b[start:])
	}
	return out
}

func nalType(n []byte) byte {
	i := bytes.Index(n, []byte{0, 0, 1})
	return n[i+3] & 0x1f
}

func loadClip() {
	raw, err := os.ReadFile(*clip)
	if err != nil {
		log.Fatal(err)
	}
	var cur []byte
	for _, n := range splitNALs(raw) {
		switch t := nalType(n); t {
		case 9: // AUD starts an access unit
			if len(cur) > 0 {
				units = append(units, cur)
			}
			cur = nil
		case 7, 8:
			if len(units) == 0 {
				config = append(config, n...)
			}
		case 6:
		default:
			cur = append(cur, n...)
		}
	}
	if len(cur) > 0 {
		units = append(units, cur)
	}
	log.Printf("clip: %d access units, config %d bytes", len(units), len(config))
}

func readReq(r *bufio.Reader) (string, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return "", err
	}
	size, err := strconv.ParseUint(string(n[:]), 16, 16)
	if err != nil {
		return "", err
	}
	b := make([]byte, size)
	_, err = io.ReadFull(r, b)
	return string(b), err
}

var scidRe = regexp.MustCompile(`scid=([0-9a-f]{8})`)
var fpsRe = regexp.MustCompile(`max_fps=(\d+)`)

func handle(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	req, err := readReq(r)
	if err != nil {
		return
	}
	if req == "host:devices-l" {
		body := *serial + "          device usb:1-2 product:fake model:fake_phone device:fake transport_id:1\n"
		fmt.Fprintf(c, "OKAY%04x%s", len(body), body)
		return
	}
	if req != "host:transport:"+*serial {
		fmt.Fprintf(c, "FAIL%04x%s", 14, "unknown device")
		return
	}
	c.Write([]byte("OKAY"))
	svc, err := readReq(r)
	if err != nil {
		return
	}
	switch {
	case svc == "sync:":
		c.Write([]byte("OKAY"))
		for {
			var h [8]byte
			if _, err := io.ReadFull(r, h[:]); err != nil {
				return
			}
			n := binary.LittleEndian.Uint32(h[4:])
			switch string(h[:4]) {
			case "SEND", "DATA":
				io.CopyN(io.Discard, r, int64(n))
			case "DONE":
				c.Write([]byte("OKAY\x00\x00\x00\x00"))
			case "QUIT":
				return
			}
		}
	case len(svc) > 6 && svc[:6] == "shell:":
		m := scidRe.FindStringSubmatch(svc)
		f := fpsRe.FindStringSubmatch(svc)
		if m == nil || f == nil {
			fmt.Fprintf(c, "FAIL%04x%s", 3, "bad")
			return
		}
		fps, _ := strconv.Atoi(f[1])
		inst := &instance{fps: fps, closed: make(chan struct{})}
		mu.Lock()
		instances[m[1]] = inst
		mu.Unlock()
		c.Write([]byte("OKAY"))
		fmt.Fprintf(c, "[server] INFO: fake scrcpy-server scid=%s fps=%d\n", m[1], fps)
		io.Copy(io.Discard, r) // lives until the client closes the shell
		close(inst.closed)
		mu.Lock()
		delete(instances, m[1])
		mu.Unlock()
		log.Printf("instance %s ended", m[1])
	case len(svc) > 21 && svc[:21] == "localabstract:scrcpy_":
		mu.Lock()
		inst := instances[svc[21:]]
		var idx int
		if inst != nil {
			inst.conns++
			idx = inst.conns
		}
		mu.Unlock()
		if inst == nil {
			fmt.Fprintf(c, "FAIL%04x%s", 9, "no socket")
			return
		}
		c.Write([]byte("OKAY"))
		if idx == 1 {
			video(c, inst)
		} else {
			control(r, inst)
		}
	default:
		fmt.Fprintf(c, "FAIL%04x%s", 7, "unknown")
	}
}

func video(c net.Conn, inst *instance) {
	w := bufio.NewWriter(c)
	w.WriteByte(0)
	binary.Write(w, binary.BigEndian, uint32(0x68323634))
	session := make([]byte, 12)
	binary.BigEndian.PutUint32(session[0:], 0x80000000)
	binary.BigEndian.PutUint32(session[4:], 1280)
	binary.BigEndian.PutUint32(session[8:], 720)
	w.Write(session)
	hdr := make([]byte, 12)
	packet := func(head uint64, p []byte) {
		binary.BigEndian.PutUint64(hdr, head)
		binary.BigEndian.PutUint32(hdr[8:], uint32(len(p)))
		w.Write(hdr)
		w.Write(p)
	}
	packet(1<<62, config)
	start := time.Now()
	tick := time.NewTicker(time.Second / time.Duration(inst.fps))
	defer tick.Stop()
	i := 0
	for {
		select {
		case <-inst.closed:
			return
		case <-tick.C:
		}
		if inst.reset.Swap(false) {
			// jump to the next IDR in the clip, as a real encoder reset would produce one
			for j := 1; j < len(units); j++ {
				k := (i + j) % len(units)
				if nalType(units[k]) == 5 {
					i = k
					break
				}
			}
			packet(1<<62, config)
		}
		u := units[i%len(units)]
		head := uint64(time.Since(start).Microseconds())
		if nalType(u) == 5 {
			head |= 1 << 61
		}
		packet(head, u)
		if err := w.Flush(); err != nil {
			return
		}
		i++
	}
}

func control(r *bufio.Reader, inst *instance) {
	for {
		t, err := r.ReadByte()
		if err != nil {
			return
		}
		switch t {
		case 2:
			io.CopyN(io.Discard, r, 31)
			touches.Add(1)
		case 0:
			io.CopyN(io.Discard, r, 13)
			keys.Add(1)
		case 17:
			inst.reset.Store(true)
			resets.Add(1)
		default:
			log.Printf("unexpected control type %d", t)
			return
		}
	}
}

func main() {
	flag.Parse()
	loadClip()
	l, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		for range time.Tick(5 * time.Second) {
			mu.Lock()
			n := len(instances)
			mu.Unlock()
			log.Printf("instances=%d touches=%d keys=%d resets=%d", n, touches.Load(), keys.Load(), resets.Load())
		}
	}()
	for {
		c, err := l.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go handle(c)
	}
}
