#!/bin/sh
set -eu
ulimit -n 1024
mkdir -p /var/lib/ldap-fixture
if [ ! -f /var/lib/ldap-fixture/data.mdb ]; then
  slapadd -f /fixtures/slapd.conf -l /fixtures/seed.ldif
fi
exec slapd -f /fixtures/slapd.conf -h 'ldaps://0.0.0.0:1636/' -d 0
