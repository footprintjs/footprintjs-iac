FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends slapd ldap-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY start-ldap.sh /usr/local/bin/start-ldap
RUN chmod 755 /usr/local/bin/start-ldap
EXPOSE 1636
ENTRYPOINT ["/usr/local/bin/start-ldap"]
