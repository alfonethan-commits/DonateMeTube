# DonateMeTube Basic

A responsive creator-support platform with account registration, one personal
Stall per account, public creator discovery, a private creator dashboard, and
an administration area. The backend uses Flask and SQLite; the frontend is
plain JavaScript, HTML, and CSS.

## Run on Windows

From PowerShell in this folder:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m backend.app
```

Open <http://127.0.0.1:5000>. The SQLite database is created at
`instance/donateme.sqlite3`. Set `DONATEMETUBE_DATABASE` to use another
database path.

## Development payment flow

Payments are **test mode only**. A supporter reviews a donation and chooses to
confirm or decline a clearly labeled test payment. Confirmed test records are
visible on the Stall and in its owner's dashboard, but are never treated as
real earnings. No payment provider is connected; no card information is
requested, collected, or stored, and no real money changes hands.

Password reset tokens are printed to the local development server console.
Reset instructions are generic and tokens expire after 30 minutes. Configure a
trusted email provider before deploying account recovery in production.

## Administration

Create the initial administrator before starting the server by setting both
environment variables. The password must have at least 16 characters.

```powershell
$env:DONATEMETUBE_ADMIN_EMAIL = "admin@example.com"
$env:DONATEMETUBE_ADMIN_PASSWORD = "use-a-long-unique-password"
$env:DONATEMETUBE_SECRET_KEY = "replace-with-a-generated-random-secret-before-running"
python -m backend.app
```

The configured administrator is created only when the email is not already
registered. Administrator status cannot be selected through public
registration. Administrators can open `http://127.0.0.1:5000/#admin`; API
authorization is enforced server-side.

## Tests

```powershell
python -m unittest discover -s tests -v
```

The tests cover registration and login, one-Stall enforcement, public/private
data boundaries, test donation confirmation and decline, duplicate protection,
CSRF checks, administration authorization, reports, and account suspension.

## Production notes

This project is an initial local-development version. Before exposing it to
the public internet, configure a persistent secret key, HTTPS, trusted email
delivery for account recovery, backups, operational monitoring, and a real
payment-provider integration with verified webhooks. Until that integration
exists, test records must not be presented as real earnings.
