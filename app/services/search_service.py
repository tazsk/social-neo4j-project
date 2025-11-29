from __future__ import annotations
from typing import List, Dict, Any
from app.neo4j_client import Neo4jClient

def search_users(client: Neo4jClient, q: str, limit: int = 25) -> List[Dict[str, Any]]:
    # use fulltext index if available
    try:
        return client.read("""
            CALL db.index.fulltext.queryNodes('user_fulltext', $q)
            YIELD node, score
            RETURN node.username AS username, node.name AS name, score
            ORDER BY score DESC
            LIMIT $limit
        """, {"q": q, "limit": limit})
    except Exception:
        return client.read("""
            MATCH (u:User)
            WHERE toLower(u.username) CONTAINS toLower($q) OR toLower(u.name) CONTAINS toLower($q)
            RETURN u.username AS username, u.name AS name
            ORDER BY username
            LIMIT $limit
        """, {"q": q, "limit": limit})

def popular_users(client: Neo4jClient, limit: int = 10) -> List[Dict[str, Any]]:
    return client.read("""
        MATCH (u:User)
        OPTIONAL MATCH (u)<-[:FOLLOWS]-(:User)
        WITH u, count(*) AS followerCount
        RETURN u.username AS username, u.name AS name, followerCount
        ORDER BY followerCount DESC, username ASC
        LIMIT $limit
    """, {"limit": limit})
