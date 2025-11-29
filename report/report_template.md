# Team Report — Social Graph Console App (Python + Neo4j)

**Course / Term:**  
**Team Name:**  
**Members:**  
- Member 1 — Name, Email (Part 1: Foundations & Data)  
- Member 2 — Name, Email (Part 2: User Management)  
- Member 3 — Name, Email (Part 3: Graph Features)  
- Member 4 — Name, Email (Part 4: Search/Explore + Packaging)

---

## Property Graph Schema (5 pts)

**Node labels**
- `:User` — properties: `username` (unique), `email` (unique), `name`, `bio`, `passwordHash` (nullable), `salt` (nullable), `createdAt`, `updatedAt`

**Relationship types**
- `(:User)-[:FOLLOWS]->(:User)` — properties: `since` (datetime, optional)

**Constraints & Indexes**
```cypher
CREATE CONSTRAINT user_username_unique IF NOT EXISTS FOR (u:User) REQUIRE u.username IS UNIQUE;
CREATE CONSTRAINT user_email_unique    IF NOT EXISTS FOR (u:User) REQUIRE u.email IS UNIQUE;
CREATE FULLTEXT INDEX user_fulltext IF NOT EXISTS FOR (u:User) ON EACH [u.username, u.name, u.email];
```

A small “seed” subgraph of 4 demo accounts (alice/bob/carol/dave) is also created for quick manual testing.

---

## Dataset Information (5 pts)

**Dataset name:** SNAP: Pokec social network  
**URL:** https://snap.stanford.edu/data/soc-Pokec.html  
**Brief description:** Pokec is a large online social network in Slovakia with **1,632,803 users** and **30,622,564 directed edges**. SNAP provides anonymized relationships and rich profile attributes (in Slovak). Friendships are oriented (directed).  
**How we used it:** For this project we import a **subset** big enough to meet the requirement (≥1,000 nodes & ≥5,000 edges). We optionally create synthetic data for quick demos.  

**Preprocessing & Loading summary:**
1. Select a subset of user IDs while streaming the `soc-pokec-relationships.txt` file until we collect the target number of users/edges.
2. Read matched rows from `soc-pokec-profiles.txt` for optional name fields; otherwise synthesize `username=u<id>`, `email=u<id>@pokec.sk`, `name` from region or fallback.
3. Batch insert nodes then edges with `UNWIND` using the Neo4j Python driver.
4. Create constraints and a full-text index.

**Cypher used during load:**
```cypher
// Users
UNWIND $rows AS row
MERGE (u:User {username: row.username})
ON CREATE SET u.name = row.name, u.email = row.email, u.bio = row.bio,
              u.createdAt = datetime(), u.updatedAt = datetime();

// Edges
UNWIND $rows AS row
MATCH (a:User {username: row.src}), (b:User {username: row.dst})
MERGE (a)-[:FOLLOWS]->(b);
```

---

## Use Case Evidence (11 × 5 pts = 55 pts)

For each UC, include a **console screenshot** and the **Cypher**. Below are the exact Cypher queries our app runs.

### UC‑1: User Registration
**Description:** Create a `:User` with hashed password.  
**Cypher:**
```cypher
CREATE (u:User {
  username: $username, name: $name, email: $email, bio: $bio,
  passwordHash: $pw_hash, salt: $salt, createdAt: datetime(), updatedAt: datetime()
})
RETURN u { .* } AS user;
```

### UC‑2: User Login
**Description:** Verify password and return profile.  
**Cypher:**
```cypher
MATCH (u:User {username: $username})
RETURN u.passwordHash AS passwordHash, u.salt AS salt, u { .username, .name, .email, .bio } AS profile;
```

### UC‑3: View Profile
```cypher
MATCH (u:User {username: $username})
RETURN u { .username, .name, .email, .bio, createdAt: toString(u.createdAt), updatedAt: toString(u.updatedAt) } AS user;
```

### UC‑4: Edit Profile
```cypher
MATCH (u:User {username: $username})
SET u.name = coalesce($name, u.name),
    u.bio = coalesce($bio, u.bio),
    u.email = coalesce($email, u.email),
    u.updatedAt = datetime()
RETURN u { .username, .name, .email, .bio, updatedAt: toString(u.updatedAt) } AS user;
```

### UC‑5: Follow Another User
```cypher
MATCH (a:User {username: $src}), (b:User {username: $dst})
MERGE (a)-[r:FOLLOWS]->(b)
ON CREATE SET r.since = datetime();
```

### UC‑6: Unfollow a User
```cypher
MATCH (a:User {username: $src})-[r:FOLLOWS]->(b:User {username: $dst})
DELETE r
RETURN count(*) AS removed;
```

### UC‑7: View Friends/Connections
**Following:**
```cypher
MATCH (:User {username: $u})-[:FOLLOWS]->(v:User)
RETURN v.username AS username, v.name AS name
ORDER BY v.username
SKIP $skip LIMIT $limit;
```
**Followers:**
```cypher
MATCH (v:User)-[:FOLLOWS]->(:User {username: $u})
RETURN v.username AS username, v.name AS name
ORDER BY v.username
SKIP $skip LIMIT $limit;
```

### UC‑8: Mutual Connections
```cypher
MATCH (a:User {username: $u1}), (b:User {username: $u2})
MATCH (a)-[:FOLLOWS]->(m:User)<-[:FOLLOWS]-(b)
RETURN m.username AS username, m.name AS name
ORDER BY username
LIMIT $limit;
```

### UC‑9: Friend Recommendations (Common Neighbors)
```cypher
MATCH (me:User {username: $u})
MATCH (me)-[:FOLLOWS]->(:User)-[:FOLLOWS]->(rec:User)
WHERE NOT (me)-[:FOLLOWS]->(rec) AND rec <> me
WITH rec, count(*) AS mutuals
OPTIONAL MATCH (rec)<-[:FOLLOWS]-(:User)
WITH rec, mutuals, count(*) AS followers
RETURN rec.username AS username, rec.name AS name, mutuals, followers
ORDER BY mutuals DESC, followers DESC, username ASC
LIMIT $limit;
```

### UC‑10: Search Users (Full‑Text)
```cypher
CALL db.index.fulltext.queryNodes('user_fulltext', $q)
YIELD node, score
RETURN node.username AS username, node.name AS name, score
ORDER BY score DESC
LIMIT $limit;
```

### UC‑11: Explore Popular Users (Most Followed)
```cypher
MATCH (u:User)
OPTIONAL MATCH (u)<-[:FOLLOWS]-(:User)
WITH u, count(*) AS followerCount
RETURN u.username AS username, u.name AS name, followerCount
ORDER BY followerCount DESC, username ASC
LIMIT $limit;
```

---

## Screenshot checklist
Include 11 screenshots (console) labeled **UC‑1** … **UC‑11** and a short caption. Each should show the menu title that our app prints for that UC.

---

## Appendix
- How to run loaders and seed script (see README).
- Any deviations from the dataset or synthetic generation choices.
