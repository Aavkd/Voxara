"""Make CUDA/cuDNN DLLs discoverable on Windows before loading faster-whisper.

The pip packages ``nvidia-cublas-cu12`` / ``nvidia-cudnn-cu12`` install their DLLs
under ``site-packages/nvidia/*/bin``, a location Windows does not search by
default. Without this, CTranslate2 fails at runtime with
``Library cublas64_12.dll is not found or cannot be loaded``.

Ported from the (fast, working) "Push to talk" app. Call before importing or
loading faster-whisper.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def ensure_cuda_dll_path() -> list[str]:
    """Register the ``bin`` folders of the nvidia-*-cu12 packages. No-op off Windows."""
    if sys.platform != "win32":
        return []

    added: list[str] = []

    def _register(bin_dir: Path) -> None:
        bin_str = str(bin_dir)
        if not bin_dir.is_dir() or bin_str in added:
            return
        try:
            os.add_dll_directory(bin_str)
        except (OSError, FileNotFoundError):
            return
        if bin_str not in os.environ.get("PATH", ""):
            os.environ["PATH"] = bin_str + os.pathsep + os.environ.get("PATH", "")
        added.append(bin_str)

    for site_dir in _site_packages_dirs():
        nvidia_root = site_dir / "nvidia"
        if not nvidia_root.is_dir():
            continue
        for bin_dir in nvidia_root.glob("*/bin"):
            _register(bin_dir)
    return added


def _site_packages_dirs() -> list[Path]:
    dirs: list[Path] = []
    for entry in sys.path:
        if entry and entry.endswith("site-packages"):
            p = Path(entry)
            if p.is_dir():
                dirs.append(p)
    venv_sp = Path(sys.prefix) / "Lib" / "site-packages"
    if venv_sp.is_dir() and venv_sp not in dirs:
        dirs.append(venv_sp)
    return dirs
