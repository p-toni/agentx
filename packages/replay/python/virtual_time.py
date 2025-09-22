"""Utilities for reading deterministic virtual time injected by replay."""

from __future__ import annotations

import datetime as _dt
import os as _os
import time as _time

_START_ISO = _os.environ.get("AGENT_START_TIME")
_MONOTONIC_START = _time.monotonic()

if _START_ISO is None:
    _BASE: _dt.datetime | None = None
else:
    try:
        _BASE = _dt.datetime.fromisoformat(_START_ISO.replace("Z", "+00:00"))
    except ValueError:
        _BASE = None


def now() -> _dt.datetime:
    """Return the current virtual time.

    Falls back to real UTC time when no AGENT_START_TIME is defined.
    """

    if _BASE is None:
        return _dt.datetime.now(_dt.timezone.utc)

    elapsed = _time.monotonic() - _MONOTONIC_START
    return _BASE + _dt.timedelta(seconds=elapsed)


__all__ = ["now"]
