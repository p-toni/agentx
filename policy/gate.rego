package gate

import future.keywords.if

config := data.config

policy_context := object.get(input, "context", {})
intent_list := object.get(input, "intents", [])
network_list := object.get(input, "network", [])

decision := {
  "policyVersion": config.version,
  "bundle": bundle_summary,
  "intents": intent_results,
  "network": network_results
}

intent_results := [intent_decision(i, intent) |
  some i
  intent := intent_list[i]
]

network_results := [network_decision(entry) |
  entry := network_list[_]
]

bundle_summary := {
  "allowed": bundle_allowed,
  "requiresApproval": bundle_requires_approval,
  "reasons": bundle_reasons
}

bundle_allowed := false if {
  bundle_blocked
}

bundle_allowed := true if {
  not bundle_blocked
}

bundle_blocked if {
  intent := intent_results[_]
  intent.allowed == false
}

bundle_blocked if {
  entry := network_results[_]
  entry.allowed == false
}

bundle_requires_approval := true if {
  bundle_requires_approval_any
}

bundle_requires_approval := false if {
  not bundle_requires_approval_any
}

bundle_requires_approval_any if {
  intent := intent_results[_]
  intent.requiresApproval
}

bundle_reasons := reasons if {
  intent_reason_list := [msg |
    intent := intent_results[_]
    msg := intent.reasons[_]
  ]
  network_reason_list := [msg |
    entry := network_results[_]
    msg := entry.reasons[_]
  ]
  combined := array.concat(intent_reason_list, network_reason_list)
  reason_set := {x | x := combined[_]}
  reasons := sort([r | reason_set[r]])
}

intent_decision(index, intent) := {
  "index": index,
  "type": intent_type(intent),
  "allowed": count(block_reasons) == 0,
  "requiresApproval": count(approval_reasons) > 0,
  "reasons": sort(block_reasons),
  "approvalReasons": sort(approval_reasons)
} if {
  block_reasons := intent_block_reasons(intent)
  approval_reasons := intent_approval_reasons(intent)
}

intent_type(intent) := type if {
  type := object.get(intent, "type", "")
  is_string(type)
}

intent_block_reasons(intent) := reasons if {
  reasons := [
    sprintf("intent %s amount %.2f exceeds cap %.2f", [intent_type(intent), amount, max]) |
    max := intent_amount_cap()
    max != null
    amount := intent_amount(intent)
    amount != null
    amount > max
  ]
}

intent_amount_cap() := cap if {
  caps := object.get(config, "caps", {})
  cap := caps.maxAmount
  cap != null
}

intent_amount(intent) := amount if {
  payload := object.get(intent, "payload", {})
  value := object.get(payload, "amount", null)
  is_number(value)
  amount := value
}

intent_approval_reasons(intent) := reasons if {
  label_reasons := [
    sprintf("intent %s label %s requires approval", [intent_type(intent), label]) |
    required := object.get(config, "requireApprovalLabels", [])
    count(required) > 0
    labels := intent_labels(intent)
    label := labels[_]
    some idx
    required[idx] == label
  ]
  time_before := [
    sprintf("intent %s outside allowed time window", [intent_type(intent)]) |
    window := object.get(config, "timeWindow", {})
    start := object.get(window, "startMinutes", null)
    current := object.get(policy_context, "currentMinutes", null)
    start != null
    current != null
    current < start
  ]
  time_after := [
    sprintf("intent %s outside allowed time window", [intent_type(intent)]) |
    window := object.get(config, "timeWindow", {})
    end := object.get(window, "endMinutes", null)
    current := object.get(policy_context, "currentMinutes", null)
    end != null
    current != null
    current > end
  ]
  time_reasons := array.concat(time_before, time_after)
  combined := array.concat(label_reasons, time_reasons)
  reason_set := {x | x := combined[_]}
  reasons := [r | reason_set[r]]
}

intent_labels(intent) := labels if {
  payload := object.get(intent, "payload", {})
  metadata := object.get(intent, "metadata", {})
  payload_labels := string_array(object.get(payload, "labels", []))
  metadata_labels := string_array(object.get(metadata, "labels", []))
  combined := array.concat(payload_labels, metadata_labels)
  label_set := {x | x := combined[_]}
  labels := sort([v |
    v := label_set[_]
  ])
}

string_array(value) := arr if {
  type_name(value) == "array"
  arr := [item |
    item := value[_]
    is_string(item)
  ]
}

string_array(value) := [] if {
  type_name(value) != "array"
}

network_decision(entry) := {
  "url": entry.url,
  "method": upper(object.get(entry, "method", "")),
  "allowed": true,
  "reasons": []
} if {
  network_allowed(entry)
}

network_decision(entry) := {
  "url": entry.url,
  "method": upper(object.get(entry, "method", "")),
  "allowed": false,
  "reasons": [sprintf("network request %s %s not allowed", [upper(object.get(entry, "method", "")), entry.url])]
} if {
  not network_allowed(entry)
}

network_allowed(entry) if {
  rules := object.get(config, "allow", [])
  count(rules) == 0
}

network_allowed(entry) if {
  rules := object.get(config, "allow", [])
  some i
  rule := rules[i]
  rule_allows(rule, entry)
}

rule_allows(rule, entry) if {
  method_allowed(rule, entry)
  domain_allowed(rule, entry)
  path_allowed(rule, entry)
}

method_allowed(rule, entry) if {
  methods := [upper(m) | m := object.get(rule, "methods", [])[_]]
  count(methods) == 0
}

method_allowed(rule, entry) if {
  methods := [upper(m) | m := object.get(rule, "methods", [])[_]]
  count(methods) > 0
  upper(object.get(entry, "method", "")) == methods[_]
}

domain_allowed(rule, entry) if {
  domains := object.get(rule, "domains", [])
  count(domains) == 0
}

domain_allowed(rule, entry) if {
  domains := object.get(rule, "domains", [])
  count(domains) > 0
  entry_host := lower(object.get(entry, "host", ""))
  domain := lower(domains[_])
  domain == entry_host
}

path_allowed(rule, entry) if {
  paths := object.get(rule, "paths", [])
  count(paths) == 0
}

path_allowed(rule, entry) if {
  paths := object.get(rule, "paths", [])
  count(paths) > 0
  actual := object.get(entry, "path", "")
  some j
  pattern := paths[j]
  match_path(pattern, actual)
}

match_path("*", _)

match_path(pattern, actual) if {
  endswith(pattern, "*")
  prefix := trim_suffix(pattern, "*")
  startswith(actual, prefix)
}

match_path(pattern, actual) if {
  not endswith(pattern, "*")
  pattern == actual
}
