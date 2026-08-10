#!/usr/bin/env bash
# Probe a single NUS aircon meter via the EVS ORE read endpoints (guest auth).
set -u
ID="${1:-10013842}"
MC="https://ore.evs.com.sg/evs1/get_credit_bal"
MB="https://ore.evs.com.sg/tcm/get_credit_balance"
MI="https://ore.evs.com.sg/cp/get_meter_info"

claim() { # $1=endpoint $2=target
  cat <<EOF
{"svcClaimDto":{"username":"$ID","user_id":0,"svcName":"oresvc","endpoint":"$1","scope":"self","target":"$2","operation":"read"},"request":{"meter_displayname":"$ID"}}
EOF
}

probe() { # $1=label $2=url $3=target
  echo "═══ $1  ($2)"
  curl -s -m 20 -X POST "$2" \
    -H "Content-Type: application/json; charset=UTF-8" \
    -H "Authorization: Bearer guest" \
    -d "$(claim "$2" "$3")" -w "\n[HTTP %{http_code} %{time_total}s]\n"
  echo
}

probe "meter credit (get_credit_bal)"     "$MC" "meter_p_credit_balance"
probe "money balance (get_credit_balance)" "$MB" "meter_p_credit_balance"
probe "meter info (get_meter_info)"        "$MI" "meter_p_info"
