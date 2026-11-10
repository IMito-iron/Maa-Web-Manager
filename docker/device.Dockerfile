FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
# Deliberately no VA-API/mesa drivers: scrcpy then falls back to software decoding, which is the
# only path that works under Xvfb. With libva present it selects the VA-API decoder and every frame
# fails with "could not import DMA-BUF as EGLImage (EGL error 0x3009)", so the mirror shows no
# frames at all (measured 2026-10-14).
RUN apt-get update && apt-get install -y --no-install-recommends nodejs xvfb x11vnc websockify novnc curl ca-certificates wget tar libusb-1.0-0 libegl1 libgl1 libgles2 xdotool && rm -rf /var/lib/apt/lists/*
# xdotool is how the supervisor drives scrcpy's own shortcuts (MOD+o turns the device screen off
# while mirroring continues) — the only way to darken this LCD without breaking the framebuffer.
# scrcpy 5.x bundles scrcpy + scrcpy-server + adb. We run BOTH the ADB server and
# scrcpy from this same container so scrcpy's adb forward/reverse endpoints stay
# local (a remote ADB server breaks scrcpy, GH #1939), and everything stays USB-only.
RUN wget -q https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-linux-x86_64-v5.0.1.tar.gz -O /tmp/scrcpy.tar.gz \
 && mkdir -p /opt/scrcpy && tar -xzf /tmp/scrcpy.tar.gz -C /opt/scrcpy --strip-components=1 && rm /tmp/scrcpy.tar.gz
ENV PATH=/opt/scrcpy:$PATH
COPY scripts/device.sh /usr/local/bin/device
COPY apps/server/src/device-policy.js /opt/device-policy.js
# The supervisor needs the same kernel view of the bus as the manager adapter.
COPY apps/server/src/usb-sysfs.js /opt/usb-sysfs.js
COPY scripts/device-supervisor.cjs /opt/device-supervisor.cjs
RUN chmod 755 /usr/local/bin/device && chmod 644 /opt/device-policy.js /opt/usb-sysfs.js /opt/device-supervisor.cjs
ENTRYPOINT ["/usr/local/bin/device"]
