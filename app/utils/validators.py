from __future__ import annotations
import re

def is_valid_username(u: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_]{3,32}", u))

def is_valid_email(e: str) -> bool:
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", e))

def is_nonempty(s: str) -> bool:
    return bool(s and s.strip())

def is_strong_password(p: str) -> bool:
    """
    At least 8 chars, must contain a letter and a digit.
    """
    if len(p) < 8:
        return False
    if not re.search(r"[A-Za-z]", p):
        return False
    if not re.search(r"\d", p):
        return False
    return True