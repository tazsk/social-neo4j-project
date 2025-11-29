from __future__ import annotations
from typing import Dict, Any, Optional, List
from app.neo4j_client import Neo4jClient

def get_profile(client: Neo4jClient, username: str) -> Optional[Dict[str, Any]]:
    recs = client.read("""
        MATCH (u:User {username: $username})
        RETURN u { .username, .name, .email, .bio, createdAt: toString(u.createdAt), updatedAt: toString(u.updatedAt) } AS user
    """, {"username": username})
    return recs[0]["user"] if recs else None

def update_profile(client: Neo4jClient, username: str, name: Optional[str] = None, bio: Optional[str] = None, email: Optional[str] = None) -> Optional[Dict[str, Any]]:
    recs = client.write("""
        MATCH (u:User {username: $username})
        SET u.name = coalesce($name, u.name),
            u.bio = coalesce($bio, u.bio),
            u.email = coalesce($email, u.email),
            u.updatedAt = datetime()
        RETURN u { .username, .name, .email, .bio, updatedAt: toString(u.updatedAt) } AS user
    """, {"username": username, "name": name, "bio": bio, "email": email})
    return recs[0]["user"] if recs else None
