from __future__ import annotations
import re

def is_valid_username(u: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_]{3,32}", u))

def is_valid_email(e: str) -> bool:
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", e))

def is_nonempty(s: str) -> bool:
    return bool(s and s.strip())
