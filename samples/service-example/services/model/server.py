"""A stand-in for a research model (an energy optimiser, a flood model) behind MR Studio.

Standard library only, so it runs on any Python 3.9+. MR Studio starts it with the table
(site.json "services"), gives it a port, and forwards the layer's calls to it:

  GET  /health            200 when ready
  POST /run               {"share": 0.4, "buildings": [{"id": "3", "in": true, "pv": 40}]}
                                                    -> answers at once with a result
  POST /optimise          {"days": 2}              -> {"job": "<id>"}, the run goes on in the background
  GET  /optimise/<id>     {"state", "progress", "message", "result"}
  DELETE /optimise/<id>   stops waiting for it
"""
import json
import math
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JOBS = {}


def result_for(share, buildings=None):
    # Each building's import from the grid: its own solar (pv, % of the roof) covers part of
    # its use, and buildings in the community share the rest of the solar between them.
    # Without a list, six made-up buildings.
    buildings = buildings or [{"id": str(i), "in": True, "pv": 0} for i in range(6)]
    out = []
    for b in buildings:
        n = sum(ord(c) for c in str(b.get("id")))
        use = 60 + 60 * (0.5 + 0.5 * math.sin(n))
        own = use * min(0.8, float(b.get("pv", 0)) / 100)
        shared = (use - own) * share * 0.6 if b.get("in", True) else 0
        out.append({"id": b.get("id"), "in": bool(b.get("in", True)), "use_kw": round(use, 1), "own_kw": round(own, 1),
                    "shared_kw": round(shared, 1), "import_kw": round(use - own - shared, 1)})
    return {"share": share, "buildings": out}


def optimise(job, days):
    steps = 10
    for step in range(steps):
        if JOBS[job].get("cancelled"):
            JOBS[job].update(state="cancelled")
            return
        time.sleep(0.4 * days)
        JOBS[job].update(progress=(step + 1) / steps, message=f"day {min(days, 1 + step * days // steps)} of {days}")
    JOBS[job].update(state="done", result={"best_share": 0.62, "saving_sek": 18400 * days})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        print(self.command, self.path, flush=True)

    def answer(self, code, value):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/health":
            return self.answer(200, {"ok": True})
        if self.path.startswith("/optimise/"):
            job = JOBS.get(self.path.rsplit("/", 1)[1])
            return self.answer(200, job) if job else self.answer(404, {"error": "no such job"})
        self.answer(404, {"error": "not here"})

    def do_POST(self):
        body = self.read()
        if self.path == "/run":
            return self.answer(200, result_for(float(body.get("share", 0)), body.get("buildings")))
        if self.path == "/optimise":
            job = uuid.uuid4().hex[:8]
            JOBS[job] = {"state": "running", "progress": 0, "message": "starting"}
            threading.Thread(target=optimise, args=(job, int(body.get("days", 1))), daemon=True).start()
            return self.answer(202, {"job": job})
        self.answer(404, {"error": "not here"})

    def do_DELETE(self):
        job = JOBS.get(self.path.rsplit("/", 1)[1])
        if job:
            job["cancelled"] = True
        self.answer(200, {"ok": True})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
