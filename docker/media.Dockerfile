# Low-latency Android media service: scrcpy-server H.264 capture fanned out over WebRTC, with an
# H.264-over-WebSocket fallback. Talks to the device container's ADB server; never owns USB.
FROM golang@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS build
WORKDIR /src
COPY apps/media/go.mod apps/media/go.sum ./
RUN go mod download
COPY apps/media/ ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/maa-media .
# The exact scrcpy-server the device container runs (v5.0.1); the protocol is version-locked.
RUN wget -q https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-linux-x86_64-v5.0.1.tar.gz -O /tmp/s.tgz \
 && mkdir /tmp/s && tar -xzf /tmp/s.tgz -C /tmp/s --strip-components=1 \
 && echo "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536  /tmp/s/scrcpy-server" | sha256sum -c - \
 && cp /tmp/s/scrcpy-server /out/scrcpy-server

FROM alpine@sha256:bfe7ceb9f09ec0566c48fb93356e45a47a00be5a1dd14fa5b909e7709c66b034
RUN apk add --no-cache wget
COPY --from=build /out/maa-media /usr/local/bin/maa-media
COPY --from=build /out/scrcpy-server /opt/scrcpy/scrcpy-server
USER 1000:1000
EXPOSE 8090 8189/udp 8189/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8090/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/maa-media"]
