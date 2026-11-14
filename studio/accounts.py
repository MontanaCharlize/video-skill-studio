"""Local accounts and browser sessions for the studio."""
from contextlib import closing, contextmanager
from hashlib import sha256, scrypt
from hmac import compare_digest
import secrets
import sqlite3
from time import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import Field

from .core import DATA, StrictModel

router = APIRouter(prefix="/api/account")
COOKIE = "pianyu_session"
SESSION_TTL = 30 * 24 * 60 * 60


class Credentials(StrictModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_\-]+$")
    password: str = Field(min_length=8, max_length=128)


@contextmanager
def database():
    DATA.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DATA / "accounts.sqlite3")) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY, salt BLOB NOT NULL, verifier BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL
            );
        """)
        yield db


def verifier(password, salt):
    return scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64*1024*1024)


def token_hash(token):
    return sha256(token.encode()).hexdigest()


def sign_in(db, request, response, username):
    token = secrets.token_urlsafe(32)
    now = int(time())
    old_token = request.cookies.get(COOKIE)
    if old_token:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(old_token),))
    db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
    db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token_hash(token), username, now + SESSION_TTL))
    response.set_cookie(COOKIE, token, max_age=SESSION_TTL, httponly=True,
                        samesite="strict", secure=request.url.scheme == "https")
    return {"username": username}


@router.get("/me")
def account_status(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        return {"username": None}
    with database() as db:
        row = db.execute("SELECT username FROM sessions WHERE token_hash = ? AND expires > ?",
                         (token_hash(token), int(time()))).fetchone()
    return {"username": row[0] if row else None}


@router.post("/register", status_code=201)
def register(body: Credentials, request: Request, response: Response):
    username = body.username.lower()
    salt = secrets.token_bytes(16)
    password_hash = verifier(body.password, salt)
    with database() as db:
        try:
            db.execute("INSERT INTO users VALUES (?, ?, ?)", (username, salt, password_hash))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "该账号名已被使用。") from exc
        return sign_in(db, request, response, username)


@router.post("/login")
def login(body: Credentials, request: Request, response: Response):
    username = body.username.lower()
    with database() as db:
        row = db.execute("SELECT salt, verifier FROM users WHERE username = ?", (username,)).fetchone()
        salt, expected = row or (bytes(16), bytes(64))
        if not compare_digest(verifier(body.password, salt), expected) or row is None:
            raise HTTPException(401, "账号名或密码不正确。")
        return sign_in(db, request, response, username)


@router.post("/logout")
def logout(_: StrictModel, request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with database() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
    response.delete_cookie(COOKIE)
    return {"username": None}
