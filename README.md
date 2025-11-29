# Social Graph Console App (Python + Neo4j)

A minimal console-based social networking application that uses **Neo4j** for the backend and **Python** for the front end. It implements 11 required use cases (UC-1 … UC-11) and includes a dataset loader for the public **SNAP Pokec** dataset, plus an optional synthetic data generator.

> **Quick start**
>
> 1) Install Neo4j 5.x (or AuraDB Free) and start it.
> 2) Create a DB user and note `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`.
> 3) `python -m venv .venv && source .venv/bin/activate` (Windows: `.venv\Scripts\activate`)
> 4) `pip install -r requirements.txt`
> 5) Copy `.env.example` to `.env` and fill in your settings.
> 6) (Optional, recommended) Load data:
>    - **Pokec** (≥1,000 nodes & ≥5,000 relationships subset):
>      ```bash
>      python -m app.data.loader --mode pokec --relationships /path/to/soc-pokec-relationships.txt --profiles /path/to/soc-pokec-profiles.txt --min_nodes 1500 --min_edges 6000
>      ```
>    - **Or synthetic** demo data:
>      ```bash
>      python -m app.data.loader --mode synthetic --users 1500 --avg_degree 6
>      ```
> 7) Seed four test users:
>    ```bash
>    python -m app.data.loader --mode seed
>    ```
> 8) Run the console UI:
>    ```bash
>    python -m app.main
>    ```
>
> All 11 use cases can be exercised from the console.

## Dataset
Default public dataset: **SNAP: Pokec social network** (directed friendships, 1.63M users, 30.6M edges). We import a **subset** to satisfy the course minimum.
- Dataset page: https://snap.stanford.edu/data/soc-Pokec.html
- Files you’ll need to download locally then point the loader to them:
  - `soc-pokec-relationships.txt(.gz)`
  - `soc-pokec-profiles.txt(.gz)`

If you don’t want to download the dataset, use the synthetic generator which creates ≥1,000 nodes and ≥5,000 FOLLOWS edges.

## Project structure

```
social-neo4j-app/
├─ app/
│  ├─ main.py                 # Console UI (UC-1..UC-11)
│  ├─ neo4j_client.py         # Thin Neo4j wrapper
│  ├─ services/
│  │  ├─ auth_service.py      # UC-1..UC-2
│  │  ├─ user_service.py      # UC-3..UC-4
│  │  ├─ graph_service.py     # UC-5..UC-9
│  │  └─ search_service.py    # UC-10..UC-11
│  ├─ utils/
│  │  ├─ hashing.py           # Password hashing (bcrypt if available; salted SHA256 fallback)
│  │  └─ validators.py        # Simple input validation helpers
│  └─ data/
│     └─ loader.py            # Schema creation + import (Pokec or synthetic) + seeding
├─ report/
│  └─ report_template.md      # Fill this then export to PDF
├─ scripts/
│  └─ reset_db.py             # Drops everything (use with caution)
├─ requirements.txt
├─ .env.example
└─ README.md
```

## Running tests quickly
You can simply run the synthetic loader + console UI and exercise all menus. For the final submission, capture console screenshots and paste the Cypher shown in this README/`report_template.md` under the appropriate UC label.
