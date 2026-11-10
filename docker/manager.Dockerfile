FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm adb ca-certificates tzdata util-linux libatomic1 libz1 libgcc-s1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY --chmod=0755 apps ./apps
RUN npm run generate && npm run build
COPY vendor/maa-runtime.tar.gz vendor/maa-runtime.sha256 /tmp/
RUN cd /tmp && sha256sum -c maa-runtime.sha256 && mkdir -p /opt/maa && tar -xzf maa-runtime.tar.gz -C /opt/maa && rm maa-runtime.tar.gz && MAA_DATA_DIR=/opt/maa/share /opt/maa/bin/maa version && ldd /opt/maa/share/lib/libMaaCore.so | tee /opt/maa/dependencies.txt && ! grep -q 'not found' /opt/maa/dependencies.txt
RUN mkdir -p /opt/maa/xdg /home/manager && ln -s /opt/maa/share /opt/maa/xdg/maa && chown -R 1000:1000 /home/manager /opt/maa/share
ENV MAA_BIN=/opt/maa/bin/maa MAA_DATA_DIR=/opt/maa/share XDG_DATA_HOME=/opt/maa/xdg LD_LIBRARY_PATH=/opt/maa/share/lib
COPY scripts/maa-managerctl.cjs /usr/local/bin/maa-managerctl
COPY scripts/manager-entrypoint.sh /usr/local/bin/manager-entrypoint
COPY scripts/install-maa-resource.cjs /app/scripts/install-maa-resource.cjs
COPY config/maa-resource /app/config/maa-resource
RUN chmod 755 /usr/local/bin/maa-managerctl /usr/local/bin/manager-entrypoint
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/manager-entrypoint"]
