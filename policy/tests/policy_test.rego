package gate.tests

import data.config

allow_bundle_when_within_limits if {
  test_input := {
    "context": {
      "stage": "plan",
      "currentMinutes": 570
    },
    "intents": [
      {
        "type": "http.post",
        "index": 0,
        "payload": {
          "amount": 100,
          "labels": []
        },
        "metadata": {}
      }
    ],
    "network": [
      {
        "method": "POST",
        "url": "https://example.com/api",
        "host": "example.com",
        "path": "/api"
      }
    ]
  }
  decision := data.gate.decision with input as test_input
  decision.bundle.allowed
  not decision.bundle.requiresApproval
}

denies_amount_over_cap if {
  test_input := {
    "context": {
      "stage": "plan",
      "currentMinutes": 570
    },
    "intents": [
      {
        "type": "payments.submit",
        "index": 0,
        "payload": {
          "amount": 5000,
          "labels": []
        },
        "metadata": {}
      }
    ],
    "network": []
  }
  decision := data.gate.decision with input as test_input
  not decision.bundle.allowed
}

labeled_intent_requires_approval if {
  test_input := {
    "context": {
      "stage": "plan",
      "currentMinutes": 570
    },
    "intents": [
      {
        "type": "communications.email",
        "index": 0,
        "payload": {
          "labels": ["external_email"]
        },
        "metadata": {}
      }
    ],
    "network": []
  }
  decision := data.gate.decision with input as test_input
  decision.bundle.allowed
  decision.bundle.requiresApproval
}

blocks_unlisted_domain if {
  test_input := {
    "context": {
      "stage": "plan",
      "currentMinutes": 570
    },
    "intents": [],
    "network": [
      {
        "method": "POST",
        "url": "https://malicious.com/api",
        "host": "malicious.com",
        "path": "/api"
      }
    ]
  }
  decision := data.gate.decision with input as test_input
  not decision.bundle.allowed
}
