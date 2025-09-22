from packages.replay.python import dal_runtime as _dal_runtime  # type: ignore[attr-defined]

install = _dal_runtime.install
__all__ = getattr(_dal_runtime, "__all__", ("install",))

for _name in __all__:
    globals()[_name] = getattr(_dal_runtime, _name)
