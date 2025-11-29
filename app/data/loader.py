from __future__ import annotations
import argparse, os, gzip, random
from typing import Dict, Any, Iterable, List, Tuple, Set
from app.neo4j_client import Neo4jClient
from app.utils.hashing import hash_password

SCHEMA_QUERIES = [
    # uniqueness
    """
    CREATE CONSTRAINT user_username_unique IF NOT EXISTS
    FOR (u:User) REQUIRE u.username IS UNIQUE
    """,
    """
    CREATE CONSTRAINT user_email_unique IF NOT EXISTS
    FOR (u:User) REQUIRE u.email IS UNIQUE
    """,
    # useful index
    """
    CREATE FULLTEXT INDEX user_fulltext IF NOT EXISTS
    FOR (u:User) ON EACH [u.username, u.name, u.email]
    """
]

def ensure_schema(client: Neo4jClient) -> None:
    for q in SCHEMA_QUERIES:
        client.write(q)

def seed_four_users(client: Neo4jClient) -> None:
    users = [
        ("alice", "Alice Smith", "alice@example.com", "password123", "Hi, I'm Alice."),
        ("bob", "Bob Lee", "bob@example.com", "password123", "Coffee + graphs."),
        ("carol", "Carol King", "carol@example.com", "password123", "I like hiking."),
        ("dave", "Dave Patel", "dave@example.com", "password123", "Neo4j enjoyer.")
    ]
    rows = []
    for u, n, e, p, b in users:
        h, s = hash_password(p)
        rows.append({"username": u, "name": n, "email": e, "bio": b, "pw": h, "salt": s})
    cypher = """
    UNWIND $rows AS row
    MERGE (u:User {username: row.username})
    ON CREATE SET u.name = row.name, u.email = row.email, u.bio = row.bio,
                  u.passwordHash = row.pw, u.salt = row.salt,
                  u.createdAt = datetime(), u.updatedAt = datetime()
    """
    client.write_many(cypher, rows, batch_size=50)
    # small starter graph
    client.write("""
        MATCH (a:User {username:'alice'}), (b:User {username:'bob'}),
              (c:User {username:'carol'}), (d:User {username:'dave'})
        MERGE (a)-[:FOLLOWS]->(b)
        MERGE (a)-[:FOLLOWS]->(c)
        MERGE (b)-[:FOLLOWS]->(c)
        MERGE (c)-[:FOLLOWS]->(d)
        MERGE (d)-[:FOLLOWS]->(a)
    """)

def _open_maybe_gz(path: str):
    return gzip.open(path, "rt", encoding="utf-8") if path.endswith(".gz") else open(path, "r", encoding="utf-8")

def import_pokec_subset(client: Neo4jClient, relationships_path: str, profiles_path: str, min_nodes: int, min_edges: int, max_nodes: int = 20000) -> Tuple[int, int]:
    """
    Imports a small, connected-ish subset: collects nodes until min_nodes,
    then keeps edges where both endpoints are in the collected set until min_edges.
    """
    ensure_schema(client)

    # Step 1: collect edges and a superset of node ids
    selected_nodes: Set[str] = set()
    edges: List[Tuple[str, str]] = []
    with _open_maybe_gz(relationships_path) as f:
        for line in f:
            if not line.strip() or line.startswith("#"):
                continue
            a, b = line.strip().split()
            if len(selected_nodes) < max_nodes:
                selected_nodes.add(a)
                selected_nodes.add(b)
            # Keep edge only if both endpoints are within picked set
            if a in selected_nodes and b in selected_nodes:
                edges.append((a, b))
            if len(selected_nodes) >= min_nodes and len(edges) >= min_edges:
                break

    # Step 2: build user rows using profiles for optional name/region/age
    profiles: Dict[str, Dict[str, Any]] = {}
    if os.path.exists(profiles_path):
        with _open_maybe_gz(profiles_path) as pf:
            header = None
            for line in pf:
                if not line.strip(): continue
                if header is None:
                    header = line.strip().split("\t")
                    continue
                parts = line.rstrip("\n").split("\t")
                if not parts or len(parts) < 2: continue
                uid = parts[0]
                d = {header[i]: (parts[i] if i < len(parts) else "") for i in range(len(header))}
                profiles[uid] = d

    user_rows = []
    for uid in selected_nodes:
        p = profiles.get(uid, {})
        name = p.get("region", "") or f"User {uid}"
        user_rows.append({
            "username": f"u{uid}",
            "name": name if isinstance(name, str) else f"User {uid}",
            "email": f"u{uid}@pokec.sk",
            "bio": f"Pokec user {uid}",
        })

    # Step 3: write users
    user_cypher = """
    UNWIND $rows AS row
    MERGE (u:User {username: row.username})
    ON CREATE SET u.name = row.name, u.email = row.email, u.bio = row.bio,
                  u.createdAt = datetime(), u.updatedAt = datetime()
    """
    client.write_many(user_cypher, user_rows, batch_size=2000)

    # Step 4: write edges (directed)
    edge_rows = [{"src": f"u{a}", "dst": f"u{b}"} for a, b in edges]
    edge_cypher = """
    UNWIND $rows AS row
    MATCH (a:User {username: row.src}), (b:User {username: row.dst})
    MERGE (a)-[:FOLLOWS]->(b)
    """
    client.write_many(edge_cypher, edge_rows, batch_size=5000)

    return len(selected_nodes), len(edges)

def import_synthetic(client: Neo4jClient, users: int = 1500, avg_degree: int = 6) -> Tuple[int, int]:
    ensure_schema(client)
    # users
    user_rows = []
    for i in range(users):
        uid = f"s{i+1}"
        user_rows.append({
            "username": uid,
            "name": f"Synthetic User {i+1}",
            "email": f"{uid}@example.com",
            "bio": "Synthetic account (demo)"
        })
    user_cypher = """
    UNWIND $rows AS row
    MERGE (u:User {username: row.username})
    ON CREATE SET u.name = row.name, u.email = row.email, u.bio = row.bio,
                  u.createdAt = datetime(), u.updatedAt = datetime()
    """
    client.write_many(user_cypher, user_rows, batch_size=5000)

    # edges
    edges = set()
    rnd = random.Random(42)
    for i in range(users):
        src = f"s{i+1}"
        # each user follows ~avg_degree distinct others
        targets = set()
        while len(targets) < avg_degree:
            j = rnd.randint(1, users)
            if j == (i+1): continue
            targets.add(f"s{j}")
        for dst in targets:
            edges.add((src, dst))
    edge_rows = [{"src": a, "dst": b} for a, b in edges]
    edge_cypher = """
    UNWIND $rows AS row
    MATCH (a:User {username: row.src}), (b:User {username: row.dst})
    MERGE (a)-[:FOLLOWS]->(b)
    """
    client.write_many(edge_cypher, edge_rows, batch_size=10000)
    return users, len(edges)

def main():
    parser = argparse.ArgumentParser(description="Neo4j schema + data loader")
    parser.add_argument("--mode", choices=["pokec", "synthetic", "seed"], required=True)
    parser.add_argument("--relationships", help="Path to soc-pokec-relationships.txt(.gz)")
    parser.add_argument("--profiles", help="Path to soc-pokec-profiles.txt(.gz)")
    parser.add_argument("--min_nodes", type=int, default=1500)
    parser.add_argument("--min_edges", type=int, default=6000)
    parser.add_argument("--users", type=int, default=1500)
    parser.add_argument("--avg_degree", type=int, default=6)
    args = parser.parse_args()

    client = Neo4jClient()
    if args.mode == "seed":
        ensure_schema(client)
        seed_four_users(client)
        print("Seeded 4 test users (alice, bob, carol, dave) with password 'password123'.")
    elif args.mode == "pokec":
        if not args.relationships or not args.profiles:
            raise SystemExit("Please provide --relationships and --profiles paths for Pokec import.")
        n, m = import_pokec_subset(client, args.relationships, args.profiles, args.min_nodes, args.min_edges)
        print(f"Imported Pokec subset: {n} users, {m} FOLLOWS edges.")
    else:
        n, m = import_synthetic(client, args.users, args.avg_degree)
        print(f"Imported synthetic graph: {n} users, {m} FOLLOWS edges.")

if __name__ == "__main__":
    main()
