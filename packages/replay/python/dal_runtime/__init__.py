"""Deterministic runtime helpers for Python agents."""

from __future__ import annotations

import atexit
import datetime as _dt
import json as _json
import os as _os
import random as _random
import threading as _threading
import time as _time
from pathlib import Path as _Path
from typing import Any as _Any
from typing import Dict as _Dict
from typing import List as _List
from typing import Optional as _Optional

__all__ = ["install"]

_INSTALL_FLAG = object()
_LOCK = _threading.RLock()
_BASE_DT: _dt.datetime | None = None
_BASE_SECONDS = 0.0
_MONOTONIC_BASE = 0.0
_VIRTUAL_OFFSET = 0.0
_RECORDED_TICKS: _Optional[_List[_Dict[str, _Any]]] = None
_EMITTED_TICKS: _List[_Dict[str, _Any]] = []
_TICK_INDEX = 0
_CLOCK_FILE: _Path | None = None
_MODE: str = "record"
_INITIAL_TIME_ISO: str = ""


def install() -> None:
    """Install deterministic clock and RNG patches if enabled."""

    global _INSTALL_FLAG

    with _LOCK:
        if getattr(_time, "__dal_installed__", None) is _INSTALL_FLAG:
            return

        if not _is_deterministic_enabled():
            return

        _time.__dal_installed__ = _INSTALL_FLAG  # type: ignore[attr-defined]

        _initialise_clock_state()
        _seed_random()
        _patch_time_functions()
        _register_persist()


def _is_deterministic_enabled() -> bool:
    flag = _os.environ.get("AGENT_DETERMINISTIC")
    if not flag:
        return False
    return flag == "1" or flag.lower() == "true"


def _initialise_clock_state() -> None:
    global _BASE_DT, _BASE_SECONDS, _MONOTONIC_BASE, _CLOCK_FILE, _RECORDED_TICKS, _VIRTUAL_OFFSET, _TICK_INDEX, _MODE, _INITIAL_TIME_ISO

    start_iso = _os.environ.get("AGENT_START_TIME")
    base_dt = _parse_iso_timestamp(start_iso)
    _INITIAL_TIME_ISO = base_dt.isoformat().replace("+00:00", "Z")
    _BASE_DT = base_dt
    _BASE_SECONDS = base_dt.timestamp()
    _MONOTONIC_BASE = 0.0
    _VIRTUAL_OFFSET = 0.0
    _TICK_INDEX = 0
    _RECORDED_TICKS = None

    _MODE = _normalise_mode(_os.environ.get("AGENT_EXECUTION_MODE"))
    clock_env = _os.environ.get("AGENT_CLOCK_FILE")
    _CLOCK_FILE = _Path(clock_env) if clock_env else _Path.cwd() / ".agent" / "clock.json"

    if _MODE == "replay" and _CLOCK_FILE.exists():
        try:
            data = _json.loads(_CLOCK_FILE.read_text(encoding="utf-8"))
            sources = data.get("sources", {}) if isinstance(data, dict) else {}
            node = sources.get("python") if isinstance(sources, dict) else None
            ticks = node.get("ticks") if isinstance(node, dict) else None
            if isinstance(ticks, list):
                _RECORDED_TICKS = [tick for tick in ticks if _validate_tick(tick)]
        except Exception as exc:  # noqa: BLE001
            _write_stderr(f"[dal-runtime-python] failed to load clock: {exc}\n")



def _seed_random() -> None:
    seed_value = _os.environ.get("AGENT_SEED")
    if not seed_value:
        return

    try:
        seed_int = int(seed_value)
    except ValueError:
        return

    _random.seed(seed_int)



def _patch_time_functions() -> None:
    # Preserve originals for potential debugging.
    original_sleep = _time.sleep
    original_time = _time.time
    original_monotonic = _time.monotonic

    def deterministic_time() -> float:
        with _LOCK:
            return _BASE_SECONDS + _VIRTUAL_OFFSET

    def deterministic_monotonic() -> float:
        with _LOCK:
            return _MONOTONIC_BASE + _VIRTUAL_OFFSET

    def deterministic_sleep(seconds: float) -> None:
        _advance(seconds if seconds else 0.0)

    def deterministic_datetime_now(tz: _Optional[_dt.tzinfo] = None) -> _dt.datetime:
        base = _BASE_DT or _dt.datetime.now(_dt.timezone.utc)
        with _LOCK:
            result = base + _dt.timedelta(seconds=_VIRTUAL_OFFSET)
        return result if tz is None else result.astimezone(tz)

    def deterministic_datetime_utcnow() -> _dt.datetime:
        base = _BASE_DT or _dt.datetime.now(_dt.timezone.utc)
        with _LOCK:
            return (base + _dt.timedelta(seconds=_VIRTUAL_OFFSET)).replace(tzinfo=None)

    _time.sleep = deterministic_sleep  # type: ignore[assignment]
    _time.time = deterministic_time  # type: ignore[assignment]
    _time.monotonic = deterministic_monotonic  # type: ignore[assignment]

    _dt.datetime.now = staticmethod(deterministic_datetime_now)  # type: ignore[assignment]
    _dt.datetime.utcnow = staticmethod(deterministic_datetime_utcnow)  # type: ignore[assignment]

    def restore_originals() -> None:
        _time.sleep = original_sleep  # type: ignore[assignment]
        _time.time = original_time  # type: ignore[assignment]
        _time.monotonic = original_monotonic  # type: ignore[assignment]

    atexit.register(restore_originals)


def _advance(seconds: float) -> None:
    global _VIRTUAL_OFFSET, _TICK_INDEX

    seconds = float(seconds)
    if seconds < 0:
        seconds = 0.0

    with _LOCK:
        if _RECORDED_TICKS is not None:
            if _TICK_INDEX >= len(_RECORDED_TICKS):
                raise RuntimeError(
                    "[dal-runtime-python] replay exceeded recorded clock ticks; diverging schedule detected"
                )
            expected = _RECORDED_TICKS[_TICK_INDEX]
            _TICK_INDEX += 1
            at_ms = float(expected.get("at", _VIRTUAL_OFFSET * 1000.0))
            _VIRTUAL_OFFSET = at_ms / 1000.0
        else:
            _VIRTUAL_OFFSET += seconds
            at_ms = _VIRTUAL_OFFSET * 1000.0

        tick = {
            "sequence": len(_EMITTED_TICKS),
            "op": "sleep",
            "seconds": seconds,
            "at": at_ms
        }
        _EMITTED_TICKS.append(tick)



def _register_persist() -> None:
    atexit.register(_persist_clock)


def _persist_clock() -> None:
    if _CLOCK_FILE is None:
        return

    payload: _Dict[str, _Any] = {
        "version": 1,
        "initialTime": _INITIAL_TIME_ISO,
        "sources": {}
    }

    existing: _Dict[str, _Any] | None = None
    try:
        if _CLOCK_FILE.exists():
            existing_raw = _CLOCK_FILE.read_text(encoding="utf-8")
            existing = _json.loads(existing_raw) if existing_raw else {}
    except Exception as exc:  # noqa: BLE001
        _write_stderr(f"[dal-runtime-python] could not read existing clock: {exc}\n")
        existing = None

    if isinstance(existing, dict):
        payload.update({k: v for k, v in existing.items() if k in {"version", "initialTime", "sources"}})
        sources = payload.setdefault("sources", {})
        if not isinstance(sources, dict):
            sources = {}
            payload["sources"] = sources
    else:
        sources = payload["sources"]

    if not payload.get("initialTime"):
        payload["initialTime"] = _INITIAL_TIME_ISO

    sources["python"] = {
        "ticks": list(_EMITTED_TICKS),
        "recordedAt": _dt.datetime.utcnow().replace(tzinfo=_dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "mode": _MODE
    }

    try:
        _CLOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
        _CLOCK_FILE.write_text(_json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        _write_stderr(f"[dal-runtime-python] failed to persist clock: {exc}\n")



def _parse_iso_timestamp(value: _Optional[str]) -> _dt.datetime:
    if not value:
        return _dt.datetime.now(_dt.timezone.utc)

    iso_value = value.strip()
    if iso_value.endswith("Z"):
        iso_value = iso_value[:-1] + "+00:00"

    try:
        parsed = _dt.datetime.fromisoformat(iso_value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_dt.timezone.utc)
        return parsed.astimezone(_dt.timezone.utc)
    except ValueError:
        return _dt.datetime.now(_dt.timezone.utc)



def _normalise_mode(value: _Optional[str]) -> str:
    if value and value.lower() == "replay":
        return "replay"
    return "record"



def _validate_tick(tick: _Any) -> bool:
    return (
        isinstance(tick, dict)
        and tick.get("op") == "sleep"
        and isinstance(tick.get("at"), (int, float))
    )



def _write_stderr(message: str) -> None:
    try:
        _os.write(2, message.encode("utf-8", errors="replace"))
    except OSError:
        pass


install()
