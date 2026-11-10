#!/bin/bash
set -euo pipefail
umask 077
pids=()
cleanup() { trap - EXIT TERM INT; if ((${#pids[@]})); then kill "${pids[@]}" 2>/dev/null || true; wait || true; fi; }
trap cleanup EXIT
trap 'exit 0' TERM INT

# The ADB server owns the device and serves the manager over TCP 5037 on the internal network.
# Scrcpy (below) uses this SAME local server, so its adb forward/reverse endpoints stay local.
# DEVICE_CONFIG chooses the transport: "usb" (a phone on /dev/bus/usb) or "tcp" (the one configured
# host:port, e.g. an emulator; the supervisor runs `adb connect` to it). `adb tcpip` is never used.
#
# The server is started by the supervisor instead of here on purpose: this container has
# no libudev and no /run/udev, so an ADB server that is already running never notices a
# phone that was replugged. The supervisor restarts the server when /sys/bus/usb/devices
# changes, which is what lets a phone reboot or cable replug recover without a container
# restart. The socket is exported first so scrcpy and the supervisor's own client calls
# all speak to that one server.
export ADB_SERVER_SOCKET=tcp:127.0.0.1:5037

# The X screen is the canvas every mirrored frame is drawn onto, so it is published to
# the manager: the browser sizes the phone panel to this ratio to avoid dead padding.
export XVFB_SIZE=1920x1080

# Xvfb, then the VNC server, then scrcpy. Order matters: scrcpy's EGL/GL setup must not
# race x11vnc's own startup, which reads the whole framebuffer and can briefly hold the
# server. The supervisor additionally probes the RFB banner before its first scrcpy.
Xvfb :99 -screen 0 "${XVFB_SIZE}x24" -nolisten tcp -noreset & pids+=("$!")
for ((i=0;i<50;i++)); do [[ -S /tmp/.X11-unix/X99 ]] && break; sleep .2; done
mkdir -p /stats
x11vnc -display :99 -rfbport 5901 -localhost -forever -shared -nopw -viewonly & pids+=("$!")
websockify --web=/usr/share/novnc 6080 127.0.0.1:5901 & pids+=("$!")
node /opt/device-supervisor.cjs & pids+=("$!")

# If scrcpy dies (e.g. USB unplugged), exit -> container restarts; the manager's
# DeviceManager marks the device disconnected and blocks MAA + display control.
wait -n "${pids[@]}"
exit 1
