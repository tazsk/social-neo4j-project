from __future__ import annotations
import sys
from getpass import getpass
from app.neo4j_client import Neo4jClient
from app.services import auth_service, user_service, graph_service, search_service
from app.utils.validators import is_valid_username, is_valid_email

def pause():
    input("\n[Enter] to continue...")

def print_header(title: str):
    print("="*60)
    print(title)
    print("="*60)

def show_profile(client: Neo4jClient, username: str):
    print_header("UC-3 View Profile")
    prof = user_service.get_profile(client, username)
    if not prof:
        print("Profile not found.")
        return
    for k, v in prof.items():
        print(f"{k}: {v}")

def edit_profile(client: Neo4jClient, username: str):
    print_header("UC-4 Edit Profile")
    name = input("New name (leave blank to keep): ").strip() or None
    email = input("New email (leave blank to keep): ").strip() or None
    bio = input("New bio (leave blank to keep): ").strip() or None
    try:
        updated = user_service.update_profile(client, username, name=name, bio=bio, email=email)
        print("Updated:", updated)
    except Exception as e:
        print("Update failed:", e)

def login_menu(client: Neo4jClient):
    while True:
        print_header("Welcome to Social Graph (Python + Neo4j)")
        print("1) UC-1 Register")
        print("2) UC-2 Login")
        print("0) Exit")
        choice = input("Choose: ").strip()
        if choice == "1":
            print_header("UC-1 User Registration")
            username = input("Username (3-32 letters/digits/_): ").strip()
            if not is_valid_username(username):
                print("Invalid username format."); pause(); continue
            name = input("Name: ").strip()
            email = input("Email: ").strip()
            if not is_valid_email(email):
                print("Invalid email."); pause(); continue
            password = getpass("Password: ")
            bio = input("Bio (optional): ").strip()
            try:
                u = auth_service.register_user(client, username, name, email, password, bio)
                print("Registered:", u)
            except Exception as e:
                print("Registration failed:", e)
            pause()
        elif choice == "2":
            print_header("UC-2 User Login")
            username = input("Username: ").strip()
            password = getpass("Password: ")
            prof = auth_service.login_user(client, username, password)
            if prof:
                print(f"Login OK. Welcome, {prof['name']}!")
                pause()
                home_menu(client, username)
            else:
                print("Login failed.")
                pause()
        elif choice == "0":
            print("Bye."); sys.exit(0)
        else:
            print("Invalid choice."); pause()

def home_menu(client: Neo4jClient, me: str):
    while True:
        print_header(f"Home (logged in as {me})")
        print("3) UC-3 View My Profile")
        print("4) UC-4 Edit My Profile")
        print("5) UC-5 Follow a User")
        print("6) UC-6 Unfollow a User")
        print("7) UC-7 View Connections (Following / Followers)")
        print("8) UC-8 Mutual Connections with someone")
        print("9) UC-9 Friend Recommendations")
        print("10) UC-10 Search Users")
        print("11) UC-11 Explore Popular Users")
        print("99) Log out")
        choice = input("Choose: ").strip()
        if choice == "3":
            show_profile(client, me); pause()
        elif choice == "4":
            edit_profile(client, me); pause()
        elif choice == "5":
            print_header("UC-5 Follow Another User")
            who = input("Username to follow: ").strip()
            ok = graph_service.follow_user(client, me, who)
            print("Followed." if ok else "Cannot follow yourself.")
            pause()
        elif choice == "6":
            print_header("UC-6 Unfollow a User")
            who = input("Username to unfollow: ").strip()
            removed = graph_service.unfollow_user(client, me, who)
            print(f"Removed {removed} relationship(s).")
            pause()
        elif choice == "7":
            print_header("UC-7 View Friends/Connections")
            print("\nFollowing:")
            for row in graph_service.list_following(client, me, limit=20):
                print(f" - {row['username']} ({row['name']})")
            print("\nFollowers:")
            for row in graph_service.list_followers(client, me, limit=20):
                print(f" - {row['username']} ({row['name']})")
            pause()
        elif choice == "8":
            print_header("UC-8 Mutual Connections")
            other = input("Other username: ").strip()
            rows = graph_service.mutual_connections(client, me, other, limit=50)
            if not rows:
                print("No mutuals.")
            else:
                for r in rows:
                    print(f" - {r['username']} ({r['name']})")
            pause()
        elif choice == "9":
            print_header("UC-9 Friend Recommendations")
            for r in graph_service.recommend_connections(client, me, limit=15):
                print(f" - {r['username']} ({r['name']}), mutuals={r['mutuals']}, followers={r['followers']}")
            pause()
        elif choice == "10":
            print_header("UC-10 Search Users")
            q = input("Search term: ").strip()
            for r in search_service.search_users(client, q, limit=20):
                if "score" in r:
                    print(f" - {r['username']} ({r['name']}) score={round(r['score'],2)}")
                else:
                    print(f" - {r['username']} ({r['name']})")
            pause()
        elif choice == "11":
            print_header("UC-11 Explore Popular Users")
            for r in search_service.popular_users(client, limit=15):
                print(f" - {r['username']} ({r['name']}), followers={r['followerCount']}")
            pause()
        elif choice == "99":
            break
        else:
            print("Invalid choice."); pause()

if __name__ == "__main__":
    client = Neo4jClient()
    try:
        # Make sure schema exists before first use
        auth_service.create_schema(client)
        login_menu(client)
    finally:
        client.close()
