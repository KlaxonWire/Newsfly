"""Pack FlyWire FAFB neuron tables into one compact binary for the browser.

Layout (little-endian), written to data/neurons.bin:
  magic   4s   "FLYN"
  count   u32
  then count records of 16 bytes:
    x, y, z   3 x int16   (quantised to the brain's bounding box)
    nt        u8          index into NT
    sup       u8          index into SUP
    side      u8          0 left 1 right 2 centre
    flags     u8          bit0 afferent, bit1 efferent
    idx       u32         row index, ties back to the id table
Ids and cell-type strings go to data/neurons.meta.json separately so the hot
array stays a flat typed buffer the GPU can eat without parsing.
"""
import gzip, csv, json, struct, os, statistics

UP = "/root/.claude/uploads/6dc815a9-0778-5206-a62d-c92c1ffbb466/"
F_COORD = UP + "07a34b71-coordinates.csv.gz.csv"
F_NT    = UP + "90f23302-neurons.csv.gz.csv"
F_CLS   = UP + "4fccf269-classification.csv.gz.csv"
F_TYPE  = UP + "7471b671-consolidated_cell_types.csv.gz.csv"

NT  = ["", "ACH", "GLUT", "GABA", "SER", "DA", "OCT"]
SUP = ["", "optic", "central", "sensory", "visual_projection", "ascending",
       "descending", "sensory_ascending", "visual_centrifugal", "motor", "endocrine"]

def rows(p):
    with gzip.open(p, "rt", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            yield r

# --- one position per neuron: mean of its marked points -------------------
acc = {}
for r in rows(F_COORD):
    p = r["position"].strip().strip("[]").split()
    if len(p) != 3:
        continue
    rid = r["root_id"]
    a = acc.get(rid)
    if a is None:
        acc[rid] = [int(p[0]), int(p[1]), int(p[2]), 1]
    else:
        a[0] += int(p[0]); a[1] += int(p[1]); a[2] += int(p[2]); a[3] += 1
pos = {k: (v[0]/v[3], v[1]/v[3], v[2]/v[3]) for k, v in acc.items()}
print("positions:", len(pos))

nt_of  = {r["root_id"]: r["nt_type"] for r in rows(F_NT)}
cls_of = {r["root_id"]: r for r in rows(F_CLS)}
typ_of = {r["root_id"]: r["primary_type"] for r in rows(F_TYPE)}

ids = sorted(pos.keys())
xs = [pos[i][0] for i in ids]; ys = [pos[i][1] for i in ids]; zs = [pos[i][2] for i in ids]
bb = (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))
print("bbox nm:", [round(v) for v in bb])

def q(v, lo, hi):
    return max(-32767, min(32767, int(round((v - lo) / (hi - lo) * 65534 - 32767))))

out = bytearray()
out += b"FLYN" + struct.pack("<I", len(ids))
meta_ids, meta_type = [], []
for n, rid in enumerate(ids):
    x, y, z = pos[rid]
    c = cls_of.get(rid, {})
    nt = nt_of.get(rid, "")
    sup = c.get("super_class", "")
    side = c.get("side", "")
    flow = c.get("flow", "")
    flags = (1 if flow == "afferent" else 0) | (2 if flow == "efferent" else 0)
    out += struct.pack("<hhhBBBBI",
        q(x, bb[0], bb[1]), q(y, bb[2], bb[3]), q(z, bb[4], bb[5]),
        NT.index(nt) if nt in NT else 0,
        SUP.index(sup) if sup in SUP else 0,
        0 if side == "left" else (1 if side == "right" else 2),
        flags, n)
    meta_ids.append(rid)
    meta_type.append(typ_of.get(rid, ""))

os.makedirs("data", exist_ok=True)
open("data/neurons.bin", "wb").write(out)
json.dump({"bbox": bb, "nt": NT, "sup": SUP, "ids": meta_ids, "types": meta_type},
          open("data/neurons.meta.json", "w"))
print("neurons.bin", len(out), "bytes for", len(ids), "neurons")
