from __future__ import annotations
import os, hashlib
from typing import Tuple

try:
    import bcrypt
    _HAS_BCRYPT = True
except Exception:
    _HAS_BCRYPT = False

def _random_bytes(n: int = 16) -> bytes:
    return os.urandom(n)

def hash_password(password: str) -> Tuple[str, str]:
    """
    Returns (hash, salt). Uses bcrypt if available; otherwise salted SHA-256.
    """
    if _HAS_BCRYPT:
        salt = bcrypt.gensalt()
        hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
        return hashed.decode("utf-8"), salt.decode("utf-8")
    else:
        salt = _random_bytes(16).hex()
        h = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
        return h, salt

def verify_password(password: str, stored_hash: str, salt: str) -> bool:
    if _HAS_BCRYPT:
        try:
            return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
        except Exception:
            return False
    else:
        h = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
        return h == stored_hash
