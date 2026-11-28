"""End-to-end test against a running FOMS server (py "web-automation_app.py").

Covers: project/form CRUD, all page routes, the element model (sections +
buttons on the canvas), role/stage visibility, the hidden-field validation fix,
a full workflow (validate -> set_stage -> save -> send_email + popup dialog),
the published-edit lock, and unpublish -> re-publish-with-migrate.

Run with:  $env:PYTHONIOENCODING='utf-8'; py "web-automation_e2e.py"
"""
import json, urllib.request, urllib.error
BASE = "http://127.0.0.1:5000"

def req(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(BASE + path, data=body, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=10) as resp:
        return resp.status, json.loads(resp.read().decode())

def page(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as resp:
        return resp.status

def rules(vr=None, vs=None, rr=None, rs=None):
    return {"visibleRoles": vr or [], "visibleStages": vs or [],
            "readonlyRoles": rr or [], "readonlyStages": rs or []}

def node(i, name, data, nxt):
    return {"id": i, "name": name, "data": data, "class": "nd-" + name, "html": "", "typenode": False,
            "inputs": {} if name == "button_start" else {"input_1": {"connections": [{"node": str(i-1), "input": "output_1"}]}},
            "outputs": {"output_1": {"connections": ([{"node": str(nxt), "output": "input_1"}] if nxt else [])}},
            "pos_x": 100*i, "pos_y": 120}

# ---- setup ----
_, proj = req("POST", "/api/projects", {"name": "E2E"})
pid = proj["id"]
_, form = req("POST", f"/api/projects/{pid}/forms", {"name": "Leave Request"})
fid = form["id"]
print("pages:", [page(p) for p in (f"/", f"/projects/{pid}", f"/forms/{fid}/design",
                                   f"/forms/{fid}/summary", f"/forms/{fid}/fill")], "(all 200)")
print("default elements:", [e["type"] for e in req("GET", f"/api/forms/{fid}")[1]["schema"]["elements"]])

# ---- schema: top field (all) + Manager-only section + read-only field + button ----
schema = {
    "elements": [
        {"id": "c1", "type": "text", "key": "name", "label": "Name", "required": True, "options": [], "rules": rules()},
        {"id": "c2", "type": "email", "key": "email", "label": "Email", "required": True, "options": [], "rules": rules()},
        {"id": "c3", "type": "text", "key": "ref", "label": "Ref No", "required": False, "options": [],
         "rules": rules(rr=["Staff"])},  # read-only for Staff
        {"id": "sec1", "type": "section", "label": "Manager Only", "rules": rules(vr=["Manager"]),
         "children": [{"id": "c4", "type": "text", "key": "note", "label": "Manager Note",
                       "required": True, "options": [], "rules": rules()}]},
        {"id": "btn", "type": "button", "key": "submit", "label": "Submit", "style": "primary", "rules": rules()},
    ],
    "roles": [{"id": "r1", "name": "Manager"}, {"id": "r2", "name": "Staff"}],
    "stages": [{"id": "s1", "name": "Draft"}, {"id": "s2", "name": "In Review"}],
    "emails": [{"id": "em1", "name": "Confirm", "sender": "hr@acme.com", "recipient": "{{email}}",
                "subject": "Leave for {{name}}", "body": "Hi {{name}}, received.", "attachment": ""}],
    "summaryColumns": [],
}
graph = {"drawflow": {"Home": {"data": {
    "1": node(1, "button_start", {"label": "Submit", "key": "submit"}, 2),
    "2": node(2, "validate", {}, 3),
    "3": node(3, "set_stage", {"stage": "In Review"}, 4),
    "4": node(4, "save", {}, 5),
    "5": node(5, "send_email", {"emailId": "em1"}, 6),
    "6": node(6, "dialog", {"header": "Submitted", "body": "Thanks {{name}}!",
                            "showNavigate": "yes", "navigateLabel": "Portal", "navigateUrl": "https://example.com",
                            "showCloseTab": "yes", "closeTabLabel": "Close tab",
                            "showDismiss": "no", "dismissLabel": "OK"}, None),
}}}}
print("save:", req("POST", f"/api/forms/{fid}/save", {"schema": schema, "workflow": {"submit": graph}})[0])
print("publish v1:", req("POST", f"/api/forms/{fid}/publish", {"migrate": False})[1]["version_no"])

# ---- Staff: section hidden -> Manager Note not required ----
_, res = req("POST", f"/api/forms/{fid}/run-button",
             {"button_key": "submit", "data": {"name": "Bob", "email": "b@x.com"}, "role": "Staff", "stage": "Draft"})
print("\nStaff submit errors:", res["errors"], "(expect none — section hidden)")
print("  stage:", res["stage"], "| saved:", res["saved_submission_id"], "| emails:", len(res["emails"]))
dlg = res["dialogs"][0]
print("  dialog buttons:", [(b["action"], b["label"], b["enabled"]) for b in dlg["buttons"]])
nav = next(b for b in dlg["buttons"] if b["action"] == "navigate")
print("  navigate url:", nav["url"], "| enabled:", nav["enabled"])

# visible_keys: client says 'email' is hidden (e.g. formula) -> not required even though required
_, res2 = req("POST", f"/api/forms/{fid}/run-button",
              {"button_key": "submit", "data": {"name": "Ann"}, "role": "Staff", "stage": "Draft",
               "visible_keys": ["name"]})
print("visible_keys test errors:", res2["errors"], "(expect none — email reported hidden by client)")

# ---- Manager: section visible, note empty -> required ----
_, res = req("POST", f"/api/forms/{fid}/run-button",
             {"button_key": "submit", "data": {"name": "Bob", "email": "b@x.com"}, "role": "Manager", "stage": "Draft"})
print("Manager submit (note empty) errors:", res["errors"], "(expect Manager Note required)")

# ---- published-edit lock ----
print("save-while-published:", end=" ")
try:
    req("POST", f"/api/forms/{fid}/save", {"schema": schema}); print("NO ERROR (bug!)")
except urllib.error.HTTPError as e:
    print(e.code, "(expected 409)")

# ---- unpublish -> edit -> re-publish migrate ----
req("POST", f"/api/forms/{fid}/unpublish", {})
schema["elements"].insert(2, {"id": "c5", "type": "text", "key": "reason", "label": "Reason",
                              "required": False, "options": [], "rules": rules()})
req("POST", f"/api/forms/{fid}/save", {"schema": schema})
_, pub = req("POST", f"/api/forms/{fid}/publish", {"migrate": True})
print("re-publish v2:", pub["version_no"], "| migrated:", pub["migrated_submissions"], "| had_previous:", pub["had_previous"])

req("DELETE", f"/api/projects/{pid}")
print("\nCLEANED + DONE")
