# syntax=docker/dockerfile:1.7

# Public defaults are pinned multi-platform manifests so a developer build is
# reproducible. Production must still override both with scanned internal
# mirrors pinned by their approved @sha256 digests.
ARG JAVA_MAVEN_BASE_IMAGE=maven:3.9.9-eclipse-temurin-21-jammy@sha256:7f8422bd81f19b9035007a75e2f82272b09af64db08848d7d4e93302466e8b6f
ARG NODE_BASE_IMAGE=node:18.16.1-bullseye-slim@sha256:1ba1ddfc61b385b6436fd0fa0d1d42d322a0cd03c1ff110fa39e828511152aef

FROM ${NODE_BASE_IMAGE} AS node_runtime

FROM ${JAVA_MAVEN_BASE_IMAGE}

ARG INSTALL_OS_PACKAGES=true
ARG BUILDER_UID=10001
ARG BUILDER_GID=10001

LABEL org.opencontainers.image.title="Mae-Flow Cloud task build environment" \
      org.opencontainers.image.description="JDK 21, Maven, Node 18/npm 9 and native build tools for isolated task commands" \
      com.mae-flow.toolchain.java="21" \
      com.mae-flow.toolchain.node="18.16.1" \
      com.mae-flow.toolchain.npm="9.5.1"

USER root

# A fully offline internal base image may already contain these packages; in
# that case build with INSTALL_OS_PACKAGES=false. The validation below still
# fails closed if the approved base is incomplete.
RUN if [ "${INSTALL_OS_PACKAGES}" = "true" ]; then \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        binutils \
        bison \
        build-essential \
        ca-certificates \
        ccache \
        cmake \
        flex \
        g++ \
        gcc \
        git \
        ninja-build \
        pkg-config \
        procps \
        python3 \
        tini; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# The official Node image owns the Node/npm distribution. Copying it avoids a
# curl/bootstrap script and keeps the compatibility baseline explicit.
COPY --from=node_runtime /usr/local/ /usr/local/

RUN groupadd --gid "${BUILDER_GID}" builder \
    && useradd --uid "${BUILDER_UID}" --gid "${BUILDER_GID}" \
      --create-home --home-dir /home/mae-flow --shell /bin/bash builder \
    && install -d -o "${BUILDER_UID}" -g "${BUILDER_GID}" \
      /cache/maven/repository \
      /cache/npm \
      /cache/ccache \
      /cache/xdg \
      /etc/mae-flow/ca \
      /etc/mae-flow/maven \
      /home/mae-flow/.m2 \
      /tmp/mae-flow-build

COPY entrypoint.sh /usr/local/bin/mae-flow-build-entrypoint
RUN chmod 0755 /usr/local/bin/mae-flow-build-entrypoint \
    && java -version \
    && mvn --version \
    && test "$(node --version)" = "v18.16.1" \
    && test "$(npm --version)" = "9.5.1" \
    && gcc --version \
    && g++ --version \
    && ld --version \
    && bison --version \
    && flex --version \
    && ccache --version \
    && git --version \
    && python3 --version

ENV HOME=/home/mae-flow \
    MAVEN_CONFIG=/home/mae-flow/.m2 \
    MFC_MAVEN_CACHE=/cache/maven/repository \
    MAVEN_OPTS="-Dmaven.repo.local=/cache/maven/repository" \
    NPM_CONFIG_CACHE=/cache/npm \
    NPM_CONFIG_USERCONFIG=/home/mae-flow/.npmrc \
    CCACHE_DIR=/cache/ccache \
    CCACHE_COMPRESS=true \
    CCACHE_MAXSIZE=5G \
    XDG_CACHE_HOME=/cache/xdg \
    TMPDIR=/tmp/mae-flow-build

WORKDIR /workspace
USER builder:builder

# Cloud starts task containers with Docker --init, so the image must not add a
# second nested init process. Standalone smoke runs should also pass --init.
ENTRYPOINT ["/usr/local/bin/mae-flow-build-entrypoint"]
CMD ["sleep", "infinity"]
