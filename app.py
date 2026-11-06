import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps
from pathlib import Path

from flask import Flask, current_app, jsonify, render_template, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from backend.database import close_db, get_db, init_db


PROJECT_ROOT = Path(__file__).resolve().parent.parent
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,24}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)+$")
SOCIAL_KEYS = {"instagram", "youtube", "tiktok", "website"}
MAX_AVATAR_BYTES = 350_000
logger = logging.getLogger(__name__)


def _utc_now():
    return datetime.now(timezone.utc)


def _json_error(message, status=400):
    return jsonify(error=message), status


def _body():
    if not request.is_json:
        raise ValueError("Send a JSON request.")
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        raise ValueError("Request body must be a JSON object.")
    return value


def _text(data, key, label, maximum, required=False):
    value = data.get(key, "")
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required.")
    if len(value) > maximum:
        raise ValueError(f"{label} must be no more than {maximum} characters.")
    return value


def _money_to_cents(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("Enter a valid donation amount.")
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise ValueError("Enter a valid donation amount.") from None
    if not amount.is_finite() or amount < Decimal("1.00") or amount > Decimal("10000.00"):
        raise ValueError("Donation amounts must be between $1.00 and $10,000.00.")
    if amount.as_tuple().exponent < -2:
        raise ValueError("Donation amounts can have at most two decimal places.")
    return int(amount * 100)


def _optional_goal_cents(value):
    if value is None or value == "":
        return None
    return _money_to_cents(value)


def _safe_socials(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("Social links must be an object.")
    socials = {}
    for key, raw_url in value.items():
        if key not in SOCIAL_KEYS:
            continue
        if not isinstance(raw_url, str):
            raise ValueError(f"{key} link must be text.")
        url = raw_url.strip()
        if not url:
            continue
        if len(url) > 300 or not re.match(r"^https://[^\s]+$", url, re.IGNORECASE):
            raise ValueError(f"{key} link must be a valid HTTPS URL.")
        socials[key] = url
    return socials


def _public_stall(stall):
    db = get_db()
    totals = db.execute(
        """SELECT COALESCE(SUM(amount_cents), 0) AS raised,
                  COUNT(*) AS donations,
                  COUNT(DISTINCT supporter_name) AS supporters
           FROM transactions
           WHERE stall_id = ? AND status = 'confirmed' AND payment_mode = 'test'""",
        (stall["id"],),
    ).fetchone()
    raised = int(totals["raised"])
    goal = stall["goal_cents"]
    return {
        "slug": stall["slug"],
        "creator_name": stall["creator_name"],
        "username": stall["slug"],
        "bio": stall["bio"],
        "goal_cents": goal,
        "avatar_url": f"/uploads/{stall['avatar_path']}" if stall["avatar_path"] else "",
        "socials": json.loads(stall["socials_json"]),
        "created_at": stall["created_at"],
        "test_raised_cents": raised,
        "test_donations": totals["donations"],
        "test_supporters": totals["supporters"],
        "goal_progress": min(100, round(raised * 100 / goal)) if goal else None,
    }


def _current_user():
    user_id = session.get("user_id")
    if not isinstance(user_id, int):
        return None
    user = get_db().execute(
        "SELECT id, email, username, display_name, role, suspended FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if user is None or user["suspended"]:
        session.clear()
        return None
    return user


def _require_user(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        user = _current_user()
        if user is None:
            return _json_error("Please sign in to continue.", 401)
        return function(user, *args, **kwargs)

    return wrapped


def _require_admin(function):
    @wraps(function)
    def wrapped(user, *args, **kwargs):
        if user["role"] != "admin":
            return _json_error("Administrator access is required.", 403)
        return function(user, *args, **kwargs)

    return _require_user(wrapped)


def _csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return session["csrf_token"]


def _json_user(user):
    if user is None:
        return None
    return {
        "id": user["id"],
        "email": user["email"],
        "username": user["username"],
        "display_name": user["display_name"],
        "role": user["role"],
    }


def create_app(test_config=None):
    app = Flask(
        __name__,
        template_folder=str(PROJECT_ROOT / "templates"),
        static_folder=str(PROJECT_ROOT / "static"),
        static_url_path="/static",
    )
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("DONATEMETUBE_SECRET_KEY") or secrets.token_hex(32),
        DATABASE_PATH=os.environ.get(
            "DONATEMETUBE_DATABASE",
            str(PROJECT_ROOT / "instance" / "donateme.sqlite3"),
        ),
        ENVIRONMENT=os.environ.get("DONATEMETUBE_ENV", "development").lower(),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("DONATEMETUBE_ENV", "").lower() == "production",
        MAX_CONTENT_LENGTH=500_000,
        JSON_SORT_KEYS=False,
    )
    if test_config:
        app.config.update(test_config)
    if app.config["ENVIRONMENT"] == "production" and not os.environ.get(
        "DONATEMETUBE_SECRET_KEY"
    ) and not (test_config and test_config.get("SECRET_KEY")):
        raise RuntimeError("DONATEMETUBE_SECRET_KEY must be configured in production.")

    init_db(app)
    app.teardown_appcontext(close_db)
    app.extensions["request_limits"] = defaultdict(deque)
    app.extensions["request_limits_lock"] = threading.Lock()

    @app.before_request
    def protect_requests():
        if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            supplied = request.headers.get("X-CSRF-Token", "")
            expected = session.get("csrf_token", "")
            if not expected or not hmac.compare_digest(supplied, expected):
                return _json_error("Your session expired. Refresh the page and try again.", 403)

        limits = {
            "/api/register": (6, 60),
            "/api/login": (10, 60),
            "/api/password-reset/request": (4, 3600),
            "/api/password-reset/complete": (6, 3600),
            "/api/donations/start": (12, 60),
            "/api/reports": (5, 3600),
        }
        limit = limits.get(request.path)
        if limit and request.method == "POST":
            maximum, window = limit
            now = _utc_now().timestamp()
            client = request.remote_addr or "unknown"
            bucket_key = (client, request.path)
            with app.extensions["request_limits_lock"]:
                bucket = app.extensions["request_limits"][bucket_key]
                while bucket and bucket[0] <= now - window:
                    bucket.popleft()
                if len(bucket) >= maximum:
                    return _json_error("Too many attempts. Please wait and try again.", 429)
                bucket.append(now)
        return None

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; base-uri 'self'; "
            "form-action 'self'; frame-ancestors 'none'"
        )
        if request.is_secure:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    @app.get("/")
    def home():
        return render_template("index.html")

    @app.get("/uploads/<path:filename>")
    def uploaded_avatar(filename):
        return send_from_directory(Path(app.config["DATABASE_PATH"]).parent / "uploads", filename)

    @app.get("/<path:slug>")
    def app_page(slug):
        if slug.startswith("api/") or slug.startswith("uploads/"):
            return _json_error("Not found.", 404)
        return render_template("index.html")

    @app.get("/api/session")
    def session_info():
        user = _current_user()
        stall = None
        if user:
            stall = get_db().execute("SELECT * FROM stalls WHERE owner_id = ?", (user["id"],)).fetchone()
        return jsonify(user=_json_user(user), stall=_public_stall(stall) if stall else None, csrf_token=_csrf_token())

    @app.post("/api/register")
    def register():
        try:
            data = _body()
            email = _text(data, "email", "Email", 254, required=True).lower()
            username = _text(data, "username", "Username", 24, required=True)
            display_name = _text(data, "display_name", "Name", 60, required=True)
            password = _text(data, "password", "Password", 128, required=True)
            if not EMAIL_RE.fullmatch(email):
                raise ValueError("Enter a valid email address.")
            if not USERNAME_RE.fullmatch(username):
                raise ValueError("Username must be 3–24 letters, numbers, or underscores.")
            if len(password) < 10:
                raise ValueError("Password must contain at least 10 characters.")
        except ValueError as error:
            return _json_error(str(error))

        db = get_db()
        try:
            with db:
                cursor = db.execute(
                    "INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)",
                    (email, username, generate_password_hash(password), display_name),
                )
        except sqlite3.IntegrityError:
            return _json_error("That email or username is already registered.", 409)
        session.clear()
        session["user_id"] = cursor.lastrowid
        return jsonify(user=_json_user(_current_user()), csrf_token=_csrf_token()), 201

    @app.post("/api/login")
    def login():
        try:
            data = _body()
            email = _text(data, "email", "Email", 254, required=True).lower()
            password = _text(data, "password", "Password", 128, required=True)
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if user is None or not check_password_hash(user["password_hash"], password):
            return _json_error("Email or password is incorrect.", 401)
        if user["suspended"]:
            return _json_error("This account is currently suspended.", 403)
        session.clear()
        session["user_id"] = user["id"]
        return jsonify(user=_json_user(_current_user()), csrf_token=_csrf_token())

    @app.post("/api/logout")
    @_require_user
    def logout(_user):
        session.clear()
        return jsonify(ok=True, csrf_token=_csrf_token())

    @app.put("/api/account")
    @_require_user
    def update_account(user):
        try:
            data = _body()
            display_name = _text(data, "display_name", "Name", 60, required=True)
            email = _text(data, "email", "Email", 254, required=True).lower()
            if not EMAIL_RE.fullmatch(email):
                raise ValueError("Enter a valid email address.")
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        try:
            db.execute("UPDATE users SET display_name = ?, email = ? WHERE id = ?", (display_name, email, user["id"]))
        except sqlite3.IntegrityError:
            return _json_error("That email is already in use.", 409)
        return jsonify(user=_json_user(_current_user()))

    @app.post("/api/password-reset/request")
    def request_password_reset():
        try:
            data = _body()
            email = _text(data, "email", "Email", 254, required=True).lower()
            if not EMAIL_RE.fullmatch(email):
                raise ValueError("Enter a valid email address.")
        except ValueError as error:
            return _json_error(str(error))
        user = get_db().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if user:
            token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            expires = (_utc_now() + timedelta(minutes=30)).isoformat()
            db = get_db()
            db.execute("DELETE FROM password_resets WHERE user_id = ?", (user["id"],))
            db.execute(
                "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user["id"], expires),
            )
            if app.config["ENVIRONMENT"] != "production":
                logger.info("Development password reset link: http://127.0.0.1:5000/#reset?token=%s", token)
        return jsonify(message="If that account exists, password reset instructions will be provided.")

    @app.post("/api/password-reset/complete")
    def complete_password_reset():
        try:
            data = _body()
            token = _text(data, "token", "Reset token", 128, required=True)
            password = _text(data, "password", "New password", 128, required=True)
            if len(password) < 10:
                raise ValueError("Password must contain at least 10 characters.")
        except ValueError as error:
            return _json_error(str(error))
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        db = get_db()
        row = db.execute(
            "SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?", (token_hash,)
        ).fetchone()
        if not row or datetime.fromisoformat(row["expires_at"]) <= _utc_now():
            return _json_error("This reset link is invalid or has expired.", 400)
        with db:
            db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(password), row["user_id"]))
            db.execute("DELETE FROM password_resets WHERE user_id = ?", (row["user_id"],))
        return jsonify(message="Password updated. You can now sign in.")

    @app.get("/api/stalls")
    def list_stalls():
        query = request.args.get("q", "").strip()
        if len(query) > 80:
            return _json_error("Search must be no more than 80 characters.")
        db = get_db()
        sql = """SELECT s.* FROM stalls s JOIN users u ON u.id = s.owner_id
                 WHERE u.suspended = 0"""
        parameters = []
        if query:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql += " AND (s.creator_name LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\')"
            parameters.extend((f"%{escaped}%", f"%{escaped}%"))
        sql += """ ORDER BY
                   (SELECT COUNT(*) FROM transactions t WHERE t.stall_id = s.id AND t.status = 'confirmed') DESC,
                   s.created_at DESC LIMIT 36"""
        return jsonify(stalls=[_public_stall(row) for row in db.execute(sql, parameters).fetchall()])

    @app.get("/api/stalls/<slug>")
    def get_stall(slug):
        stall = get_db().execute(
            """SELECT s.* FROM stalls s JOIN users u ON u.id = s.owner_id
               WHERE s.slug = ? AND u.suspended = 0""",
            (slug,),
        ).fetchone()
        if not stall:
            return _json_error("This Stall could not be found.", 404)
        return jsonify(stall=_public_stall(stall))

    @app.post("/api/stalls")
    @_require_user
    def create_stall(user):
        try:
            data = _body()
            creator_name = _text(data, "creator_name", "Creator name", 60, required=True)
            bio = _text(data, "bio", "Description", 500, required=True)
            goal = _optional_goal_cents(data.get("goal"))
            socials = _safe_socials(data.get("socials", {}))
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        try:
            db.execute(
                "INSERT INTO stalls (owner_id, slug, creator_name, bio, goal_cents, socials_json) VALUES (?, ?, ?, ?, ?, ?)",
                (user["id"], user["username"], creator_name, bio, goal, json.dumps(socials)),
            )
        except sqlite3.IntegrityError:
            return _json_error("This account already has a Stall.", 409)
        stall = db.execute("SELECT * FROM stalls WHERE owner_id = ?", (user["id"],)).fetchone()
        return jsonify(stall=_public_stall(stall)), 201

    @app.put("/api/stall")
    @_require_user
    def update_stall(user):
        try:
            data = _body()
            username = _text(data, "username", "Username", 24, required=True)
            if not USERNAME_RE.fullmatch(username):
                raise ValueError("Username must be 3–24 letters, numbers, or underscores.")
            creator_name = _text(data, "creator_name", "Creator name", 60, required=True)
            bio = _text(data, "bio", "Description", 500, required=True)
            goal = _optional_goal_cents(data.get("goal"))
            socials = _safe_socials(data.get("socials", {}))
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        stall = db.execute("SELECT id FROM stalls WHERE owner_id = ?", (user["id"],)).fetchone()
        if not stall:
            return _json_error("Create your Stall before editing it.", 404)
        try:
            with db:
                db.execute("UPDATE users SET username = ? WHERE id = ?", (username, user["id"]))
                db.execute(
                    """UPDATE stalls SET slug = ?, creator_name = ?, bio = ?, goal_cents = ?,
                       socials_json = ? WHERE id = ?""",
                    (username, creator_name, bio, goal, json.dumps(socials), stall["id"]),
                )
        except sqlite3.IntegrityError:
            return _json_error("That username is already in use.", 409)
        return jsonify(stall=_public_stall(db.execute("SELECT * FROM stalls WHERE id = ?", (stall["id"],)).fetchone()))

    @app.post("/api/stall/avatar")
    @_require_user
    def update_avatar(user):
        try:
            data = _body()
            value = data.get("image")
            prefix = "data:image/webp;base64,"
            if not isinstance(value, str) or not value.startswith(prefix):
                raise ValueError("Choose a valid WebP profile picture.")
            raw = base64.b64decode(value[len(prefix):], validate=True)
            if len(raw) > MAX_AVATAR_BYTES or not raw.startswith(b"RIFF") or raw[8:12] != b"WEBP":
                raise ValueError("Profile pictures must be WebP images under 350 KB.")
        except (ValueError, binascii.Error) as error:
            return _json_error(str(error) or "Choose a valid WebP profile picture.")
        db = get_db()
        stall = db.execute("SELECT id FROM stalls WHERE owner_id = ?", (user["id"],)).fetchone()
        if not stall:
            return _json_error("Create your Stall before adding a profile picture.", 404)
        filename = f"{uuid.uuid4().hex}.webp"
        upload_dir = Path(app.config["DATABASE_PATH"]).parent / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        (upload_dir / filename).write_bytes(raw)
        db.execute("UPDATE stalls SET avatar_path = ? WHERE id = ?", (filename, stall["id"]))
        return jsonify(avatar_url=f"/uploads/{filename}")

    @app.post("/api/donations/start")
    def start_donation():
        try:
            data = _body()
            slug = _text(data, "slug", "Stall", 24, required=True)
            amount = _money_to_cents(data.get("amount"))
            supporter_name = _text(data, "supporter_name", "Name", 60, required=True)
            message = _text(data, "message", "Message", 240)
            idempotency_key = _text(data, "idempotency_key", "Donation reference", 36, required=True)
            if not re.fullmatch(r"[a-fA-F0-9-]{36}", idempotency_key):
                raise ValueError("Donation reference is invalid.")
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        stall = db.execute(
            """SELECT s.id FROM stalls s JOIN users u ON u.id = s.owner_id
               WHERE s.slug = ? AND u.suspended = 0""",
            (slug,),
        ).fetchone()
        if not stall:
            return _json_error("This Stall could not be found.", 404)
        public_id = uuid.uuid4().hex
        try:
            db.execute(
                """INSERT INTO transactions
                   (public_id, stall_id, amount_cents, supporter_name, message, idempotency_key)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (public_id, stall["id"], amount, supporter_name, message, idempotency_key),
            )
        except sqlite3.IntegrityError:
            existing = db.execute(
                """SELECT public_id, stall_id, amount_cents, supporter_name, message
                   FROM transactions WHERE idempotency_key = ?""",
                (idempotency_key,),
            ).fetchone()
            if existing and (
                existing["stall_id"] == stall["id"]
                and existing["amount_cents"] == amount
                and existing["supporter_name"] == supporter_name
                and existing["message"] == message
            ):
                return jsonify(transaction_id=existing["public_id"], amount_cents=amount, payment_mode="test")
            return _json_error("This donation reference was already used.", 409)
        return jsonify(transaction_id=public_id, amount_cents=amount, payment_mode="test"), 201

    @app.post("/api/donations/<public_id>/complete")
    def complete_donation(public_id):
        try:
            uuid.UUID(hex=public_id)
            data = _body()
            outcome = _text(data, "outcome", "Test payment result", 12, required=True)
            if outcome not in {"confirm", "decline"}:
                raise ValueError("Choose a valid test payment result.")
        except (ValueError, AttributeError) as error:
            return _json_error(str(error))
        db = get_db()
        with db:
            status = "confirmed" if outcome == "confirm" else "failed"
            confirmed_at = _utc_now().isoformat() if status == "confirmed" else None
            cursor = db.execute(
                """UPDATE transactions SET status = ?, confirmed_at = ?
                   WHERE public_id = ? AND status = 'pending'""",
                (status, confirmed_at, public_id),
            )
            if cursor.rowcount == 0:
                exists = db.execute(
                    "SELECT 1 FROM transactions WHERE public_id = ?", (public_id,)
                ).fetchone()
                if not exists:
                    return _json_error("This test payment could not be found.", 404)
        final = db.execute("SELECT status FROM transactions WHERE public_id = ?", (public_id,)).fetchone()
        return jsonify(status=final["status"], payment_mode="test")

    @app.get("/api/dashboard")
    @_require_user
    def dashboard(user):
        db = get_db()
        stall = db.execute("SELECT * FROM stalls WHERE owner_id = ?", (user["id"],)).fetchone()
        if not stall:
            return jsonify(stall=None, totals=None, transactions=[], history=[])
        totals = db.execute(
            """SELECT COALESCE(SUM(amount_cents), 0) AS raised, COUNT(*) AS donations,
                      COUNT(DISTINCT supporter_name) AS supporters
               FROM transactions WHERE stall_id = ? AND status = 'confirmed' AND payment_mode = 'test'""",
            (stall["id"],),
        ).fetchone()
        transactions = db.execute(
            """SELECT public_id, amount_cents, supporter_name, message, status, payment_mode, created_at
               FROM transactions WHERE stall_id = ? ORDER BY created_at DESC LIMIT 20""",
            (stall["id"],),
        ).fetchall()
        history = db.execute(
            """SELECT substr(confirmed_at, 1, 10) AS day, SUM(amount_cents) AS amount_cents
               FROM transactions WHERE stall_id = ? AND status = 'confirmed'
               GROUP BY substr(confirmed_at, 1, 10) ORDER BY day DESC LIMIT 30""",
            (stall["id"],),
        ).fetchall()
        return jsonify(
            stall=_public_stall(stall),
            totals=dict(totals),
            real_earnings_cents=0,
            transactions=[dict(row) for row in transactions],
            history=[dict(row) for row in reversed(history)],
            account=_json_user(user),
        )

    @app.get("/api/admin/overview")
    @_require_admin
    def admin_overview(_user):
        db = get_db()
        users = db.execute(
            """SELECT id, email, username, display_name, role, suspended, created_at
               FROM users ORDER BY created_at DESC LIMIT 200"""
        ).fetchall()
        stalls = db.execute(
            """SELECT s.id, s.slug, s.creator_name, s.created_at, u.email, u.suspended
               FROM stalls s JOIN users u ON u.id = s.owner_id ORDER BY s.created_at DESC LIMIT 200"""
        ).fetchall()
        reports = db.execute(
            """SELECT r.id, r.reason, r.details, r.status, r.created_at, s.slug, s.creator_name
               FROM reports r JOIN stalls s ON s.id = r.stall_id
               ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100"""
        ).fetchall()
        transactions = db.execute(
            """SELECT t.public_id, t.amount_cents, t.status, t.payment_mode, t.created_at,
                      s.slug, s.creator_name
               FROM transactions t JOIN stalls s ON s.id = t.stall_id
               ORDER BY t.created_at DESC LIMIT 100"""
        ).fetchall()
        return jsonify(
            users=[dict(row) for row in users],
            stalls=[dict(row) for row in stalls],
            reports=[dict(row) for row in reports],
            transactions=[dict(row) for row in transactions],
        )

    @app.post("/api/admin/users/<int:user_id>/suspend")
    @_require_admin
    def set_suspension(admin, user_id):
        try:
            suspended = _body().get("suspended")
            if not isinstance(suspended, bool):
                raise ValueError("Suspension status must be true or false.")
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        target = db.execute("SELECT id, role FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            return _json_error("Account not found.", 404)
        if target["role"] == "admin" and suspended:
            active_admins = db.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND suspended = 0"
            ).fetchone()[0]
            if target["id"] == admin["id"] or active_admins <= 1:
                return _json_error("The active administrator account cannot be suspended.", 409)
        db.execute("UPDATE users SET suspended = ? WHERE id = ?", (int(suspended), user_id))
        return jsonify(ok=True, suspended=suspended)

    @app.post("/api/admin/reports/<int:report_id>")
    @_require_admin
    def update_report(_admin, report_id):
        try:
            status = _text(_body(), "status", "Report status", 12, required=True)
            if status not in {"resolved", "dismissed"}:
                raise ValueError("Choose resolved or dismissed.")
        except ValueError as error:
            return _json_error(str(error))
        cursor = get_db().execute("UPDATE reports SET status = ? WHERE id = ?", (status, report_id))
        if cursor.rowcount == 0:
            return _json_error("Report not found.", 404)
        return jsonify(ok=True, status=status)

    @app.post("/api/reports")
    def create_report():
        try:
            data = _body()
            slug = _text(data, "slug", "Stall", 24, required=True)
            reason = _text(data, "reason", "Reason", 30, required=True)
            details = _text(data, "details", "Details", 500)
            if reason not in {"spam", "harassment", "misleading", "other"}:
                raise ValueError("Choose a valid report reason.")
        except ValueError as error:
            return _json_error(str(error))
        db = get_db()
        stall = db.execute("SELECT id FROM stalls WHERE slug = ?", (slug,)).fetchone()
        if not stall:
            return _json_error("This Stall could not be found.", 404)
        db.execute(
            "INSERT INTO reports (stall_id, reason, details) VALUES (?, ?, ?)",
            (stall["id"], reason, details),
        )
        return jsonify(message="Thank you. Your report has been sent to the moderation team."), 201

    @app.errorhandler(413)
    def request_too_large(_error):
        return _json_error("Request is too large.", 413)

    @app.errorhandler(500)
    def internal_error(error):
        logger.exception("DonateMeTube request failed: %s", error)
        return _json_error("Something went wrong. Please try again.", 500)

    _bootstrap_admin(app)
    return app


def _bootstrap_admin(app):
    email = os.environ.get("DONATEMETUBE_ADMIN_EMAIL", "").strip().lower()
    password = os.environ.get("DONATEMETUBE_ADMIN_PASSWORD", "")
    if not email and not password:
        return
    if not EMAIL_RE.fullmatch(email) or len(password) < 16:
        raise RuntimeError("Set a valid DONATEMETUBE_ADMIN_EMAIL and a DONATEMETUBE_ADMIN_PASSWORD of at least 16 characters.")
    with app.app_context():
        db = get_db()
        existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            logger.warning("Admin bootstrap skipped: the configured email is already registered.")
            return
        username = f"admin_{secrets.token_hex(4)}"
        db.execute(
            """INSERT INTO users (email, username, password_hash, display_name, role)
               VALUES (?, ?, ?, 'Administrator', 'admin')""",
            (email, username, generate_password_hash(password)),
        )


app = create_app()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        debug=False,
    )
