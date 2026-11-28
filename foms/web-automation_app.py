"""FOMS POC -- a local web-based form builder.

Projects -> Forms -> (Design | Database | Workflow) -> Save / Publish ->
Summary + Fill.

NOTE ON FILE NAMING
-------------------
This machine's security policy only allows ``python.exe`` to read/run ``.py``
files named ``web-automation_*.py``.  Hyphens are illegal in Python import
names, so we cannot split the backend into importable local modules.  The
*entire* backend therefore lives in this single file.  Run it with::

    py "web-automation_app.py"

Templates (templates/*.html) and static assets (static/**) are plain files --
Flask is allowed to read those.
"""
import calendar
import csv
import io
import json
import os
import re
import secrets
import smtplib
import string
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None

from flask import Flask, render_template, request, jsonify, abort
from sqlalchemy import (
    create_engine, Column, Integer, String, Text, DateTime, ForeignKey, Boolean
)
from sqlalchemy.orm import sessionmaker, declarative_base, relationship

# --------------------------------------------------------------------------- #
#  Database setup
# --------------------------------------------------------------------------- #
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "foms.db")
ENGINE = create_engine(f"sqlite:///{DB_PATH}", echo=False, future=True)
SessionLocal = sessionmaker(bind=ENGINE, autoflush=False, future=True)
Base = declarative_base()


def _now():
    return datetime.utcnow()


_UUID_ALPHABET = string.ascii_letters + string.digits


def gen_uuid():
    """A 40-character alphanumeric id, globally unique across projects/forms."""
    return "".join(secrets.choice(_UUID_ALPHABET) for _ in range(40))


# --------------------------------------------------------------------------- #
#  Models
# --------------------------------------------------------------------------- #
class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    archived = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_now)
    forms = relationship("Form", back_populates="project",
                         cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description or "",
            "archived": bool(self.archived),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "form_count": len([f for f in self.forms if not f.archived]),
        }


class Form(Base):
    """Holds the editable *working copy* of a form.  Each Publish snapshots it
    into an immutable FormVersion (kept forever -> old + new schema backups)."""
    __tablename__ = "forms"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String(200), nullable=False)
    status = Column(String(20), default="draft")          # draft | published
    archived = Column(Boolean, default=False)
    working_schema = Column(Text, default="{}")
    working_workflow = Column(Text, default="{}")
    published_version_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    project = relationship("Project", back_populates="forms")
    versions = relationship("FormVersion", back_populates="form",
                            cascade="all, delete-orphan",
                            foreign_keys="FormVersion.form_id")
    submissions = relationship("Submission", back_populates="form",
                               cascade="all, delete-orphan")
    extract_tasks = relationship("ExtractTask", cascade="all, delete-orphan")
    lookups = relationship("LookupTable", cascade="all, delete-orphan")
    email_logs = relationship("EmailLog", cascade="all, delete-orphan")

    def schema_dict(self):
        try:
            return json.loads(self.working_schema or "{}")
        except json.JSONDecodeError:
            return {}

    def workflow_dict(self):
        try:
            return json.loads(self.working_workflow or "{}")
        except json.JSONDecodeError:
            return {}

    def to_dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "name": self.name,
            "status": self.status,
            "archived": bool(self.archived),
            "published_version_id": self.published_version_id,
            "version_count": len(self.versions),
            "submission_count": len(self.submissions),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class FormVersion(Base):
    """Immutable snapshot created on every Publish."""
    __tablename__ = "form_versions"
    id = Column(Integer, primary_key=True)
    form_id = Column(Integer, ForeignKey("forms.id"), nullable=False)
    version_no = Column(Integer, nullable=False)
    schema_json = Column(Text, default="{}")
    workflow_json = Column(Text, default="{}")
    published_at = Column(DateTime, default=_now)

    form = relationship("Form", back_populates="versions",
                        foreign_keys=[form_id])

    def to_dict(self, include_payload=False):
        d = {
            "id": self.id,
            "form_id": self.form_id,
            "version_no": self.version_no,
            "published_at": self.published_at.isoformat() if self.published_at else None,
        }
        if include_payload:
            d["schema"] = json.loads(self.schema_json or "{}")
            d["workflow"] = json.loads(self.workflow_json or "{}")
        return d


class Submission(Base):
    __tablename__ = "submissions"
    id = Column(Integer, primary_key=True)
    uuid = Column(String(40), default=gen_uuid, unique=True, index=True)
    form_id = Column(Integer, ForeignKey("forms.id"), nullable=False)
    version_id = Column(Integer, ForeignKey("form_versions.id"), nullable=True)
    data_json = Column(Text, default="{}")
    stage = Column(String(120), default="")
    status = Column(String(40), default="submitted")  # draft | submitted
    modified_by = Column(String(160), default="")
    last_trace = Column(Text, default="")             # JSON: most recent run
    traces = Column(Text, default="[]")               # JSON list: all runs (newest first)
    last_ok = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    form = relationship("Form", back_populates="submissions")

    def data_dict(self):
        try:
            return json.loads(self.data_json or "{}")
        except json.JSONDecodeError:
            return {}

    def to_dict(self):
        try:
            trace = json.loads(self.last_trace) if self.last_trace else None
        except (json.JSONDecodeError, TypeError):
            trace = None
        try:
            traces = json.loads(self.traces) if self.traces else []
        except (json.JSONDecodeError, TypeError):
            traces = []
        return {
            "id": self.id,
            "uuid": self.uuid or "",
            "form_id": self.form_id,
            "version_id": self.version_id,
            "data": self.data_dict(),
            "stage": self.stage,
            "status": self.status,
            "modified_by": self.modified_by or "",
            "last_ok": bool(self.last_ok),
            "last_trace": trace,
            "traces": traces,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class EmailLog(Base):
    """Dummy 'sent' emails produced by send_email workflow nodes."""
    __tablename__ = "email_logs"
    id = Column(Integer, primary_key=True)
    form_id = Column(Integer, ForeignKey("forms.id"), nullable=False)
    submission_id = Column(Integer, nullable=True)
    sender = Column(String(200), default="")
    recipient = Column(String(400), default="")
    subject = Column(String(400), default="")
    body = Column(Text, default="")
    body_html = Column(Text, default="")
    attachment = Column(String(400), default="")
    sent_at = Column(DateTime, default=_now)

    def to_dict(self):
        return {
            "id": self.id, "form_id": self.form_id,
            "submission_id": self.submission_id, "sender": self.sender,
            "recipient": self.recipient, "subject": self.subject,
            "body": self.body, "attachment": self.attachment,
            "sent_at": self.sent_at.isoformat() if self.sent_at else None,
        }


class Setting(Base):
    """Portal-wide key/value settings (e.g. email/SendGrid config)."""
    __tablename__ = "settings"
    key = Column(String(80), primary_key=True)
    value = Column(Text, default="")


class ExtractTask(Base):
    """A saved/scheduled export of a form's submissions."""
    __tablename__ = "extract_tasks"
    id = Column(Integer, primary_key=True)
    form_id = Column(Integer, ForeignKey("forms.id"), nullable=False)
    name = Column(String(200), default="Extract")
    columns = Column(Text, default="[]")          # JSON list of column keys
    file_type = Column(String(10), default="csv")  # csv | xlsx
    folder_path = Column(Text, default="")         # server folder for scheduled runs
    schedule = Column(String(20), default="daily")  # hourly|daily|weekly|monthly
    minute = Column(Integer, default=0)
    hour = Column(Integer, default=9)
    weekday = Column(Integer, default=0)           # 0=Mon (weekly)
    day = Column(Integer, default=1)               # day of month (monthly)
    timezone = Column(String(60), default="UTC")
    active = Column(Boolean, default=True)
    last_run = Column(DateTime, nullable=True)
    next_run = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)

    def to_dict(self):
        return {
            "id": self.id, "form_id": self.form_id, "name": self.name,
            "columns": json.loads(self.columns or "[]"), "file_type": self.file_type,
            "folder_path": self.folder_path or "", "schedule": self.schedule,
            "minute": self.minute, "hour": self.hour, "weekday": self.weekday,
            "day": self.day, "timezone": self.timezone, "active": self.active,
            "last_run": self.last_run.isoformat() if self.last_run else None,
            "next_run": self.next_run.isoformat() if self.next_run else None,
        }


class LookupTable(Base):
    """An uploaded CSV/Excel used to pre-populate form fields while filling."""
    __tablename__ = "lookup_tables"
    id = Column(Integer, primary_key=True)
    form_id = Column(Integer, ForeignKey("forms.id"), nullable=False)
    name = Column(String(200), default="Lookup")
    key_column = Column(String(200), default="")      # column in the file to match on
    key_component = Column(String(200), default="")    # form field whose value is matched
    columns = Column(Text, default="[]")
    rows = Column(Text, default="[]")
    mappings = Column(Text, default="[]")              # [{col, comp}]
    created_at = Column(DateTime, default=_now)

    def to_dict(self, include_rows=False):
        d = {"id": self.id, "form_id": self.form_id, "name": self.name,
             "key_column": self.key_column, "key_component": self.key_component,
             "columns": json.loads(self.columns or "[]"),
             "mappings": json.loads(self.mappings or "[]"),
             "row_count": len(json.loads(self.rows or "[]"))}
        if include_rows:
            d["rows"] = json.loads(self.rows or "[]")
        return d


Base.metadata.create_all(ENGINE)


def _migrate():
    """Add columns introduced after a DB already existed (SQLite)."""
    from sqlalchemy import text
    stmts = [
        "ALTER TABLE submissions ADD COLUMN modified_by VARCHAR(160) DEFAULT ''",
        "ALTER TABLE submissions ADD COLUMN uuid VARCHAR(40)",
        "ALTER TABLE submissions ADD COLUMN last_trace TEXT DEFAULT ''",
        "ALTER TABLE submissions ADD COLUMN traces TEXT DEFAULT '[]'",
        "ALTER TABLE submissions ADD COLUMN last_ok BOOLEAN DEFAULT 1",
        "ALTER TABLE projects ADD COLUMN archived BOOLEAN DEFAULT 0",
        "ALTER TABLE forms ADD COLUMN archived BOOLEAN DEFAULT 0",
        "ALTER TABLE email_logs ADD COLUMN body_html TEXT DEFAULT ''",
    ]
    with ENGINE.begin() as conn:
        for s in stmts:
            try:
                conn.execute(text(s))
            except Exception:
                pass  # column already exists
    # backfill uuids for any existing submissions
    sess = SessionLocal()
    try:
        for sub in sess.query(Submission).filter(
                (Submission.uuid.is_(None)) | (Submission.uuid == "")).all():
            sub.uuid = gen_uuid()
        sess.commit()
    except Exception:
        sess.rollback()
    finally:
        sess.close()


_migrate()


def _cleanup_orphan_tasks():
    """Remove extract tasks whose form no longer exists."""
    s = SessionLocal()
    try:
        form_ids = {row[0] for row in s.query(Form.id).all()}
        for t in s.query(ExtractTask).all():
            if t.form_id not in form_ids:
                s.delete(t)
        for e in s.query(EmailLog).all():
            if e.form_id not in form_ids:
                s.delete(e)
        s.commit()
    except Exception:
        s.rollback()
    finally:
        s.close()


_cleanup_orphan_tasks()


# --------------------------------------------------------------------------- #
#  Workflow execution engine
# --------------------------------------------------------------------------- #
def _system_tokens(data):
    """Built-in {{_token}} values available everywhere {{field}} tokens work."""
    n = datetime.now()
    return {
        "_date": n.strftime("%Y-%m-%d"),
        "_time": n.strftime("%H:%M:%S"),
        "_datetime": n.strftime("%Y-%m-%d %H:%M:%S"),
        "_timestamp": n.strftime("%Y-%m-%d %H:%M:%S"),
        "_now": n.strftime("%Y-%m-%d %H:%M:%S"),
        "_uuid": str((data or {}).get("uuid", "")),
    }


def _template(text, data):
    if not text:
        return text
    sys = _system_tokens(data)

    def repl(m):
        k = m.group(1).strip()
        if k in sys:
            return sys[k]
        return str(data.get(k, ""))

    return re.sub(r"\{\{\s*([\w.-]+)\s*\}\}", repl, str(text))


def _graph_nodes(graph):
    try:
        modules = graph["drawflow"]
    except (KeyError, TypeError):
        return {}
    for mod in modules.values():
        data = mod.get("data")
        if data:
            return data
    return {}


def _start_node(nodes):
    for nid, node in nodes.items():
        if node.get("name") == "button_start":
            return nid
    for nid, node in nodes.items():
        inputs = node.get("inputs") or {}
        if not any(p.get("connections") for p in inputs.values()):
            return nid
    return next(iter(nodes), None)


def _next_id(node):
    for port in (node.get("outputs") or {}).values():
        conns = port.get("connections") or []
        if conns:
            return str(conns[0]["node"])
    return None


def _port_target(node, port):
    conns = ((node.get("outputs") or {}).get(port) or {}).get("connections") or []
    return str(conns[0]["node"]) if conns else None


_DT_FORMATS = ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S",
               "%Y-%m-%d %H:%M", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%H:%M:%S", "%H:%M")


def _parse_dt(v):
    if v in (None, ""):
        return None
    s = str(v).strip()
    for f in _DT_FORMATS:
        try:
            return datetime.strptime(s, f)
        except ValueError:
            continue
    return None


def _to_bool(v):
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on", "checked")


def _coerce(v, dtype):
    """Coerce a raw value to a comparable per data type; None if not comparable."""
    dtype = (dtype or "string").lower()
    if dtype == "number":
        try:
            return float(str(v).strip())
        except (TypeError, ValueError):
            return None
    if dtype in ("date", "datetime"):
        return _parse_dt(v)
    if dtype == "boolean":
        return 1 if _to_bool(v) else 0
    if dtype == "email":
        return str("" if v is None else v).strip().lower()
    return str("" if v is None else v)


def _eval_condition(field, op, value, data, dtype="string"):
    actual = data.get(field, "")
    a = "" if actual is None else str(actual)
    b = "" if value is None else str(value)
    op = (op or "==").lower()
    dtype = (dtype or "string").lower()
    if op == "empty":
        return a.strip() == ""
    if op in ("notempty", "not_empty"):
        return a.strip() != ""
    if op == "contains":
        if dtype == "email":
            return b.strip().lower() in a.strip().lower()
        return b.lower() in a.lower()
    if op in ("==", "eq", "equals", "!=", "ne"):
        ca, cb = _coerce(a, dtype), _coerce(b, dtype)
        eq = (ca == cb) if (ca is not None and cb is not None) else (a == b)
        return eq if op in ("==", "eq", "equals") else (not eq)
    # ordering operators (>, <, >=, <=)
    ca, cb = _coerce(a, dtype), _coerce(b, dtype)
    if ca is None or cb is None:
        return False
    try:
        if op == ">":
            return ca > cb
        if op == "<":
            return ca < cb
        if op == ">=":
            return ca >= cb
        if op == "<=":
            return ca <= cb
    except TypeError:
        return False
    return False


def _branch_next(node, ctx):
    nd = {str(k).lower(): v for k, v in (node.get("data") or {}).items()}
    dtype = nd.get("dtype") or "string"
    if node.get("name") == "if":
        ok = _eval_condition(nd.get("field"), nd.get("op"), nd.get("value"), ctx["data"], dtype)
        ctx["log"].append(f"⎇ If '{nd.get('field')}' {nd.get('op', '==')} '{nd.get('value', '')}' ({dtype}) → {'TRUE' if ok else 'FALSE'} branch")
        return _port_target(node, "output_1" if ok else "output_2")
    # switch: case1..case3 -> output_1..3, else output_4
    val = str(ctx["data"].get(nd.get("field"), ""))
    for i, cv in enumerate([nd.get("case1"), nd.get("case2"), nd.get("case3")]):
        if cv not in (None, "") and _eval_condition(nd.get("field"), "==", cv, ctx["data"], dtype):
            ctx["log"].append(f"⎇ Switch '{nd.get('field')}' = '{val}' ({dtype}) → case {i + 1}")
            return _port_target(node, f"output_{i + 1}")
    ctx["log"].append(f"⎇ Switch '{nd.get('field')}' = '{val}' ({dtype}) → default")
    return _port_target(node, "output_4")


def _find_email(schema, email_id):
    for e in schema.get("emails", []):
        if str(e.get("id")) == str(email_id):
            return e
    return None


def _find_http_component(schema, key):
    """Locate an in-form API Fetch (type 'http') element by key, incl. in sections."""
    elements = schema.get("elements")
    if elements is None:
        elements = schema.get("components", [])
    for el in elements:
        if el.get("type") == "http" and str(el.get("key")) == str(key):
            return el
        if el.get("type") == "section":
            for ch in el.get("children", []):
                if ch.get("type") == "http" and str(ch.get("key")) == str(key):
                    return ch
    return None


# --------------------------------------------------------------------------- #
#  Settings store + email delivery (portal-wide; SendGrid or SMTP)
# --------------------------------------------------------------------------- #
def _get_setting(session, key, default=""):
    row = session.get(Setting, key)
    return row.value if (row and row.value not in (None, "")) else default


def _set_setting(session, key, value):
    row = session.get(Setting, key)
    if row:
        row.value = value
    else:
        session.add(Setting(key=key, value=value))


def _email_config(session):
    g = lambda k, d="": _get_setting(session, "email_" + k, d)
    provider = g("provider", "")
    if not provider:
        provider = "smtp" if os.environ.get("FOMS_SMTP_HOST") else "none"
    return {
        "provider": provider,
        "from_email": g("from_email", os.environ.get("FOMS_SMTP_FROM", "")),
        "from_name": g("from_name", "FOMS"),
        "sendgrid_api_key": g("sendgrid_api_key", os.environ.get("FOMS_SENDGRID_KEY", "")),
        "smtp_host": g("smtp_host", os.environ.get("FOMS_SMTP_HOST", "")),
        "smtp_port": g("smtp_port", os.environ.get("FOMS_SMTP_PORT", "587")),
        "smtp_user": g("smtp_user", os.environ.get("FOMS_SMTP_USER", "")),
        "smtp_pass": g("smtp_pass", os.environ.get("FOMS_SMTP_PASS", "")),
        "smtp_tls": g("smtp_tls", "1"),
    }


def _email_accounts(session):
    """List of configured sender accounts. Migrates a legacy single config."""
    raw = _get_setting(session, "email_accounts", "")
    accounts = []
    if raw:
        try:
            accounts = json.loads(raw)
        except Exception:
            accounts = []
    if not accounts:
        cfg = _email_config(session)
        if cfg["provider"] != "none" or cfg["sendgrid_api_key"] or cfg["smtp_host"]:
            accounts = [{"id": "default", "name": cfg["from_email"] or "Default",
                         "provider": cfg["provider"], "from_email": cfg["from_email"],
                         "from_name": cfg["from_name"], "sendgrid_api_key": cfg["sendgrid_api_key"],
                         "smtp_host": cfg["smtp_host"], "smtp_port": cfg["smtp_port"],
                         "smtp_user": cfg["smtp_user"], "smtp_pass": cfg["smtp_pass"],
                         "smtp_tls": cfg["smtp_tls"]}]
    return accounts


def _pick_account(accounts, account_id):
    if account_id:
        for a in accounts:
            if str(a.get("id")) == str(account_id):
                return a
    return accounts[0] if accounts else None


def _recipients(recipient):
    return [r.strip() for r in re.split(r"[;,]", recipient or "") if r.strip()]


def _send_sendgrid(cfg, mail, attachments=None):
    to = _recipients(mail.recipient)
    if not to:
        return False, "no recipient address"
    from_email = cfg["from_email"] or mail.sender
    if not from_email:
        return False, "no 'From' address set in Settings"
    payload = {
        "personalizations": [{"to": [{"email": a} for a in to]}],
        "from": {"email": from_email, "name": cfg.get("from_name") or ""},
        "subject": mail.subject or "(no subject)",
        "content": [{"type": "text/plain", "value": mail.body or ""}],
    }
    html = (getattr(mail, "body_html", "") or "").strip()
    if html:
        # SendGrid requires text/plain before text/html.
        payload["content"].append({"type": "text/html", "value": html})
    if attachments:
        payload["attachments"] = [
            {"content": a["b64"], "filename": a["name"],
             "type": a.get("type") or "application/octet-stream",
             "disposition": "attachment"} for a in attachments if a.get("b64")]
    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + cfg["sendgrid_api_key"],
                 "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return True, f"SendGrid accepted ({resp.status})"
    except urllib.error.HTTPError as e:
        return False, f"SendGrid error {e.code}: {e.read(300).decode(errors='replace')}"
    except Exception as exc:  # noqa: BLE001
        return False, f"SendGrid failed: {exc}"


def _send_smtp(cfg, mail, attachments=None):
    host = cfg["smtp_host"]
    if not host:
        return False, "no SMTP host set in Settings"
    to = _recipients(mail.recipient)
    if not to:
        return False, "no recipient address"
    sender = cfg["from_email"] or cfg["smtp_user"] or mail.sender or ""
    try:
        import base64 as _b64
        msg = EmailMessage()
        msg["From"] = sender
        msg["To"] = ", ".join(to)
        msg["Subject"] = mail.subject or "(no subject)"
        msg.set_content(mail.body or "")
        html = (getattr(mail, "body_html", "") or "").strip()
        if html:
            msg.add_alternative(html, subtype="html")
        for a in (attachments or []):
            if not a.get("b64"):
                continue
            maintype, _, subtype = (a.get("type") or "application/octet-stream").partition("/")
            msg.add_attachment(_b64.b64decode(a["b64"]), maintype=maintype or "application",
                               subtype=subtype or "octet-stream", filename=a.get("name", "file"))
        with smtplib.SMTP(host, int(cfg["smtp_port"] or 587), timeout=20) as srv:
            if str(cfg.get("smtp_tls", "1")) != "0":
                srv.starttls()
            if cfg["smtp_user"]:
                srv.login(cfg["smtp_user"], cfg["smtp_pass"] or "")
            srv.send_message(msg)
        return True, f"sent via {host}"
    except Exception as exc:  # noqa: BLE001
        return False, f"SMTP send failed: {exc}"


def _deliver_email(session, mail, attachments=None, account_id=None):
    """Send via the chosen sender account; returns (sent, detail)."""
    if not mail.recipient:
        return False, "no recipient address"
    acct = _pick_account(_email_accounts(session), account_id)
    if not acct:
        return False, "simulated (no email account configured in Settings)"
    if acct.get("provider") == "sendgrid" and acct.get("sendgrid_api_key"):
        return _send_sendgrid(acct, mail, attachments)
    if acct.get("provider") == "smtp" and acct.get("smtp_host"):
        return _send_smtp(acct, mail, attachments)
    return False, f"simulated (account '{acct.get('name')}' not fully configured)"


def _http_call(cfg, data):
    """Perform an HTTP request described by ``cfg`` (method, url, auth*, body*),
    templating {{field}} tokens from ``data``. Shared by the HTTP workflow node
    and the in-form API Fetch component. Returns a result dict."""
    method = (cfg.get("method") or "GET").upper()
    url = _template(cfg.get("url", ""), data)
    bodytype = (cfg.get("bodytype") or "none").lower()
    bodytxt = _template(cfg.get("body", "") or "", data)
    headers = {}
    ctype = {"json": "application/json", "xml": "application/xml",
             "html": "text/html", "form": "application/x-www-form-urlencoded",
             "text": "text/plain"}.get(bodytype)
    if ctype and bodytxt:
        headers["Content-Type"] = ctype
    authtype = (cfg.get("authtype") or "none").lower()
    if authtype == "basic":
        import base64 as _b64
        creds = f"{cfg.get('authuser', '')}:{cfg.get('authpass', '')}".encode()
        headers["Authorization"] = "Basic " + _b64.b64encode(creds).decode()
    elif authtype == "bearer":
        headers["Authorization"] = "Bearer " + str(cfg.get("authtoken", "") or "")
    elif authtype == "header":
        hn = (cfg.get("headername") or "").strip()
        if hn:
            headers[hn] = _template(str(cfg.get("headervalue", "") or ""), data)
    out = {"method": method, "url": url, "status": None, "error": None,
           "text": None, "json": None, "auth": authtype, "body_type": bodytype}
    try:
        req = urllib.request.Request(
            url, method=method,
            data=bodytxt.encode() if (bodytxt and method != "GET") else None,
            headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            out["status"] = resp.status
            raw = resp.read(40000).decode(errors="replace")
            out["text"] = raw
            try:
                out["json"] = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                pass
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["error"] = f"HTTP {e.code}"
        try:
            out["text"] = e.read(2000).decode(errors="replace")
        except Exception:
            pass
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)
    return out


FIELD_TYPES = {"text", "textarea", "number", "date", "email",
               "select", "radio", "checkbox"}


def _iter_fields(schema):
    """Yield (field_element, parent_section_or_None) for every element,
    descending into sections.  Works with the new ``elements`` tree and
    falls back to a legacy flat ``components`` list."""
    elements = schema.get("elements")
    if elements is None:
        elements = schema.get("components", [])
    for el in elements:
        if el.get("type") == "section":
            for child in el.get("children", []):
                yield child, el
        else:
            yield el, None


def _rule_visible(el, role, stage):
    r = (el or {}).get("rules") or {}
    vr = r.get("visibleRoles") or []
    vs = r.get("visibleStages") or []
    return (not vr or role in vr) and (not vs or stage in vs)


def _effective_visible(field, section, role, stage):
    if section is not None and not _rule_visible(section, role, stage):
        return False
    return _rule_visible(field, role, stage)


def _single_submission_conflict(session, form, schema, data, current_id):
    """If the form is single-submission and another submission already has the
    same value for the configured key, return an error string; else None."""
    cfg = schema.get("submission") or {}
    if cfg.get("mode") != "single":
        return None
    key = cfg.get("key")
    if not key:
        return None
    value = str(data.get(key, "")).strip()
    if value == "":
        return None
    label = key
    for f, _ in _iter_fields(schema):
        if f.get("key") == key:
            label = f.get("label") or key
            break
    for sub in session.query(Submission).filter_by(form_id=form.id).all():
        if current_id and sub.id == current_id:
            continue
        if str(sub.data_dict().get(key, "")).strip() == value:
            return (f"This form allows a single submission per {label}. "
                    f"A submission with {label} = '{value}' already exists.")
    return None


def execute_button(session, form, version, button_key, data, role, stage,
                   submission=None, visible_keys=None, pdf_base64=None,
                   pdf_filename=None, preview=False):
    schema = json.loads(version.schema_json or "{}") if version else form.schema_dict()
    workflow = json.loads(version.workflow_json or "{}") if version else form.workflow_dict()

    ctx = {
        "data": dict(data or {}), "stage": stage or "", "role": role or "",
        "preview": preview,            # simulate: don't persist submissions/emails
        "visible_keys": visible_keys,  # None = server decides by role/stage only
        "pdf": {"name": pdf_filename or "form.pdf", "b64": pdf_base64} if pdf_base64 else None,
        "errors": [], "log": [], "emails": [], "http": [], "dialogs": [],
        "navigate": None,
        "saved_submission_id": submission.id if submission else None,
        "stopped": False,
    }
    if submission is not None and submission.uuid:
        ctx["data"].setdefault("uuid", submission.uuid)

    # Current date/time tokens, usable as {{now}} / {{today}} / {{now_time}} /
    # {{now_iso}} in any _template-processed value (Set node, emails, HTTP, ...).
    # setdefault so a real submission field of the same key always wins.
    _ts = datetime.now()
    ctx["data"].setdefault("now", _ts.strftime("%Y-%m-%d %H:%M:%S"))
    ctx["data"].setdefault("today", _ts.strftime("%Y-%m-%d"))
    ctx["data"].setdefault("now_time", _ts.strftime("%H:%M:%S"))
    ctx["data"].setdefault("now_iso", _ts.isoformat(timespec="seconds"))

    graph = workflow.get(button_key)
    if not graph:
        ctx["log"].append(f"No workflow defined for button '{button_key}'. Nothing to do.")
        return ctx
    nodes = _graph_nodes(graph)
    if not nodes:
        ctx["log"].append("Workflow graph is empty.")
        return ctx

    cur = _start_node(nodes)
    guard = 0
    while cur is not None and not ctx["stopped"]:
        guard += 1
        if guard > 200:
            ctx["log"].append("Stopped: exceeded 200 steps (possible loop).")
            break
        node = nodes.get(cur)
        if not node:
            break
        name = node.get("name")
        if name in ("if", "switch"):
            cur = _branch_next(node, ctx)        # routing only
        else:
            _run_node(session, form, schema, name, node.get("data") or {}, ctx)
            cur = _next_id(node)

    if submission is not None:
        submission.data_json = json.dumps(ctx["data"])
        if ctx["stage"]:
            submission.stage = ctx["stage"]
        session.commit()
        ctx["saved_submission_id"] = submission.id

    # persist the run trace onto the resulting submission (shown in the DB tab)
    sid = ctx.get("saved_submission_id")
    if sid:
        sub = session.get(Submission, sid)
        if sub:
            entry = {
                "button": button_key, "ok": not ctx["errors"],
                "log": ctx["log"], "errors": ctx["errors"],
                "emails": ctx["emails"], "http": ctx["http"], "stage": ctx["stage"],
                "at": datetime.utcnow().isoformat(),
            }
            try:
                history = json.loads(sub.traces) if sub.traces else []
            except (json.JSONDecodeError, TypeError):
                history = []
            history.insert(0, entry)            # newest first
            sub.traces = json.dumps(history[:50])
            sub.last_trace = json.dumps(entry)
            sub.last_ok = not ctx["errors"]
            session.commit()
    return ctx


def _run_node(session, form, schema, ntype, ndata, ctx):
    # Drawflow lowercases df-* attribute names in the DOM, so node data keys come
    # back lowercased (e.g. 'emailid', 'shownavigate'). Normalise to be safe.
    ndata = {str(k).lower(): v for k, v in (ndata or {}).items()}
    if ntype == "button_start":
        ctx["log"].append(f"▶ Button clicked: {ndata.get('label', '')}")

    elif ntype == "validate":
        missing = []
        role, stage = ctx["role"], ctx["stage"]
        vis = ctx.get("visible_keys")
        for field, section in _iter_fields(schema):
            if field.get("type") not in FIELD_TYPES or not field.get("required"):
                continue
            # only validate fields the user can actually see for this role/stage
            if not _effective_visible(field, section, role, stage):
                continue
            # honour the client's effective-visibility (covers formula-based rules)
            if vis is not None and field.get("key") not in vis:
                continue
            if not str(ctx["data"].get(field.get("key"), "")).strip():
                missing.append(field.get("label") or field.get("key"))
        if missing:
            ctx["errors"].extend([f"'{m}' is required." for m in missing])
            ctx["log"].append(f"✖ Validation failed: {', '.join(missing)}")
            ctx["stopped"] = True
        else:
            ctx["log"].append("✔ Validation passed.")

    elif ntype == "set_stage":
        ctx["stage"] = ndata.get("stage", "")
        ctx["log"].append(f"→ Stage set to '{ctx['stage']}'.")

    elif ntype == "set_value":
        key = ndata.get("key")
        val = _template(ndata.get("value", ""), ctx["data"])
        if key:
            ctx["data"][key] = val
            ctx["log"].append(f"= Set '{key}' = '{val}'.")

    elif ntype == "save":
        if ctx.get("preview"):
            ctx["data"].setdefault("uuid", "PREVIEW-" + secrets.token_hex(4))
            ctx["log"].append("💾 (preview) submission would be saved — not persisted.")
            return
        sub_id = ctx.get("saved_submission_id")
        sub = session.get(Submission, sub_id) if sub_id else None
        # single-submission rule: block a duplicate before creating/saving
        dup = _single_submission_conflict(session, form, schema, ctx["data"],
                                          sub.id if sub else None)
        if dup:
            ctx["errors"].append(dup)
            ctx["log"].append(f"✖ {dup} — flow stopped.")
            ctx["stopped"] = True
            return
        if sub is None:
            sub = Submission(form_id=form.id, version_id=form.published_version_id)
            session.add(sub)
        if not sub.uuid:
            sub.uuid = gen_uuid()
        ctx["data"]["uuid"] = sub.uuid
        sub.data_json = json.dumps(ctx["data"])
        sub.stage = ctx["stage"]
        sub.status = "submitted"
        session.commit()
        ctx["saved_submission_id"] = sub.id
        ctx["log"].append(f"\U0001f4be Saved submission {sub.uuid[:10]}… to database.")

    elif ntype == "send_email":
        tmpl = _find_email(schema, ndata.get("emailid"))
        if not tmpl:
            ctx["errors"].append("Send Email: no email template selected on the node.")
            ctx["log"].append("✖ Send Email: no template selected — flow stopped.")
            ctx["stopped"] = True
        else:
            attachments = []
            if tmpl.get("attachPdf") and ctx.get("pdf") and ctx["pdf"].get("b64"):
                attachments.append({"name": ctx["pdf"]["name"],
                                    "type": "application/pdf", "b64": ctx["pdf"]["b64"]})
            for key in (tmpl.get("attachFields") or []):
                fv = ctx["data"].get(key)
                if isinstance(fv, dict) and fv.get("data"):
                    b64 = fv["data"]
                    if isinstance(b64, str) and b64.startswith("data:") and "," in b64:
                        b64 = b64.split(",", 1)[1]
                    attachments.append({"name": fv.get("name", "file"),
                                        "type": fv.get("type") or "application/octet-stream",
                                        "b64": b64})
            recipient = _template(tmpl.get("recipient", ""), ctx["data"])
            subject = _template(tmpl.get("subject", ""), ctx["data"])
            bodytxt = _template(tmpl.get("body", ""), ctx["data"])
            bodyhtml = _template(tmpl.get("bodyHtml", ""), ctx["data"])
            if ctx.get("preview"):
                ctx["emails"].append({"recipient": recipient, "subject": subject,
                                      "body": bodytxt, "delivery": "preview (not sent)"})
                ctx["log"].append(f"✉ (preview) would send '{tmpl.get('name')}' to {recipient or '(no recipient)'}.")
                return
            mail = EmailLog(
                form_id=form.id, submission_id=ctx.get("saved_submission_id"),
                sender=_template(tmpl.get("sender", ""), ctx["data"]),
                recipient=recipient, subject=subject, body=bodytxt, body_html=bodyhtml,
                attachment=", ".join(a["name"] for a in attachments) or tmpl.get("attachment", ""))
            session.add(mail)
            session.commit()
            sent, detail = _deliver_email(session, mail, attachments, tmpl.get("account"))
            ed = mail.to_dict(); ed["delivered"] = sent; ed["delivery"] = detail
            ctx["emails"].append(ed)
            verb = "SENT" if sent else "NOT sent"
            ctx["log"].append(f"✉ Email '{tmpl.get('name')}' {verb} to {mail.recipient or '(no recipient)'} — {detail}.")
            # A configured-but-failed send halts the flow (so later nodes/dialogs don't run).
            if not sent and not str(detail).startswith("simulated"):
                ctx["errors"].append(f"Email could not be sent: {detail}")
                ctx["stopped"] = True

    elif ntype == "http":
        result = _http_call(ndata, ctx["data"])
        result["response"] = (result.get("text") or "")[:500]
        if result["error"]:
            ctx["log"].append(f"\U0001f310 HTTP {result['method']} {result['url']} → error: {result['error']}")
        else:
            ctx["log"].append(f"\U0001f310 HTTP {result['method']} {result['url']} → {result['status']}")
        ctx["http"].append(result)
        if result["error"] or (result.get("status") and result["status"] >= 400):
            ctx["errors"].append(f"HTTP request failed: {result['error'] or ('status ' + str(result['status']))}")
            ctx["stopped"] = True

    elif ntype == "navigate":
        url = _template(ndata.get("url", ""), ctx["data"])
        ctx["navigate"] = {"url": url, "newtab": str(ndata.get("newtab", "no")) == "yes"}
        ctx["log"].append(f"➡ Navigate to {url}")

    elif ntype == "dialog":
        def _on(key, default):
            return str(ndata.get(key, default)) != "no"
        ctx["dialogs"].append({
            "header": _template(ndata.get("header", ""), ctx["data"]),
            "body": _template(ndata.get("body", ""), ctx["data"]),
            "buttons": [
                {"action": "navigate",
                 "label": ndata.get("navigatelabel") or "Navigate",
                 "url": _template(ndata.get("navigateurl", ""), ctx["data"]),
                 "enabled": _on("shownavigate", "no")},
                {"action": "closeTab",
                 "label": ndata.get("closetablabel") or "Close tab",
                 "enabled": _on("showclosetab", "yes")},
                {"action": "dismiss",
                 "label": ndata.get("dismisslabel") or "OK",
                 "enabled": _on("showdismiss", "no")},
            ],
        })
        ctx["log"].append(f"\U0001f5d4 Dialog shown: {ndata.get('header', '')}")

    else:
        ctx["log"].append(f"(skipped unknown node type '{ntype}')")


# --------------------------------------------------------------------------- #
#  Submission extracts (CSV / XLSX) + scheduler
# --------------------------------------------------------------------------- #
META_COLS = ["id", "stage", "status", "created_at", "modified_by"]


def _fields_list(schema):
    return [f for f, _ in _iter_fields(schema) if f.get("type") in FIELD_TYPES]


def _extract_columns_default(schema):
    return ["id"] + [f["key"] for f in _fields_list(schema)] + ["stage", "status", "created_at", "modified_by"]


def _col_label(schema, key):
    if key in META_COLS:
        return {"id": "ID", "stage": "Stage", "status": "Status",
                "created_at": "Created", "modified_by": "Modified By"}[key]
    for f in _fields_list(schema):
        if f["key"] == key:
            return f.get("label", key)
    return key


def _cell(sub, key):
    if key == "id":
        return sub.id
    if key == "stage":
        return sub.stage or ""
    if key == "status":
        return sub.status or ""
    if key == "created_at":
        return sub.created_at.isoformat() if sub.created_at else ""
    if key == "modified_by":
        return sub.modified_by or ""
    v = sub.data_dict().get(key, "")
    if isinstance(v, dict):
        return v.get("name", "")
    return v


def _build_extract_bytes(session, form, columns, file_type):
    schema = form.schema_dict()
    head = [_col_label(schema, c) for c in columns]
    subs = (session.query(Submission).filter_by(form_id=form.id)
            .order_by(Submission.id.desc()).all())
    if file_type == "xlsx":
        from openpyxl import Workbook
        wb = Workbook(); ws = wb.active; ws.title = "Submissions"
        ws.append(head)
        for sub in subs:
            ws.append([_cell(sub, c) for c in columns])
        buf = io.BytesIO(); wb.save(buf)
        return buf.getvalue(), "xlsx"
    buf = io.StringIO(); w = csv.writer(buf)
    w.writerow(head)
    for sub in subs:
        w.writerow(["" if (v := _cell(sub, c)) is None else v for c in columns])
    return buf.getvalue().encode("utf-8-sig"), "csv"


def _compute_next_run(task):
    tz = ZoneInfo(task.timezone) if (ZoneInfo and task.timezone) else timezone.utc
    now = datetime.now(tz)
    cand = now.replace(second=0, microsecond=0)
    if task.schedule == "hourly":
        cand = cand.replace(minute=task.minute or 0)
        if cand <= now:
            cand += timedelta(hours=1)
    elif task.schedule == "daily":
        cand = cand.replace(hour=task.hour or 0, minute=task.minute or 0)
        if cand <= now:
            cand += timedelta(days=1)
    elif task.schedule == "weekly":
        cand = cand.replace(hour=task.hour or 0, minute=task.minute or 0)
        cand += timedelta(days=(task.weekday - cand.weekday()) % 7)
        if cand <= now:
            cand += timedelta(days=7)
    elif task.schedule == "monthly":
        def set_day(dt):
            last = calendar.monthrange(dt.year, dt.month)[1]
            return dt.replace(day=min(task.day or 1, last), hour=task.hour or 0,
                              minute=task.minute or 0)
        cand = set_day(cand)
        if cand <= now:
            y, m = (cand.year + (1 if cand.month == 12 else 0),
                    1 if cand.month == 12 else cand.month + 1)
            cand = set_day(cand.replace(year=y, month=m, day=1))
    else:
        return None
    return cand.astimezone(timezone.utc).replace(tzinfo=None)


def _run_extract_task(task_id):
    s = SessionLocal()
    try:
        task = s.get(ExtractTask, task_id)
        if not task:
            return
        form = s.get(Form, task.form_id)
        if not form:
            return
        cols = json.loads(task.columns or "[]") or _extract_columns_default(form.schema_dict())
        content, ext = _build_extract_bytes(s, form, cols, task.file_type)
        folder = task.folder_path or os.path.join(BASE_DIR, "extracts")
        os.makedirs(folder, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(folder, f"{form.name.replace(' ', '_')}_{ts}.{ext}")
        with open(path, "wb") as fh:
            fh.write(content)
        task.last_run = datetime.utcnow()
        task.next_run = _compute_next_run(task)
        s.commit()
        print(f"[extract] wrote {path}")
        return path
    except Exception as exc:  # noqa: BLE001
        print("[extract] error:", exc)
    finally:
        s.close()


def _scheduler_loop():
    while True:
        try:
            s = SessionLocal()
            now = datetime.utcnow()
            due = (s.query(ExtractTask)
                   .filter(ExtractTask.active == True,  # noqa: E712
                           ExtractTask.next_run.isnot(None),
                           ExtractTask.next_run <= now).all())
            ids = [t.id for t in due]
            s.close()
            for tid in ids:
                _run_extract_task(tid)
        except Exception as exc:  # noqa: BLE001
            print("[scheduler] error:", exc)
        time.sleep(30)


_sched_started = False


def _start_scheduler():
    global _sched_started
    if _sched_started:
        return
    _sched_started = True
    threading.Thread(target=_scheduler_loop, daemon=True).start()


# --------------------------------------------------------------------------- #
#  Flask app
# --------------------------------------------------------------------------- #
app = Flask(__name__)
# Cache static assets (logo, css, js) in the browser so they are not
# re-fetched/revalidated on every page navigation (avoids the banner/logo flash).
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 86400  # 1 day


@app.context_processor
def _asset_version():
    """A version stamp (latest css/js mtime) appended to asset URLs as ?v=…
    so the 1-day browser cache is busted automatically whenever a file changes
    — without giving up caching for unchanged assets."""
    import glob
    latest = 0
    for pat in ("css/*.css", "js/*.js"):
        for f in glob.glob(os.path.join(app.static_folder, pat)):
            try:
                latest = max(latest, int(os.path.getmtime(f)))
            except OSError:
                pass
    return {"asset_ver": latest}


def body():
    return request.get_json(force=True, silent=True) or {}


def get_or_404(s, model, ident):
    obj = s.get(model, ident)
    if obj is None:
        abort(404, description=f"{model.__name__} {ident} not found")
    return obj


def _blank_rules():
    return {"visibleRoles": [], "visibleStages": [],
            "readonlyRoles": [], "readonlyStages": []}


DEFAULT_SCHEMA = {
    "elements": [
        {"id": "btn_submit", "type": "button", "key": "submit", "label": "Submit",
         "style": "primary", "rules": _blank_rules()},
    ],
    "roles": [{"id": "role_user", "name": "User"}],
    "stages": [{"id": "stage_draft", "name": "Draft"},
               {"id": "stage_review", "name": "In Review"},
               {"id": "stage_done", "name": "Completed"}],
    "emails": [],
    "summaryColumns": [],
}


# ---- Page routes ---------------------------------------------------------- #
@app.route("/")
def landing():
    return render_template("landing.html")


@app.route("/projects/<int:project_id>")
def project_page(project_id):
    return render_template("project.html", project_id=project_id)


@app.route("/forms/<int:form_id>/design")
def designer_page(form_id):
    return render_template("designer.html", form_id=form_id)


@app.route("/forms/<int:form_id>/summary")
def summary_page(form_id):
    return render_template("summary.html", form_id=form_id)


@app.route("/forms/<int:form_id>/fill")
def fill_page(form_id):
    return render_template("fill.html", form_id=form_id)


@app.route("/settings")
def settings_page():
    return render_template("settings.html")


# ---- Projects API --------------------------------------------------------- #
@app.get("/api/projects")
def list_projects():
    show_archived = request.args.get("archived") == "1"
    s = SessionLocal()
    try:
        rows = (s.query(Project)
                .filter(Project.archived == show_archived)
                .order_by(Project.id.desc()).all())
        return jsonify([p.to_dict() for p in rows])
    finally:
        s.close()


@app.post("/api/projects")
def create_project():
    d = body()
    if not d.get("name", "").strip():
        abort(400, description="Project name is required")
    s = SessionLocal()
    try:
        p = Project(name=d["name"].strip(), description=d.get("description", ""))
        s.add(p)
        s.commit()
        return jsonify(p.to_dict()), 201
    finally:
        s.close()


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    s = SessionLocal()
    try:
        p = get_or_404(s, Project, pid)
        data = p.to_dict()
        # Return ALL forms (with their archived flag) — the client decides what to
        # show: active forms in an active project, or every form in an archived one.
        data["forms"] = [f.to_dict() for f in sorted(p.forms, key=lambda x: x.id, reverse=True)]
        return jsonify(data)
    finally:
        s.close()


@app.post("/api/projects/<int:pid>/archive")
def archive_project(pid):
    archived = bool(body().get("archived", True))
    s = SessionLocal()
    try:
        p = get_or_404(s, Project, pid)
        p.archived = archived
        s.commit()
        return jsonify(p.to_dict())
    finally:
        s.close()


@app.post("/api/projects/<int:pid>/restore-all")
def restore_project_all(pid):
    """Restore the whole project: project active + all its forms active."""
    s = SessionLocal()
    try:
        p = get_or_404(s, Project, pid)
        p.archived = False
        for f in p.forms:
            f.archived = False
        s.commit()
        return jsonify(p.to_dict())
    finally:
        s.close()


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    s = SessionLocal()
    try:
        s.delete(get_or_404(s, Project, pid))
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


# ---- Forms API ------------------------------------------------------------ #
@app.post("/api/projects/<int:pid>/forms")
def create_form(pid):
    d = body()
    if not d.get("name", "").strip():
        abort(400, description="Form name is required")
    s = SessionLocal()
    try:
        get_or_404(s, Project, pid)
        f = Form(project_id=pid, name=d["name"].strip(),
                 working_schema=json.dumps(DEFAULT_SCHEMA),
                 working_workflow=json.dumps({}))
        s.add(f)
        s.commit()
        return jsonify(f.to_dict()), 201
    finally:
        s.close()


@app.get("/api/forms/<int:fid>")
def get_form(fid):
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        data = f.to_dict()
        data["project_name"] = f.project.name
        data["schema"] = f.schema_dict()
        data["workflow"] = f.workflow_dict()
        data["versions"] = [v.to_dict() for v in
                            sorted(f.versions, key=lambda x: x.version_no, reverse=True)]
        return jsonify(data)
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/save")
def save_form(fid):
    d = body()
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        if f.status == "published":
            abort(409, description="Form is published. Unpublish before editing.")
        if "schema" in d:
            f.working_schema = json.dumps(d["schema"])
        if "workflow" in d:
            f.working_workflow = json.dumps(d["workflow"])
        if d.get("name"):
            f.name = d["name"].strip()
        s.commit()
        return jsonify(f.to_dict())
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/publish")
def publish_form(fid):
    d = body()
    migrate = bool(d.get("migrate", False))
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        last = (s.query(FormVersion).filter_by(form_id=fid)
                .order_by(FormVersion.version_no.desc()).first())
        next_no = (last.version_no + 1) if last else 1
        version = FormVersion(form_id=fid, version_no=next_no,
                              schema_json=f.working_schema,
                              workflow_json=f.working_workflow)
        s.add(version)
        s.flush()
        had_previous = f.published_version_id is not None
        f.published_version_id = version.id
        f.status = "published"
        migrated = 0
        if had_previous and migrate:
            for sub in s.query(Submission).filter_by(form_id=fid).all():
                sub.version_id = version.id
                migrated += 1
        s.commit()
        return jsonify({"ok": True, "version_no": next_no,
                        "published_version_id": version.id,
                        "had_previous": had_previous,
                        "migrated_submissions": migrated,
                        "form": f.to_dict()})
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/unpublish")
def unpublish_form(fid):
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        f.status = "draft"
        s.commit()
        return jsonify(f.to_dict())
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/versions/<int:vid>/restore")
def restore_version(fid, vid):
    """Load a previously published version's schema/flow back into the working
    copy and unpublish, so the user can review and re-publish it."""
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        v = get_or_404(s, FormVersion, vid)
        if v.form_id != fid:
            abort(400, description="Version does not belong to this form")
        f.working_schema = v.schema_json
        f.working_workflow = v.workflow_json
        f.status = "draft"
        s.commit()
        return jsonify({"ok": True, "restored_version_no": v.version_no,
                        "form": f.to_dict()})
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/archive")
def archive_form(fid):
    archived = bool(body().get("archived", True))
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        f.archived = archived
        s.commit()
        return jsonify(f.to_dict())
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/restore-only")
def restore_form_only(fid):
    """Restore the project but keep only THIS form active (siblings archived)."""
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        proj = f.project
        proj.archived = False
        for sib in proj.forms:
            sib.archived = (sib.id != fid)
        s.commit()
        return jsonify(f.to_dict())
    finally:
        s.close()


@app.delete("/api/forms/<int:fid>")
def delete_form(fid):
    s = SessionLocal()
    try:
        s.delete(get_or_404(s, Form, fid))
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/duplicate")
def duplicate_form(fid):
    """Copy a form's design + workflow (+ lookups) into a new draft form."""
    d = body()
    s = SessionLocal()
    try:
        src = get_or_404(s, Form, fid)
        name = (d.get("name") or (src.name + " (copy)")).strip()
        if not name:
            abort(400, description="A name is required")
        nf = Form(project_id=src.project_id, name=name,
                  working_schema=src.working_schema,
                  working_workflow=src.working_workflow)
        s.add(nf)
        s.flush()
        for lt in src.lookups:
            s.add(LookupTable(form_id=nf.id, name=lt.name, key_column=lt.key_column,
                              key_component=lt.key_component, columns=lt.columns,
                              rows=lt.rows, mappings=lt.mappings))
        s.commit()
        return jsonify(nf.to_dict()), 201
    finally:
        s.close()


@app.route("/api/forms/<int:fid>/export", methods=["GET", "POST"])
def export_form(fid):
    """Export the form as portable JSON. A POST body may carry
    ``{"include": {schema, workflow, lookups, submissions, versions}}`` to choose
    sections; a GET (or no flags) exports everything."""
    inc = (body().get("include") if request.method == "POST" else None)
    want = (lambda k: True) if not isinstance(inc, dict) else (lambda k: bool(inc.get(k, False)))
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        payload = {
            "foms_export": True, "export_version": 1,
            "exported_at": datetime.utcnow().isoformat(),
            "name": f.name, "status": f.status,
        }
        if want("schema"):
            payload["schema"] = f.schema_dict()
        if want("workflow"):
            payload["workflow"] = f.workflow_dict()
        if want("versions"):
            payload["versions"] = [v.to_dict(include_payload=True)
                                   for v in sorted(f.versions, key=lambda x: x.version_no)]
        if want("submissions"):
            payload["submissions"] = [sub.to_dict() for sub in
                                      sorted(f.submissions, key=lambda x: x.id)]
            payload["email_logs"] = [e.to_dict() for e in
                                     sorted(f.email_logs, key=lambda x: x.id)]
        if want("lookups"):
            payload["lookups"] = [lt.to_dict(include_rows=True) for lt in f.lookups]
            payload["extract_tasks"] = [t.to_dict() for t in f.extract_tasks]
        from flask import Response
        fname = re.sub(r"[^A-Za-z0-9_-]+", "_", f.name).strip("_") or "form"
        return Response(json.dumps(payload, indent=2), mimetype="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{fname}_export.json"'})
    finally:
        s.close()


@app.post("/api/projects/<int:pid>/import")
def import_form(pid):
    """Create a new form from a JSON export (schema + workflow + data)."""
    d = body()
    s = SessionLocal()
    try:
        get_or_404(s, Project, pid)
        payload = d.get("payload") if isinstance(d.get("payload"), dict) else d
        if not isinstance(payload, dict) or "schema" not in payload:
            abort(400, description="Not a valid FOMS form export (missing schema).")
        name = (d.get("name") or payload.get("name") or "Imported form").strip()
        f = Form(project_id=pid, name=name,
                 working_schema=json.dumps(payload.get("schema") or {}),
                 working_workflow=json.dumps(payload.get("workflow") or {}))
        s.add(f)
        s.flush()
        vmap = {}
        for v in (payload.get("versions") or []):
            nv = FormVersion(form_id=f.id, version_no=v.get("version_no") or (len(vmap) + 1),
                             schema_json=json.dumps(v.get("schema") or {}),
                             workflow_json=json.dumps(v.get("workflow") or {}))
            s.add(nv)
            s.flush()
            vmap[v.get("id")] = nv.id
        for sub in (payload.get("submissions") or []):
            s.add(Submission(form_id=f.id, uuid=gen_uuid(),
                             version_id=vmap.get(sub.get("version_id")),
                             data_json=json.dumps(sub.get("data") or {}),
                             stage=sub.get("stage", ""),
                             status=sub.get("status", "submitted"),
                             modified_by=sub.get("modified_by", "")))
        for lt in (payload.get("lookups") or []):
            s.add(LookupTable(form_id=f.id, name=lt.get("name", "Lookup"),
                              key_column=lt.get("key_column", ""),
                              key_component=lt.get("key_component", ""),
                              columns=json.dumps(lt.get("columns") or []),
                              rows=json.dumps(lt.get("rows") or []),
                              mappings=json.dumps(lt.get("mappings") or [])))
        s.commit()
        return jsonify(f.to_dict()), 201
    finally:
        s.close()


@app.get("/api/forms/<int:fid>/runtime")
def form_runtime(fid):
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        if f.published_version_id:
            v = s.get(FormVersion, f.published_version_id)
            schema = json.loads(v.schema_json or "{}")
            workflow = json.loads(v.workflow_json or "{}")
            version_id = v.id
        else:
            schema = f.schema_dict()
            workflow = f.workflow_dict()
            version_id = None
        lookups = [lt.to_dict(include_rows=True) for lt in f.lookups
                   if lt.key_column and lt.key_component]
        return jsonify({"form": f.to_dict(), "project_name": f.project.name,
                        "schema": schema, "workflow": workflow,
                        "version_id": version_id, "lookups": lookups})
    finally:
        s.close()


def _parse_table(file_storage):
    fn = (file_storage.filename or "").lower()
    raw = file_storage.read()
    if fn.endswith(".xlsx"):
        from openpyxl import load_workbook
        wb = load_workbook(filename=io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        headers = [str(h) if h is not None else f"col{i}" for i, h in enumerate(next(it, []))]
        out = []
        for r in it:
            out.append({headers[i]: ("" if v is None else v) for i, v in enumerate(r) if i < len(headers)})
        return headers, out
    text = raw.decode("utf-8-sig", errors="replace")
    rdr = csv.DictReader(io.StringIO(text))
    headers = list(rdr.fieldnames or [])
    return headers, [dict(r) for r in rdr]


@app.post("/api/forms/<int:fid>/lookups")
def upload_lookup(fid):
    s = SessionLocal()
    try:
        get_or_404(s, Form, fid)
        file = request.files.get("file")
        if not file:
            abort(400, description="No file uploaded")
        cols, rows = _parse_table(file)
        if not cols:
            abort(400, description="Could not read columns from the file")
        lt = LookupTable(form_id=fid, name=(file.filename or "Lookup"),
                         columns=json.dumps(cols), rows=json.dumps(rows),
                         key_column=cols[0])
        s.add(lt)
        s.commit()
        return jsonify(lt.to_dict()), 201
    finally:
        s.close()


@app.get("/api/forms/<int:fid>/lookups")
def list_lookups(fid):
    s = SessionLocal()
    try:
        rows = s.query(LookupTable).filter_by(form_id=fid).order_by(LookupTable.id.desc()).all()
        inc = request.args.get("rows") == "1"
        return jsonify([lt.to_dict(include_rows=inc) for lt in rows])
    finally:
        s.close()


@app.put("/api/lookups/<int:lid>")
def update_lookup(lid):
    d = body()
    s = SessionLocal()
    try:
        lt = get_or_404(s, LookupTable, lid)
        if "name" in d:
            lt.name = d["name"]
        if "key_column" in d:
            lt.key_column = d["key_column"]
        if "key_component" in d:
            lt.key_component = d["key_component"]
        if "mappings" in d:
            lt.mappings = json.dumps(d["mappings"])
        s.commit()
        return jsonify(lt.to_dict())
    finally:
        s.close()


@app.delete("/api/lookups/<int:lid>")
def delete_lookup(lid):
    s = SessionLocal()
    try:
        s.delete(get_or_404(s, LookupTable, lid))
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


# ---- Submissions API ------------------------------------------------------ #
@app.get("/api/forms/<int:fid>/submissions")
def list_submissions(fid):
    s = SessionLocal()
    try:
        get_or_404(s, Form, fid)
        rows = (s.query(Submission).filter_by(form_id=fid)
                .order_by(Submission.id.desc()).all())
        return jsonify([r.to_dict() for r in rows])
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/submissions")
def create_submission(fid):
    d = body()
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        sub = Submission(form_id=fid, version_id=f.published_version_id,
                         data_json=json.dumps(d.get("data", {})),
                         stage=d.get("stage", ""),
                         status=d.get("status", "draft"))
        s.add(sub)
        s.commit()
        return jsonify(sub.to_dict()), 201
    finally:
        s.close()


@app.get("/api/submissions/<int:sid>")
def get_submission(sid):
    s = SessionLocal()
    try:
        return jsonify(get_or_404(s, Submission, sid).to_dict())
    finally:
        s.close()


@app.get("/api/submissions/resolve/<ref>")
def resolve_submission(ref):
    """Look up a submission by UUID (preferred) or numeric id."""
    s = SessionLocal()
    try:
        sub = s.query(Submission).filter_by(uuid=ref).first()
        if not sub and ref.isdigit():
            sub = s.get(Submission, int(ref))
        if not sub:
            abort(404, description="Submission not found")
        return jsonify(sub.to_dict())
    finally:
        s.close()


@app.put("/api/submissions/<int:sid>")
def update_submission(sid):
    d = body()
    s = SessionLocal()
    try:
        sub = get_or_404(s, Submission, sid)
        if "data" in d:
            sub.data_json = json.dumps(d["data"])
        if "stage" in d:
            sub.stage = d["stage"]
        if "status" in d:
            sub.status = d["status"]
        if "modified_by" in d:
            sub.modified_by = d["modified_by"]
        s.commit()
        return jsonify(sub.to_dict())
    finally:
        s.close()


@app.delete("/api/submissions/<int:sid>")
def delete_submission(sid):
    s = SessionLocal()
    try:
        s.delete(get_or_404(s, Submission, sid))
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/run-button")
def run_button(fid):
    d = body()
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        version = s.get(FormVersion, f.published_version_id) if f.published_version_id else None
        submission = s.get(Submission, d["submission_id"]) if d.get("submission_id") else None
        result = execute_button(s, f, version, d.get("button_key"),
                                d.get("data", {}), d.get("role", ""),
                                d.get("stage", ""), submission,
                                visible_keys=d.get("visible_keys"),
                                pdf_base64=d.get("pdf_base64"),
                                pdf_filename=d.get("pdf_filename"))
        # drop the (possibly large) pdf echo from the response
        result.pop("pdf", None)
        return jsonify(result)
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/preview-run")
def preview_run(fid):
    """Run a button against the WORKING (unpublished) design+workflow without
    persisting anything — for the designer's Preview / Test tab."""
    d = body()
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        result = execute_button(s, f, None, d.get("button_key"), d.get("data", {}),
                                d.get("role", ""), d.get("stage", ""), None,
                                visible_keys=d.get("visible_keys"), preview=True)
        result.pop("pdf", None)
        return jsonify(result)
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/http-fetch")
def http_fetch(fid):
    """Run an in-form API Fetch component server-side (avoids CORS, reuses auth)
    and return the parsed JSON so the client can map values into form fields."""
    d = body()
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        if f.published_version_id:
            schema = json.loads(s.get(FormVersion, f.published_version_id).schema_json or "{}")
        else:
            schema = f.schema_dict()
        comp = _find_http_component(schema, d.get("key"))
        if not comp:
            abort(404, description="API Fetch component not found")
        res = _http_call(comp, d.get("data") or {})
        ok = res["error"] is None and (res.get("status") or 0) < 400
        return jsonify({"ok": ok, "status": res["status"], "error": res["error"],
                        "json": res["json"], "text": (res["text"] or "")[:2000]})
    finally:
        s.close()


@app.get("/api/forms/<int:fid>/emails")
def list_emails(fid):
    s = SessionLocal()
    try:
        rows = (s.query(EmailLog).filter_by(form_id=fid)
                .order_by(EmailLog.id.desc()).all())
        return jsonify([r.to_dict() for r in rows])
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/extract")
def extract_now(fid):
    """Immediate extract -> returns the file for download."""
    d = body()
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        cols = d.get("columns") or _extract_columns_default(f.schema_dict())
        ftype = "xlsx" if d.get("file_type") == "xlsx" else "csv"
        content, ext = _build_extract_bytes(s, f, cols, ftype)
        from flask import Response
        fname = f"{f.name.replace(' ', '_')}_submissions.{ext}"
        mime = ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                if ext == "xlsx" else "text/csv")
        return Response(content, mimetype=mime,
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})
    finally:
        s.close()


EMAIL_EXTRACT_LABELS = {"id": "ID", "sender": "Sender", "recipient": "Recipient",
                        "subject": "Subject", "body": "Body", "attachment": "Attachment",
                        "sent_at": "Sent At"}


def _build_email_bytes(session, fid, columns, file_type):
    head = [EMAIL_EXTRACT_LABELS.get(c, c) for c in columns]
    rows = (session.query(EmailLog).filter_by(form_id=fid)
            .order_by(EmailLog.id.desc()).all())

    def cell(e, c):
        if c == "sent_at":
            return e.sent_at.isoformat() if e.sent_at else ""
        return getattr(e, c, "")

    if file_type == "xlsx":
        from openpyxl import Workbook
        wb = Workbook(); ws = wb.active; ws.title = "Emails"; ws.append(head)
        for e in rows:
            ws.append([cell(e, c) for c in columns])
        buf = io.BytesIO(); wb.save(buf)
        return buf.getvalue(), "xlsx"
    buf = io.StringIO(); w = csv.writer(buf); w.writerow(head)
    for e in rows:
        w.writerow([cell(e, c) for c in columns])
    return buf.getvalue().encode("utf-8-sig"), "csv"


@app.post("/api/forms/<int:fid>/emails/extract")
def extract_emails(fid):
    d = body()
    cols = d.get("columns") or list(EMAIL_EXTRACT_LABELS.keys())
    ftype = "xlsx" if d.get("file_type") == "xlsx" else "csv"
    s = SessionLocal()
    try:
        f = get_or_404(s, Form, fid)
        content, ext = _build_email_bytes(s, fid, cols, ftype)
        from flask import Response
        fname = f"{f.name.replace(' ', '_')}_emails.{ext}"
        mime = ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                if ext == "xlsx" else "text/csv")
        return Response(content, mimetype=mime,
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})
    finally:
        s.close()


def _apply_task_fields(task, d):
    task.name = d.get("name", task.name or "Extract")
    if "columns" in d:
        task.columns = json.dumps(d["columns"])
    task.file_type = "xlsx" if d.get("file_type") == "xlsx" else "csv"
    task.folder_path = d.get("folder_path", task.folder_path or "")
    task.schedule = d.get("schedule", task.schedule or "daily")
    task.minute = int(d.get("minute", task.minute or 0) or 0)
    task.hour = int(d.get("hour", task.hour or 0) or 0)
    task.weekday = int(d.get("weekday", task.weekday or 0) or 0)
    task.day = int(d.get("day", task.day or 1) or 1)
    task.timezone = d.get("timezone", task.timezone or "UTC")
    if "active" in d:
        task.active = bool(d["active"])


@app.get("/api/forms/<int:fid>/extract-tasks")
def list_extract_tasks(fid):
    s = SessionLocal()
    try:
        rows = (s.query(ExtractTask).filter_by(form_id=fid)
                .order_by(ExtractTask.id.desc()).all())
        return jsonify([t.to_dict() for t in rows])
    finally:
        s.close()


@app.post("/api/forms/<int:fid>/extract-tasks")
def create_extract_task(fid):
    d = body()
    s = SessionLocal()
    try:
        get_or_404(s, Form, fid)
        task = ExtractTask(form_id=fid)
        _apply_task_fields(task, d)
        task.next_run = _compute_next_run(task)
        s.add(task)
        s.commit()
        return jsonify(task.to_dict()), 201
    finally:
        s.close()


@app.put("/api/extract-tasks/<int:tid>")
def update_extract_task(tid):
    d = body()
    s = SessionLocal()
    try:
        task = get_or_404(s, ExtractTask, tid)
        _apply_task_fields(task, d)
        task.next_run = _compute_next_run(task)
        s.commit()
        return jsonify(task.to_dict())
    finally:
        s.close()


@app.delete("/api/extract-tasks/<int:tid>")
def delete_extract_task(tid):
    s = SessionLocal()
    try:
        s.delete(get_or_404(s, ExtractTask, tid))
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


@app.post("/api/extract-tasks/<int:tid>/run")
def run_extract_task_now(tid):
    path = _run_extract_task(tid)
    return jsonify({"ok": bool(path), "path": path})


def _mask_account(a):
    return {
        "id": a.get("id"), "name": a.get("name") or a.get("from_email") or "Account",
        "provider": a.get("provider") or "none",
        "from_email": a.get("from_email") or "", "from_name": a.get("from_name") or "",
        "smtp_host": a.get("smtp_host") or "", "smtp_port": a.get("smtp_port") or "587",
        "smtp_user": a.get("smtp_user") or "", "smtp_tls": a.get("smtp_tls", "1"),
        "has_sendgrid_key": bool(a.get("sendgrid_api_key")),
        "has_smtp_pass": bool(a.get("smtp_pass")),
    }


@app.get("/api/settings")
def get_settings():
    s = SessionLocal()
    try:
        return jsonify({"accounts": [_mask_account(a) for a in _email_accounts(s)]})
    finally:
        s.close()


# Sender accounts that other pages (email template editor) can list.
@app.get("/api/email-accounts")
def list_email_accounts():
    s = SessionLocal()
    try:
        return jsonify([{"id": a.get("id"), "name": a.get("name") or a.get("from_email"),
                         "from_email": a.get("from_email")} for a in _email_accounts(s)])
    finally:
        s.close()


@app.post("/api/settings")
def save_settings():
    """Body: {accounts:[{id,name,provider,from_email,from_name,sendgrid_api_key,
    smtp_*}]}. Secrets left blank keep their previous value."""
    d = body()
    s = SessionLocal()
    try:
        existing = {str(a.get("id")): a for a in _email_accounts(s)}
        out = []
        for a in d.get("accounts", []):
            aid = str(a.get("id") or gen_uuid()[:8])
            prev = existing.get(aid, {})
            out.append({
                "id": aid,
                "name": a.get("name") or a.get("from_email") or "Account",
                "provider": a.get("provider") or "none",
                "from_email": a.get("from_email") or "",
                "from_name": a.get("from_name") or "",
                "sendgrid_api_key": a.get("sendgrid_api_key") or prev.get("sendgrid_api_key", ""),
                "smtp_host": a.get("smtp_host") or "",
                "smtp_port": a.get("smtp_port") or "587",
                "smtp_user": a.get("smtp_user") or "",
                "smtp_pass": a.get("smtp_pass") or prev.get("smtp_pass", ""),
                "smtp_tls": a.get("smtp_tls", "1"),
            })
        _set_setting(s, "email_accounts", json.dumps(out))
        s.commit()
        return jsonify({"ok": True, "accounts": [_mask_account(a) for a in out]})
    finally:
        s.close()


@app.get("/api/master")
def master_data():
    """Read-only aggregate of every project/form/submission/email across the
    whole portal, for the Settings → Master database view."""
    s = SessionLocal()
    try:
        projects = s.query(Project).order_by(Project.id).all()
        forms = s.query(Form).order_by(Form.id).all()
        subs = s.query(Submission).order_by(Submission.id.desc()).all()
        emails = s.query(EmailLog).order_by(EmailLog.id.desc()).all()
        proj_name = {p.id: p.name for p in projects}
        form_name = {f.id: f.name for f in forms}
        form_proj = {f.id: f.project_id for f in forms}
        return jsonify({
            "projects": [{
                "id": p.id, "name": p.name, "description": p.description or "",
                "archived": bool(p.archived),
                "form_count": len([f for f in forms if f.project_id == p.id]),
                "created_at": p.created_at.isoformat() if p.created_at else None,
            } for p in projects],
            "forms": [{
                "id": f.id, "name": f.name,
                "project_id": f.project_id, "project_name": proj_name.get(f.project_id, ""),
                "status": f.status, "archived": bool(f.archived),
                "submission_count": len(f.submissions),
                "updated_at": f.updated_at.isoformat() if f.updated_at else None,
            } for f in forms],
            "submissions": [{
                "id": x.id, "uuid": x.uuid or "",
                "form_id": x.form_id, "form_name": form_name.get(x.form_id, ""),
                "project_name": proj_name.get(form_proj.get(x.form_id), ""),
                "stage": x.stage or "", "status": x.status or "",
                "modified_by": x.modified_by or "",
                "data": x.data_dict(),
                "created_at": x.created_at.isoformat() if x.created_at else None,
                "updated_at": x.updated_at.isoformat() if x.updated_at else None,
            } for x in subs],
            "emails": [e.to_dict() for e in emails],
        })
    finally:
        s.close()


@app.post("/api/settings/test")
def test_settings():
    d = body()
    to = (d.get("to") or "").strip()
    if not to:
        abort(400, description="Provide a recipient address to test")
    s = SessionLocal()
    try:
        mail = EmailLog(form_id=0, recipient=to, subject="FOMS test email",
                        body="This is a test email sent from the FOMS portal Settings page.",
                        sender="")
        sent, detail = _deliver_email(s, mail, None, d.get("account_id"))
        return jsonify({"sent": sent, "detail": detail})
    finally:
        s.close()


if __name__ == "__main__":
    # Bind to 127.0.0.1 (localhost only) so the app is reachable ONLY from this
    # machine — not from other devices on the LAN and not from the internet.
    # Override with env vars if needed: FOMS_HOST, FOMS_PORT, FOMS_DEBUG=1
    host = os.environ.get("FOMS_HOST", "127.0.0.1")
    port = int(os.environ.get("FOMS_PORT", "5000"))
    debug = os.environ.get("FOMS_DEBUG", "0") == "1"
    _start_scheduler()
    print(f"FOMS POC running — local only: http://127.0.0.1:{port}")
    app.run(host=host, port=port, debug=debug)
