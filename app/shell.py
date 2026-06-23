"""Thin wrapper around subprocess for system commands, with sudo support."""
import subprocess
from dataclasses import dataclass

@dataclass
class CmdResult:
    rc: int
    stdout: str
    stderr: str
    @property
    def ok(self) -> bool: return self.rc == 0

def run(argv: list[str], input_text: str | None = None, timeout: int = 30) -> CmdResult:
    proc = subprocess.run(
        argv, input=input_text, capture_output=True, text=True, timeout=timeout,
    )
    return CmdResult(proc.returncode, proc.stdout, proc.stderr)

def sudo(argv: list[str], input_text: str | None = None, timeout: int = 30) -> CmdResult:
    return run(["sudo", "-n", *argv], input_text=input_text, timeout=timeout)
