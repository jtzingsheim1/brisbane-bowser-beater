# Swimlane workflow SVG for the README "From prompt to production" section.
# Time -> x (columns), actors -> lanes (y). Lane order top->bottom: Cloud,
# Claude, Human. The automation lane carries the bulk of the steps + an
# always-on data pipeline; the Human lane is deliberately sparse (2 touchpoints).
#
# Run:  python3 docs/workflow-diagram.py   ->  writes docs/workflow.svg
# Pure stdlib, no deps. Edit the `nodes`/`lanes` tables below to tweak.
import os
_HERE = os.path.dirname(os.path.abspath(__file__))
W = 1240
Gx = 158
rightpad = 24
top = 22
Gy = 16
contentW = W - Gx - rightpad
NCOL = 7
colW = contentW / NCOL
Nw, Nh = 150, 62

# lanes top->bottom
lanes = [
    {"k":"Cloud","h":182,"label":"Cloud","sub":"fully automated"},
    {"k":"Claude","h":104,"label":"Claude","sub":"writes the code"},
    {"k":"You","h":104,"label":"Human","sub":"2 touchpoints"},
]
lane_top = {}
y = top
for ln in lanes:
    lane_top[ln["k"]] = y
    y += ln["h"] + Gy
H = y - Gy + 18
def lane_h(k): return next(l["h"] for l in lanes if l["k"]==k)
def lane_cy(k): return lane_top[k] + lane_h(k)/2
def colx(i): return Gx + colW*(i-0.5)

band = {"Cloud":"#EEF2F7","Claude":"#F8E7DF","You":"#FBF1D8"}
band_stroke = {"Cloud":"#D2DAE6","Claude":"#EAC3B2","You":"#E6CF86"}
label_col = {"Cloud":"#48566B","Claude":"#A2452A","You":"#8A6D00"}
nf={"human":"#F4B740","claude":"#D97757","auto":"#FFFFFF","live":"#2E7D32","data":"#F5F7FA"}
ns={"human":"#B98700","claude":"#A2452A","auto":"#C2CBD6","live":"#1B5E20","data":"#AEBACA"}
nt={"human":"#3A2D00","claude":"#FFFFFF","auto":"#28323F","live":"#FFFFFF","data":"#48566B"}

# node: id -> dict(col, lane, row(0 upper/1 lower for Cloud), kind, lines)
def L(*xs): return list(xs)
nodes = {
 "P": dict(col=1, lane="You",   row=0, kind="human", lines=L(("Prompt the work",15,700),("terminal · desktop · mobile",10,400))),
 "C": dict(col=2, lane="Claude",row=0, kind="claude", lines=L(("Write the code",15,700),("branch · push · open PR",10,400))),
 "K1":dict(col=3, lane="Cloud", row=0, kind="auto", lines=L(("CI checks",13.5,700),("lint · test · build",9.5,400))),
 "K2":dict(col=4, lane="Cloud", row=0, kind="auto", lines=L(("CodeQL",13.5,700),("+ preview deploy",9.5,400))),
 "M": dict(col=5, lane="You",   row=0, kind="human", lines=L(("Review + merge",15,700))),
 "D": dict(col=6, lane="Cloud", row=0, kind="auto", lines=L(("Deploy",13.5,700),("Vercel + migrations",9.5,400))),
 "Lv":dict(col=7, lane="Cloud", row=0, kind="live", shape="pill", lines=L(("● Live site",14,700))),
 # always-on data pipeline (lower row of Cloud)
 "Cr":dict(col=4, lane="Cloud", row=1, kind="data", lines=L(("GitHub Actions · 30 min",11,700),("ingest · forecast · refresh",9.5,400))),
 "DB":dict(col=6, lane="Cloud", row=1, kind="data", shape="cylinder", lines=L(("Supabase",12,700),)),
}
def nxy(nid):
    n=nodes[nid]; cx=colx(n["col"])
    if n["lane"]=="Cloud":
        cy = lane_top["Cloud"] + (52 if n["row"]==0 else 130)
    else:
        cy = lane_cy(n["lane"])
    return cx, cy

solid=[("P","C"),("C","K1"),("K1","K2"),("K2","M"),("M","D"),("D","Lv")]
dashed=[("Cr","DB"),("DB","Lv")]

s=[]
s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H:.0f}" viewBox="0 0 {W} {H:.0f}" font-family="Helvetica, Arial, sans-serif">')
s.append(f'<rect width="{W}" height="{H:.0f}" fill="#FFFFFF"/>')
s.append('<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="#6B7280"/></marker>'
         '<marker id="ahd" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="#9AA7B8"/></marker></defs>')
# bands + labels
for ln in lanes:
    k=ln["k"]; ty=lane_top[k]
    s.append(f'<rect x="8" y="{ty}" width="{W-16}" height="{ln["h"]}" rx="14" fill="{band[k]}" stroke="{band_stroke[k]}" stroke-width="1.5"/>')
    s.append(f'<text x="26" y="{lane_cy(k)-2:.1f}" font-size="15" font-weight="800" fill="{label_col[k]}">{ln["label"]}</text>')
    s.append(f'<text x="26" y="{lane_cy(k)+15:.1f}" font-size="10.5" font-weight="600" fill="{label_col[k]}" opacity="0.7">{ln["sub"]}</text>')
# edges
def path(a,b):
    ax,ay=nxy(a); bx,by=nxy(b)
    x1=ax+Nw/2; x2=bx-Nw/2; midx=(x1+x2)/2
    return f'M{x1:.1f},{ay:.1f} H{midx:.1f} V{by:.1f} H{x2:.1f}'
for a,b in solid:
    s.append(f'<path d="{path(a,b)}" fill="none" stroke="#6B7280" stroke-width="2.2" marker-end="url(#ah)"/>')
for a,b in dashed:
    s.append(f'<path d="{path(a,b)}" fill="none" stroke="#9AA7B8" stroke-width="1.8" stroke-dasharray="5 4" marker-end="url(#ahd)"/>')
# nodes
def node(nid):
    n=nodes[nid]; cx,cy=nxy(nid); x=cx-Nw/2; y=cy-Nh/2
    k=n["kind"]; shape=n.get("shape","rect"); fill=nf[k]; stroke=ns[k]
    tweak=0  # vertical text nudge
    if shape=="pill":
        s.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{Nw}" height="{Nh}" rx="{Nh/2:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>')
    elif shape=="cylinder":
        ry=9; t=y; b=y+Nh; w=Nw
        body=(f'M{x:.1f},{t+ry:.1f} a{w/2:.1f},{ry} 0 0 1 {w:.1f},0 '
              f'V{b-ry:.1f} a{w/2:.1f},{ry} 0 0 1 -{w:.1f},0 Z')
        s.append(f'<path d="{body}" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>')
        s.append(f'<path d="M{x:.1f},{t+ry:.1f} a{w/2:.1f},{ry} 0 0 0 {w:.1f},0" fill="none" stroke="{stroke}" stroke-width="1.6"/>')
        tweak=ry/2
    else:
        s.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{Nw}" height="{Nh}" rx="11" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>')
    tot=sum(sz for _,sz,_ in n["lines"])+(len(n["lines"])-1)*5; cur=cy-tot/2+tweak
    for txt,sz,w in n["lines"]:
        cur+=sz
        s.append(f'<text x="{cx:.1f}" y="{cur-2:.1f}" font-size="{sz}" font-weight="{w}" fill="{nt[k]}" text-anchor="middle">{txt}</text>')
        cur+=5
for nid in ["P","C","K1","K2","M","D","Lv","Cr","DB"]: node(nid)
# "always-on" tag sits directly above the dashed GitHub Actions -> Supabase arrow
s.append(f'<text x="{colx(5):.1f}" y="{lane_top["Cloud"]+112:.1f}" font-size="10.5" font-style="italic" fill="#9AA7B8" text-anchor="middle">always-on data pipeline</text>')
s.append('</svg>')
open(os.path.join(_HERE, "workflow.svg"),"w").write("\n".join(s))
print("wrote", W, "x", round(H))
