#!/bin/sh
set -eu
network=journey-performance-egress
chain=JOURNEY-PERF
if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create --driver bridge "$network" >/dev/null
fi
subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$network")
if ! iptables -w -nL "$chain" >/dev/null 2>&1; then
  iptables -w -N "$chain"
fi
rule() {
  if ! iptables -w -C "$@" 2>/dev/null; then iptables -w -A "$@"; fi
}
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  rule "$chain" -d "$destination" -j REJECT
done
rule "$chain" -p tcp --dport 443 -j ACCEPT
rule "$chain" -p udp --dport 53 -j ACCEPT
rule "$chain" -p tcp --dport 53 -j ACCEPT
rule "$chain" -j REJECT
if ! iptables -w -C DOCKER-USER -s "$subnet" -j "$chain" 2>/dev/null; then
  iptables -w -I DOCKER-USER 1 -s "$subnet" -j "$chain"
fi
if ! iptables -w -C INPUT -s "$subnet" -j REJECT 2>/dev/null; then
  iptables -w -I INPUT 1 -s "$subnet" -j REJECT
fi
printf 'Performance egress isolation ready\n'
