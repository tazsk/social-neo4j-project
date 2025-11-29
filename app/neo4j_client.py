from __future__ import annotations
import os
from typing import Iterable, List, Dict, Any, Optional
from neo4j import GraphDatabase, basic_auth
from dotenv import load_dotenv

load_dotenv()

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "neo4j")
DB_DATABASE = os.getenv("DB_DATABASE", "neo4j")

class Neo4jClient:
    """
    Thin wrapper around the official neo4j Driver.
    """
    def __init__(self, uri: str = NEO4J_URI, user: str = NEO4J_USER, password: str = NEO4J_PASSWORD, database: str = DB_DATABASE) -> None:
        self.driver = GraphDatabase.driver(uri, auth=basic_auth(user, password))
        self.database = database

    def close(self) -> None:
        self.driver.close()

    def read(self, cypher: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        with self.driver.session(database=self.database) as session:
            result = session.execute_read(lambda tx: list(tx.run(cypher, **(params or {}))))
        return [r.data() for r in result]

    def write(self, cypher: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        with self.driver.session(database=self.database) as session:
            result = session.execute_write(lambda tx: list(tx.run(cypher, **(params or {}))))
        return [r.data() for r in result]

    def write_many(self, cypher: str, rows: Iterable[Dict[str, Any]], batch_size: int = 1000) -> int:
        """
        Execute UNWIND-based batched writes. Returns total rows processed.
        """
        rows = list(rows)
        total = 0
        with self.driver.session(database=self.database) as session:
            for i in range(0, len(rows), batch_size):
                chunk = rows[i:i+batch_size]
                def _run(tx):
                    tx.run(cypher, rows=chunk).consume()
                session.execute_write(_run)
                total += len(chunk)
        return total
