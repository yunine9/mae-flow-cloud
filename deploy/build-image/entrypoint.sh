#!/bin/sh
set -eu

umask "${MFC_BUILD_UMASK:-0022}"

# Bind-mounted caches must be owned by the configured builder uid/gid. Failing
# here gives the administrator a useful error instead of a late Maven/npm miss.
for directory in \
  "${HOME}" \
  "${MAVEN_CONFIG}" \
  "${MFC_MAVEN_CACHE}" \
  "${NPM_CONFIG_CACHE}" \
  "${CCACHE_DIR}" \
  "${XDG_CACHE_HOME}" \
  "${TMPDIR}"
do
  mkdir -p "${directory}"
  if [ ! -w "${directory}" ]; then
    echo "build environment is not writable: ${directory}" >&2
    exit 73
  fi
done

# Administrators can mount a deployment-owned settings.xml read-only. It may
# define internal mirrors and policies, but must not contain reusable secrets:
# task code and the Agent intentionally share this execution identity.
if [ -f /etc/mae-flow/maven/settings.xml ]; then
  mkdir -p "${MAVEN_CONFIG}"
  ln -sfn /etc/mae-flow/maven/settings.xml "${MAVEN_CONFIG}/settings.xml"
fi

# A public CA certificate is not a credential. Configure the ephemeral task
# user's Git/npm clients to extend trust; verification remains enabled. Java's
# trust store is mounted separately at the JDK default cacerts path (README).
if [ -f /etc/mae-flow/ca/company-ca.pem ]; then
  git config --global http.sslCAInfo /etc/mae-flow/ca/company-ca.pem
  npm config set --location=user cafile /etc/mae-flow/ca/company-ca.pem
fi

exec "$@"
