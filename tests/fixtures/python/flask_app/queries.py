import sqlite3

import yaml

LIST_ORDERS = "SELECT id, user_id FROM orders WHERE user_id = ?"
PRUNE = "DELETE FROM orders WHERE created < ?"


def find_user(conn, name):
    cur = conn.cursor()
    cur.execute(f"SELECT * FROM users WHERE name = '{name}'")
    return cur.fetchall()


def safe_find(conn, user_id):
    return conn.execute(LIST_ORDERS, (user_id,)).fetchall()


def load_config(text):
    return yaml.load(text)


def load_config_safe(text):
    return yaml.load(text, Loader=yaml.SafeLoader)
