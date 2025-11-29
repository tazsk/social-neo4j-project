from __future__ import annotations
from typing import Optional, Dict, Any
from neo4j.exceptions import ConstraintError
from app.neo4j_client import Neo4jClient
from app.utils.hashing import hash_password, verify_password

def create_schema(client: Neo4jClient) -> None:
    # Constraints & indexes
    client.write("""
    CREATE CONSTRAINT user_username_unique IF NOT EXISTS
    FOR (u:User) REQUIRE u.username IS UNIQUE
    """)
    client.write("""
    CREATE CONSTRAINT user_email_unique IF NOT EXISTS
    FOR (u:User) REQUIRE u.email IS UNIQUE
    """)
    client.write("""
    CREATE FULLTEXT INDEX user_fulltext IF NOT EXISTS
    FOR (u:User) ON EACH [u.username, u.name, u.email]
    """)

def register_user(client: Neo4jClient, username: str, name: str, email: str, password: str, bio: str = "") -> Dict[str, Any]:
    pw_hash, salt = hash_password(password)
    try:
        recs = client.write(
            """
            CREATE (u:User {
                username: $username,
                name: $name,
                email: $email,
                bio: $bio,
                passwordHash: $pw_hash,
                salt: $salt,
                createdAt: datetime(),
                updatedAt: datetime()
            })
            RETURN u { .* } AS user
            """,
            {"username": username, "name": name, "email": email, "bio": bio, "pw_hash": pw_hash, "salt": salt}
        )
        return recs[0]["user"]
    except ConstraintError as e:
        raise ValueError("Username or email already exists") from e

def login_user(client: Neo4jClient, username: str, password: str) -> Optional[Dict[str, Any]]:
    recs = client.read(
        """
        MATCH (u:User {username: $username})
        RETURN u.passwordHash AS passwordHash, u.salt AS salt, u { .username, .name, .email, .bio } AS profile
        """,
        {"username": username}
    )
    if not recs:
        return None
    row = recs[0]
    if row["passwordHash"] is None:
        return None
    ok = verify_password(password, row["passwordHash"], row["salt"] or "")
    return row["profile"] if ok else None
