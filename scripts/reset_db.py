from app.neo4j_client import Neo4jClient

if __name__ == "__main__":
    client = Neo4jClient()
    client.write("MATCH (n) DETACH DELETE n")
    client.close()
    print("Deleted all nodes and relationships.")
