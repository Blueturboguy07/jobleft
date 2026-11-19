#!/usr/bin/env python3
"""TCC rows for the live update proof (.github/workflows/live-update-proof.yml), on a GitHub macOS runner only.

  tcc.py schema <db>                                  prints the access table's schema (.schema access)
  tcc.py grant  <db> <service> <client> <csreq.bin>   writes an "allowed" row bound to the code requirement
  tcc.py show   <db> <service> <client> <out.bin>     prints the row as JSON and writes its csreq blob to out.bin

Columns come from the database itself (PRAGMA table_info), so the row fits the runner's macOS version. The row is
what tccd writes after a person clicks Allow: client_type 0 (a bundle id), auth_value 2 (allowed), auth_reason 2
(user consent), auth_version 1, and the binary code requirement in csreq.
"""
import json
import sqlite3
import sys
import time

ALLOWED, USER_CONSENT = 2, 2


def connect(db):
    return sqlite3.connect(db, timeout=10)


def schema(db):
    con = connect(db)
    rows = con.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'access'").fetchall()
    print(rows[0][0] if rows else "(no access table)")
    for cid, name, ctype, notnull, default, pk in con.execute("PRAGMA table_info(access)"):
        print(f"  column {cid}: {name} {ctype} notnull={notnull} default={default} pk={pk}")


def grant(db, service, client, csreq_path):
    with open(csreq_path, "rb") as f:
        csreq = f.read()
    if not csreq.startswith(b"\xfa\xde\x0c\x00"):
        sys.exit(f"{csreq_path} is not a compiled code requirement (csreq -b)")
    con = connect(db)
    cols = list(con.execute("PRAGMA table_info(access)"))
    known = {
        "service": service,
        "client": client,
        "client_type": 0,
        "auth_value": ALLOWED,
        "auth_reason": USER_CONSENT,
        "auth_version": 1,
        "csreq": csreq,
        "policy_id": None,
        "indirect_object_identifier_type": 0,
        "indirect_object_identifier": "UNUSED",
        "indirect_object_code_identity": None,
        "flags": 0,
        "last_modified": int(time.time()),
        "pid": None,
        "pid_version": None,
        "boot_uuid": "UNUSED",
        "last_reminded": 0,
        # Older schemas.
        "allowed": 1,
        "prompt_count": 1,
    }
    names, values = [], []
    for _cid, name, ctype, notnull, default, _pk in cols:
        if name in known:
            value = known[name]
        elif notnull and default is None:
            value = 0 if "INT" in (ctype or "").upper() else ""
        else:
            continue
        if value is None and notnull:
            value = 0 if "INT" in (ctype or "").upper() else ""
        names.append(name)
        values.append(value)
    missing = {"service", "client", "auth_value", "csreq"} - set(names)
    if missing:
        sys.exit(f"the access table has no column(s) {sorted(missing)}; schema: {[c[1] for c in cols]}")
    con.execute(
        f"INSERT OR REPLACE INTO access ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})", values
    )
    con.commit()
    print(f"granted {service} to {client} in {db} ({len(csreq)}-byte csreq; columns: {', '.join(names)})")


def show(db, service, client, out_path):
    con = connect(db)
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT * FROM access WHERE service = ? AND client = ?", (service, client)).fetchone()
    if row is None:
        print(json.dumps({"db": db, "service": service, "client": client, "present": False}))
        sys.exit(3)
    data = {"db": db, "present": True}
    for key in row.keys():
        value = row[key]
        if isinstance(value, bytes):
            if key == "csreq":
                with open(out_path, "wb") as f:
                    f.write(value)
            value = f"<{len(value)} bytes> {value.hex()[:32]}..."
        data[key] = value
    print(json.dumps(data))


def main(argv):
    if len(argv) >= 2 and argv[0] == "schema":
        schema(argv[1])
    elif len(argv) == 5 and argv[0] == "grant":
        grant(*argv[1:])
    elif len(argv) == 5 and argv[0] == "show":
        show(*argv[1:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
