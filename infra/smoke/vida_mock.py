"""
Server tiruan VIDA VSP OpenAPI untuk UAT/smoke test (kontrak API mengikuti docs.vida.id):
  POST /core/api/rest/v1/oauth2/token                         (form: grant_type=client_credentials, client_id, client_secret)
  POST /core/external-api/rest/v1/envelope                     (multipart: file, creator_email, envelope_details)
  POST /core/external-api/rest/v1/envelope/{id}/start-signature
  GET  /core/external-api/rest/v1/envelope/{id}/status
  GET  /document/external-api/rest/v1/envelope/{id}/signed-document
Kontrol uji: POST /_complete → semua envelope PENDING menjadi COMPLETED.
Pakai: python3 vida_mock.py <port> <client_id> <client_secret> <signed_pdf_path>
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

PORT, CID, SECRET, SIGNED = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
ENVS = {}


class H(BaseHTTPRequestHandler):
    def _json(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _authed(self):
        return self.headers.get("authorization", "") == "Bearer mock-token"

    def do_POST(self):
        raw = self._body()
        if self.path == "/core/api/rest/v1/oauth2/token":
            f = parse_qs(raw.decode())
            if f.get("grant_type") != ["client_credentials"] or f.get("client_id") != [CID] or f.get("client_secret") != [SECRET]:
                return self._json(401, {"success": False, "code": "AU.401", "message": "Bad credentials"})
            return self._json(200, {"access_token": "mock-token", "token_type": "bearer", "expires_in": 299, "scope": "read write"})
        if self.path == "/_complete":
            for e in ENVS.values():
                if e["status"] == "PENDING": e["status"] = "COMPLETED"
            return self._json(200, {"completed": len(ENVS)})
        if not self._authed(): return self._json(401, {"success": False, "message": "unauthorized"})
        if self.path == "/core/external-api/rest/v1/envelope":
            m = re.search(rb'name="envelope_details"\r\n\r\n(.*?)\r\n--', raw, re.S)
            if not m or b'name="file"' not in raw or b"%PDF" not in raw:
                return self._json(400, {"success": False, "code": "ES.10508", "message": "File is empty."})
            details = json.loads(m.group(1))
            eid = f"env-{len(ENVS) + 1:04d}"
            ENVS[eid] = {"status": "DRAFT", "details": details}
            return self._json(200, {"success": True, "data": {"id": eid}})
        m = re.match(r"^/core/external-api/rest/v1/envelope/([^/]+)/start-signature$", self.path)
        if m and m.group(1) in ENVS:
            e = ENVS[m.group(1)]; e["status"] = "PENDING"
            links = [{"email": r["email"], "signature_link": f"https://sign.vida.id/signEnvelope/{m.group(1)}-{r['order']}"} for r in e["details"]["recipients"]]
            return self._json(200, {"success": True, "data": {"envelope_id": m.group(1), "envelope_status": "PENDING", "signature_links": links}})
        return self._json(400, {"success": False, "code": "ES.10501", "message": "Envelope not found."})

    def do_GET(self):
        if not self._authed(): return self._json(401, {"success": False, "message": "unauthorized"})
        m = re.match(r"^/core/external-api/rest/v1/envelope/([^/]+)/status$", self.path)
        if m and m.group(1) in ENVS:
            e = ENVS[m.group(1)]
            rec = [{**r, "status": "SIGNED" if e["status"] == "COMPLETED" else "PENDING", "is_signer": True} for r in e["details"]["recipients"]]
            return self._json(200, {"success": True, "data": {"status": e["status"], "recipients": rec, "expiry_at": None}})
        m = re.match(r"^/document/external-api/rest/v1/envelope/([^/]+)/signed-document$", self.path)
        if m and m.group(1) in ENVS:
            if ENVS[m.group(1)]["status"] != "COMPLETED":
                return self._json(400, {"success": False, "code": "ER.10114", "message": "Unable to execute, the envelope is not in signature completion state."})
            b = open(SIGNED, "rb").read()
            self.send_response(200); self.send_header("content-type", "application/pdf"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        return self._json(400, {"success": False, "code": "ES.10501", "message": "Envelope not found."})

    def log_message(self, *a): pass


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
