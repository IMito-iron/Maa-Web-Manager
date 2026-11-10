package main

// Minimal client for the ADB server's smart-socket protocol.
//
// The media service never runs its own ADB server: the device container owns the USB phone and
// serves it on tcp:device:5037 (the same server MAA uses). Streams are opened through that server
// with host:transport:<serial> followed by a device service, so no `adb forward` port is created
// anywhere (a forward would land in the device container's namespace, scrcpy GH #1939).

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type ADB struct {
	Addr    string // host:port of the ADB server
	Timeout time.Duration
}

func (a *ADB) dial() (net.Conn, error) {
	timeout := a.Timeout
	if timeout == 0 {
		timeout = 3 * time.Second
	}
	return net.DialTimeout("tcp", a.Addr, timeout)
}

func writeRequest(conn net.Conn, request string) error {
	if len(request) > 0xffff {
		return errors.New("adb request too long")
	}
	_, err := fmt.Fprintf(conn, "%04x%s", len(request), request)
	return err
}

func readStatus(r io.Reader) error {
	var status [4]byte
	if _, err := io.ReadFull(r, status[:]); err != nil {
		return err
	}
	switch string(status[:]) {
	case "OKAY":
		return nil
	case "FAIL":
		message, err := readLengthPrefixed(r)
		if err != nil {
			return errors.New("adb: FAIL")
		}
		return fmt.Errorf("adb: %s", message)
	default:
		return fmt.Errorf("adb: unexpected status %q", status)
	}
}

func readLengthPrefixed(r io.Reader) (string, error) {
	var size [4]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return "", err
	}
	n, err := strconv.ParseUint(string(size[:]), 16, 32)
	if err != nil {
		return "", err
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return "", err
	}
	return string(data), nil
}

// hostQuery runs a host: service and returns its length-prefixed answer.
func (a *ADB) hostQuery(service string) (string, error) {
	conn, err := a.dial()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if err := writeRequest(conn, service); err != nil {
		return "", err
	}
	if err := readStatus(conn); err != nil {
		return "", err
	}
	return readLengthPrefixed(conn)
}

// ADBDevice is one line of `adb devices -l`. Transport is "usb" for USB attachments and "tcp" otherwise
// (network devices are listed by the exact "host:port" they were connected with).
type ADBDevice struct {
	Serial    string
	State     string
	Model     string
	Transport string
}

// USBDevice is kept for callers of the USB-only releases.
type USBDevice = ADBDevice

// ParseDevices parses every line of `adb devices -l`.
func ParseDevices(output string) []ADBDevice {
	var devices []ADBDevice
	for _, line := range strings.Split(output, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 || strings.HasPrefix(line, "List of devices") || strings.HasPrefix(parts[0], "*") {
			continue
		}
		d := ADBDevice{Serial: parts[0], State: parts[1], Transport: "tcp"}
		for _, p := range parts[2:] {
			if strings.HasPrefix(p, "usb:") {
				d.Transport = "usb"
			}
			if strings.HasPrefix(p, "model:") {
				d.Model = strings.TrimPrefix(p, "model:")
			}
		}
		devices = append(devices, d)
	}
	return devices
}

// ParseUSBDevices keeps USB transports only.
func ParseUSBDevices(output string) []USBDevice {
	var devices []USBDevice
	for _, d := range ParseDevices(output) {
		if d.Transport == "usb" {
			devices = append(devices, d)
		}
	}
	return devices
}

// Resolve succeeds only when the configured device is listed over the configured transport in
// "device" state. The media service never opens transports; the device container owns them.
func (a *ADB) Resolve(serial, transport string) error {
	out, err := a.hostQuery("host:devices-l")
	if err != nil {
		return err
	}
	for _, d := range ParseDevices(out) {
		if d.Serial == serial && d.Transport == transport {
			if d.State != "device" {
				return fmt.Errorf("device %s is %s", serial, d.State)
			}
			return nil
		}
	}
	return fmt.Errorf("device %s is not attached over %s", serial, transport)
}

// ResolveUSB is Resolve for a USB phone.
func (a *ADB) ResolveUSB(serial string) error { return a.Resolve(serial, "usb") }

// Open connects to a device service (shell:..., localabstract:..., sync:) on the given serial.
func (a *ADB) Open(serial, service string) (net.Conn, error) {
	conn, err := a.dial()
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fail := func(err error) (net.Conn, error) { conn.Close(); return nil, err }
	if err := writeRequest(conn, "host:transport:"+serial); err != nil {
		return fail(err)
	}
	if err := readStatus(conn); err != nil {
		return fail(err)
	}
	if err := writeRequest(conn, service); err != nil {
		return fail(err)
	}
	if err := readStatus(conn); err != nil {
		return fail(err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

// Push uploads a local file through the sync protocol.
func (a *ADB) Push(serial, local, remote string, mode os.FileMode) error {
	data, err := os.ReadFile(local)
	if err != nil {
		return err
	}
	conn, err := a.Open(serial, "sync:")
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	w := bufio.NewWriter(conn)
	header := func(id string, n uint32) {
		w.WriteString(id)
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], n)
		w.Write(b[:])
	}
	target := fmt.Sprintf("%s,%d", remote, mode.Perm())
	header("SEND", uint32(len(target)))
	w.WriteString(target)
	for off := 0; off < len(data); off += 65536 {
		end := min(off+65536, len(data))
		header("DATA", uint32(end-off))
		w.Write(data[off:end])
	}
	header("DONE", uint32(time.Now().Unix()))
	if err := w.Flush(); err != nil {
		return err
	}
	var reply [8]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		return err
	}
	if string(reply[:4]) != "OKAY" {
		n := binary.LittleEndian.Uint32(reply[4:])
		msg := make([]byte, min(n, 4096))
		io.ReadFull(conn, msg)
		return fmt.Errorf("adb push failed: %s", msg)
	}
	header("QUIT", 0)
	w.Flush()
	return nil
}
