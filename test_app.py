import re
import tempfile
import unittest
from pathlib import Path

from werkzeug.security import generate_password_hash

from backend.app import create_app
from backend.database import get_db


class DonateMeTubeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.app = create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "test-secret-key",
                "DATABASE_PATH": str(Path(self.temp_dir.name) / "test.sqlite3"),
                "ENVIRONMENT": "test",
            }
        )
        self.client = self.app.test_client()
        self.csrf = self.client.get("/api/session").json["csrf_token"]

    def tearDown(self):
        self.temp_dir.cleanup()

    def post(self, url, payload, client=None):
        return (client or self.client).post(
            url,
            json=payload,
            headers={"X-CSRF-Token": self.csrf},
        )

    def register(self, username="creator", email="creator@example.com", client=None):
        response = self.post(
            "/api/register",
            {
                "display_name": "A Creator",
                "username": username,
                "email": email,
                "password": "a-secure-password",
            },
            client,
        )
        self.assertEqual(response.status_code, 201, response.json)
        if client is None:
            self.csrf = response.json["csrf_token"]
        return response

    def create_stall(self, client=None, username=None):
        if client is None:
            client = self.client
        if username is None:
            username = self.client.get("/api/session").json["user"]["username"]
        response = self.post(
            "/api/stalls",
            {
                "creator_name": "Creator Name",
                "bio": "I make useful things.",
                "goal": "100.00",
                "socials": {"youtube": "https://youtube.com/@creator"},
            },
            client,
        )
        self.assertEqual(response.status_code, 201, response.json)
        self.assertEqual(response.json["stall"]["slug"], username)
        return response.json["stall"]

    def create_donation(self, amount="12.50", idempotency_key="11111111-1111-4111-8111-111111111111"):
        response = self.post(
            "/api/donations/start",
            {
                "slug": "creator",
                "amount": amount,
                "supporter_name": "Supporter",
                "message": "Keep going!",
                "idempotency_key": idempotency_key,
            },
        )
        self.assertEqual(response.status_code, 201, response.json)
        return response.json["transaction_id"]

    def test_registration_login_and_account_isolation(self):
        self.register()
        self.assertEqual(self.client.get("/api/session").json["user"]["email"], "creator@example.com")
        logout = self.post("/api/logout", {})
        self.assertEqual(logout.status_code, 200)
        self.csrf = logout.json["csrf_token"]
        login = self.post("/api/login", {"email": "creator@example.com", "password": "a-secure-password"})
        self.assertEqual(login.status_code, 200)
        self.csrf = login.json["csrf_token"]
        self.assertEqual(self.post("/api/login", {"email": "creator@example.com", "password": "wrong-password"}).status_code, 401)

    def test_password_recovery_uses_one_time_expiring_reset_token(self):
        self.register()
        with self.assertLogs("backend.app", level="INFO") as captured:
            generic = self.post(
                "/api/password-reset/request",
                {"email": "creator@example.com"},
            )
        self.assertIn("If that account exists", generic.json["message"])
        token = re.search(r"token=([A-Za-z0-9_-]+)", "\n".join(captured.output)).group(1)
        completed = self.post(
            "/api/password-reset/complete",
            {"token": token, "password": "a-new-secure-password"},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(
            self.post(
                "/api/password-reset/complete",
                {"token": token, "password": "another-secure-password"},
            ).status_code,
            400,
        )
        self.client.post("/api/logout", headers={"X-CSRF-Token": self.csrf}, json={})
        self.csrf = self.client.get("/api/session").json["csrf_token"]
        login = self.post(
            "/api/login",
            {"email": "creator@example.com", "password": "a-new-secure-password"},
        )
        self.assertEqual(login.status_code, 200)

    def test_each_account_can_create_only_one_stall(self):
        self.register()
        self.create_stall()
        duplicate = self.post(
            "/api/stalls",
            {"creator_name": "Another", "bio": "Second Stall"},
        )
        self.assertEqual(duplicate.status_code, 409)

    def test_stall_goal_can_be_omitted(self):
        self.register()
        response = self.post(
            "/api/stalls",
            {"creator_name": "Creator Name", "bio": "A creator without a goal."},
        )
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.json["stall"]["goal_cents"])
        self.assertIsNone(response.json["stall"]["goal_progress"])

    def test_stall_is_public_without_private_account_data(self):
        self.register()
        self.create_stall()
        response = self.client.get("/api/stalls/creator")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["stall"]["creator_name"], "Creator Name")
        self.assertNotIn("email", response.json["stall"])
        self.assertNotIn("password_hash", response.json["stall"])
        self.assertEqual(len(self.client.get("/api/stalls").json["stalls"]), 1)

    def test_confirmed_test_donation_counts_once_and_is_not_real_earnings(self):
        self.register()
        self.create_stall()
        transaction_id = self.create_donation()
        before = self.client.get("/api/dashboard").json
        self.assertEqual(before["totals"]["raised"], 0)
        confirmed = self.post(
            f"/api/donations/{transaction_id}/complete",
            {"outcome": "confirm"},
        )
        repeated = self.post(
            f"/api/donations/{transaction_id}/complete",
            {"outcome": "decline"},
        )
        dashboard = self.client.get("/api/dashboard").json
        self.assertEqual(confirmed.json["status"], "confirmed")
        self.assertEqual(repeated.json["status"], "confirmed")
        self.assertEqual(dashboard["totals"]["raised"], 1250)
        self.assertEqual(dashboard["totals"]["donations"], 1)
        self.assertEqual(dashboard["real_earnings_cents"], 0)
        public = self.client.get("/api/stalls/creator").json["stall"]
        self.assertEqual(public["test_raised_cents"], 1250)

    def test_declined_test_payment_does_not_increase_totals(self):
        self.register()
        self.create_stall()
        transaction_id = self.create_donation()
        result = self.post(
            f"/api/donations/{transaction_id}/complete",
            {"outcome": "decline"},
        )
        self.assertEqual(result.json["status"], "failed")
        dashboard = self.client.get("/api/dashboard").json
        self.assertEqual(dashboard["totals"]["raised"], 0)
        self.assertEqual(dashboard["totals"]["donations"], 0)
        self.assertEqual(dashboard["transactions"][0]["status"], "failed")

    def test_donation_amount_validation_and_duplicate_reference(self):
        self.register()
        self.create_stall()
        invalid = self.post(
            "/api/donations/start",
            {
                "slug": "creator",
                "amount": "0.25",
                "supporter_name": "Supporter",
                "idempotency_key": "11111111-1111-4111-8111-111111111111",
            },
        )
        self.assertEqual(invalid.status_code, 400)
        self.create_donation()
        duplicate = self.post(
            "/api/donations/start",
            {
                "slug": "creator",
                "amount": "25.00",
                "supporter_name": "Different",
                "idempotency_key": "11111111-1111-4111-8111-111111111111",
            },
        )
        self.assertEqual(duplicate.status_code, 409)
        same_amount_reused_key = self.post(
            "/api/donations/start",
            {
                "slug": "creator",
                "amount": "12.50",
                "supporter_name": "A different supporter",
                "idempotency_key": "11111111-1111-4111-8111-111111111111",
            },
        )
        self.assertEqual(same_amount_reused_key.status_code, 409)

    def test_csrf_required_for_state_changes(self):
        response = self.client.post(
            "/api/register",
            json={
                "display_name": "Creator",
                "username": "creator",
                "email": "creator@example.com",
                "password": "a-secure-password",
            },
        )
        self.assertEqual(response.status_code, 403)

    def test_admin_routes_are_forbidden_for_regular_users(self):
        self.register()
        self.assertEqual(self.client.get("/api/admin/overview").status_code, 403)

    def test_admin_can_review_reports_and_suspend_accounts(self):
        self.register()
        self.create_stall()
        self.post(
            "/api/reports",
            {"slug": "creator", "reason": "spam", "details": "Please review."},
        )
        regular_user_id = self.client.get("/api/session").json["user"]["id"]
        self.post("/api/logout", {})
        admin_client = self.app.test_client()
        admin_csrf = admin_client.get("/api/session").json["csrf_token"]
        with self.app.app_context():
            with get_db() as db:
                db.execute(
                    """INSERT INTO users (email, username, password_hash, display_name, role)
                       VALUES (?, ?, ?, ?, 'admin')""",
                    ("admin@example.com", "admin_user", generate_password_hash("another-secure-password"), "Admin"),
                )
        admin_login = admin_client.post(
            "/api/login",
            json={"email": "admin@example.com", "password": "another-secure-password"},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(admin_login.status_code, 200)
        admin_csrf = admin_login.json["csrf_token"]
        overview = admin_client.get("/api/admin/overview")
        self.assertEqual(overview.status_code, 200)
        report_id = overview.json["reports"][0]["id"]
        update = admin_client.post(
            f"/api/admin/reports/{report_id}",
            json={"status": "resolved"},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(update.status_code, 200)
        suspend = admin_client.post(
            f"/api/admin/users/{regular_user_id}/suspend",
            json={"suspended": True},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(suspend.status_code, 200)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 401)
        self.assertEqual(self.client.get("/api/stalls/creator").status_code, 404)


if __name__ == "__main__":
    unittest.main()
