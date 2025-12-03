from __future__ import annotations
from typing import List, Dict, Any

from app.neo4j_client import Neo4jClient
from app.utils.validators import is_valid_username

_MAX_LIMIT = 100

def follow_user(client: Neo4jClient, src_username: str, dst_username: str) -> bool:
    # UC-5: Follow Another User
    if not (is_valid_username(src_username) and is_valid_username(dst_username)):
        return False
    if src_username == dst_username:
        return False
    recs = client.write(
        """
        MATCH (a:User {username: $src}), (b:User {username: $dst})
        MERGE (a)-[r:FOLLOWS]->(b)
        ON CREATE SET r.since = datetime()
        RETURN 1 AS ok
        """,
        {"src": src_username, "dst": dst_username},
    )
    return bool(recs)


def unfollow_user(client: Neo4jClient, src_username: str, dst_username: str) -> int:
    # UC-6: Unfollow a User
    if not (is_valid_username(src_username) and is_valid_username(dst_username)):
        return 0
    recs = client.write(
        """
        MATCH (a:User {username: $src})-[r:FOLLOWS]->(b:User {username: $dst})
        DELETE r
        RETURN count(*) AS removed
        """,
        {"src": src_username, "dst": dst_username},
    )
    return recs[0]["removed"] if recs else 0


def list_following(client: Neo4jClient, username: str, limit: int = 20, skip: int = 0) -> List[Dict[str, Any]]:
    # UC-7: View Friends/Connections (following)
    if not is_valid_username(username):
        return []
    recs = client.read(
        """
        MATCH (:User {username: $u})-[:FOLLOWS]->(v:User)
        RETURN DISTINCT v.username AS username, v.name AS name
        ORDER BY v.username
        SKIP $skip LIMIT $limit
        """,
        {"u": username, "skip": skip, "limit": limit},
    )
    return recs


def list_followers(client: Neo4jClient, username: str, limit: int = 20, skip: int = 0) -> List[Dict[str, Any]]:
    # UC-7: View Friends/Connections (followers)
    if not is_valid_username(username):
        return []
    recs = client.read(
        """
        MATCH (v:User)-[:FOLLOWS]->(:User {username: $u})
        RETURN DISTINCT v.username AS username, v.name AS name
        ORDER BY v.username
        SKIP $skip LIMIT $limit
        """,
        {"u": username, "skip": skip, "limit": limit},
    )
    return recs


def mutual_connections(client: Neo4jClient, u1: str, u2: str, limit: int = 20) -> List[Dict[str, Any]]:
    # UC-8: Mutual Connections
    if not (is_valid_username(u1) and is_valid_username(u2)):
        return []
    if u1 == u2:
        return []
    recs = client.read(
        """
        MATCH (a:User {username: $u1}), (b:User {username: $u2})
        MATCH (a)-[:FOLLOWS]->(m:User)<-[:FOLLOWS]-(b)
        RETURN DISTINCT m.username AS username, m.name AS name
        ORDER BY username
        LIMIT $limit
        """,
        {"u1": u1, "u2": u2, "limit": limit},
    )
    return recs


def recommend_connections(client: Neo4jClient, username: str, limit: int = 10) -> List[Dict[str, Any]]:
    # UC-9: Friend Recommendations
    if not is_valid_username(username):
        return []
    recs = client.read(
        """
        MATCH (me:User {username: $u})
        MATCH (me)-[:FOLLOWS]->(friend:User)-[:FOLLOWS]->(rec:User)
        WHERE NOT (me)-[:FOLLOWS]->(rec) AND rec <> me
        WITH rec, count(DISTINCT friend) AS mutuals
        OPTIONAL MATCH (rec)<-[:FOLLOWS]-(follower:User)
        WITH rec, mutuals, count(DISTINCT follower) AS followers
        RETURN rec.username AS username, rec.name AS name, mutuals, followers
        ORDER BY mutuals DESC, followers DESC, username ASC
        LIMIT $limit
        """,
        {"u": username, "limit": limit},
    )
    return recs
