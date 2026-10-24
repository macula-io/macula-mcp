"""Generate macula-mcp's two C4 diagrams into assets/.

Run:  python3 architecture/c4_diagrams.py

  c4-context.svg     Level 1: macula-mcp, the agent harness and person who use it,
                     and the Macula mesh, realm and services it talks to
  c4-components.svg  Level 3: the modules inside the macula-mcp process (src/)

Colours are plain classes with a prefers-color-scheme: dark block, no CSS
custom properties (rsvg-convert renders those black), so the SVGs render the
same on GitHub, in IDE previews and through rsvg-convert. The drawing helpers,
colours and legend are mcl-fovea's (macula-services/mcl-fovea,
architecture/c4_diagrams.py). After a change, render each
(rsvg-convert -w 1400 assets/c4-context.svg -o /tmp/c.png) and look at it;
keep architecture/README.md's tables in step.
"""
import os
from xml.sax.saxutils import escape

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")

SANS = '"Atkinson Hyperlegible", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif'
MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

# Element kinds, each (light fill, light stroke, dark fill, dark stroke).
KINDS = {
    "b-sys": ("#F5E9CC", "#A56F0A", "#3A2E13", "#E3AA3C"),   # in scope
    "b-per": ("#E3EBF2", "#3B5B7A", "#1D2A36", "#8EB4D8"),   # person
    "b-mac": ("#E6E4EE", "#5E5A78", "#26243A", "#A9A4C8"),   # Macula infrastructure
    "b-ext": ("#ECEFED", "#8A9791", "#1C2421", "#7D8B85"),   # external system
    "b-cmp": ("#FFFFFF", "#8A9791", "#171F1C", "#7D8B85"),   # component or container
}

STYLE = f"""<style>
.t-name {{ font-family: {SANS}; font-size: 15px; font-weight: 700; }}
.t-desc {{ font-family: {SANS}; font-size: 12.5px; }}
.t-rel {{ font-family: {SANS}; font-size: 11.5px; paint-order: stroke; stroke-width: 4px; stroke-linejoin: round; }}
.t-code {{ font-family: {MONO}; font-size: 13px; font-weight: 600; }}
.t-type {{ font-family: {MONO}; font-size: 11.5px; }}
.t-bound {{ font-family: {MONO}; font-size: 12px; font-weight: 600; }}
.t-leg {{ font-family: {SANS}; font-size: 12px; }}
.edge {{ fill: none; stroke-width: 1.25; }}
.edge-later {{ fill: none; stroke-width: 1.25; stroke-dasharray: 5 4; }}
.bg {{ fill: #FFFFFF; }}
""" + "".join(f".{k} {{ fill: {v[0]}; stroke: {v[1]}; stroke-width: {2 if k == 'b-sys' else 1.25}; }}\n" for k, v in KINDS.items()) + """\
.b-later { fill: none; stroke: #8A9791; stroke-width: 1.25; stroke-dasharray: 5 4; }
.bound { fill: none; stroke: #B3BDB8; stroke-width: 1; }
.head { fill: #3B5B7A; }
.t-name, .t-code { fill: #16201D; }
.t-type, .t-bound, .t-leg { fill: #66736E; }
.t-desc { fill: #34413C; }
.t-rel { fill: #66736E; stroke: #FFFFFF; }
.edge, .edge-later { stroke: #8A9791; }
.arrowhead { fill: #8A9791; }
@media (prefers-color-scheme: dark) {
.bg { fill: #171F1C; }
""" + "".join(f".{k} {{ fill: {v[2]}; stroke: {v[3]}; }}\n" for k, v in KINDS.items()) + """\
.b-later { stroke: #7D8B85; }
.bound { stroke: #4A5752; }
.head { fill: #8EB4D8; }
.t-name, .t-code { fill: #E6ECE9; }
.t-type, .t-bound, .t-leg { fill: #93A09A; }
.t-desc { fill: #C3CDC8; }
.t-rel { fill: #93A09A; stroke: #171F1C; }
.edge, .edge-later { stroke: #7D8B85; }
.arrowhead { fill: #7D8B85; }
}
</style>"""

DEFS = ('<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        'orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>')

LEGEND = [("b-sys", "In scope"), ("b-per", "Person"), ("b-mac", "Macula infrastructure"),
          ("b-ext", "External system"), ("b-cmp", "Container or component"), ("b-later", "Planned, not built")]
BOUNDARY = ("bound", "Boundary")


class Diagram:
    def __init__(self, name, title, w, h):
        self.name, self.title, self.w, self.h, self.parts = name, title, w, h, []

    def text(self, cls, x, y, s, anchor=None, rotate=None):
        a = f' text-anchor="{anchor}"' if anchor else ""
        r = f' transform="rotate({rotate} {x} {y})"' if rotate is not None else ""
        self.parts.append(f'<text class="{cls}" x="{x}" y="{y}"{a}{r}>{escape(s)}</text>')

    def box(self, cls, x, y, w, h, name, kind, desc, person=False, code=False):
        self.parts.append(f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>')
        tx = x + 16
        if person:
            self.parts.append(f'<circle class="head" cx="{x + 26}" cy="{y + 24}" r="9"/>')
            tx = x + 44
        self.text("t-code" if code else "t-name", tx, y + 28, name)
        self.text("t-type", tx, y + 46, kind)
        for i, line in enumerate(desc):
            self.text("t-desc", x + 16, y + 70 + 16 * i, line)

    def bound(self, x, y, w, h, label):
        self.parts.append(f'<rect class="bound" x="{x}" y="{y}" width="{w}" height="{h}" rx="12"/>')
        self.text("t-bound", x + 16, y + 22, label)

    def edge(self, d, later=False):
        self.parts.append(f'<path class="{"edge-later" if later else "edge"}" d="{d}" marker-end="url(#a)"/>')

    def legend(self, y, boundary=True):
        x = 24
        for cls, label in LEGEND + ([BOUNDARY] if boundary else []):
            self.parts.append(f'<rect class="{cls}" x="{x}" y="{y}" width="22" height="14" rx="3"/>')
            self.text("t-leg", x + 30, y + 12, label)
            x += 34 + 6.6 * len(label)

    def write(self):
        svg = [(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" role="img" '
                f'aria-label="{escape(self.title)}">'), f"<title>{escape(self.title)}</title>", STYLE, DEFS,
               f'<rect class="bg" x="0" y="0" width="{self.w}" height="{self.h}"/>'] + self.parts + ["</svg>", ""]
        with open(os.path.join(OUT, self.name), "w") as f:
            f.write("\n".join(svg))


def context():
    d = Diagram("c4-context.svg", "macula-mcp system context", 1000, 640)
    d.box("b-per", 40, 50, 270, 96, "Operator", "[Person]",
          ["Installs and registers it, sets its", "environment, confirms realm joins"], person=True)
    d.box("b-ext", 365, 50, 270, 96, "Agent harness", "[External: MCP client]",
          ["Claude Code, Claude Desktop, Cursor,", "Windsurf, opencode, Goose, any other"])
    d.box("b-mac", 690, 50, 270, 96, "macula-realm", "[Macula infrastructure]",
          ["realm.macula.io: join sessions,", "membership UCANs, the realm key"])
    d.box("b-sys", 365, 210, 270, 120, "macula-mcp", "[npm @macula-io/mcp, Node 24]",
          ["MCP server over stdio: one identity", "key, one pool to the mesh, tools", "for calls, rooms, rings, memory"])
    d.box("b-ext", 40, 430, 270, 120, "Other agents", "[External: mesh peers]",
          ["Other macula-mcp or lazymesh agents:", "hellos, room envelopes, rings to", "~<node_id>/ring"])
    d.box("b-mac", 365, 430, 270, 120, "Macula stations, DHT", "[Macula infrastructure]",
          ["The pool's pinned stations (six fleet", "stations by default); the DHT holds", "signed advertisements and records"])
    d.box("b-mac", 690, 430, 270, 120, "Macula mesh services", "[Macula services, io.macula realm]",
          ["mcl-rag (memory, role prompts),", "mcl-citizens, mcl-stations, mcl-echo;", "any advertised procedure"])
    d.edge("M310 98H365"); d.text("t-rel", 337, 90, "uses", anchor="middle")
    d.edge("M175 50V24H825V50"); d.text("t-rel", 500, 18, "confirms a join in the browser (Hanko sign-in)", anchor="middle")
    d.edge("M175 146V270H365"); d.text("t-rel", 183, 200, "registers it in client"); d.text("t-rel", 183, 216, "configs; sets env")
    d.edge("M500 146V210"); d.text("t-rel", 508, 176, "MCP over stdio:"); d.text("t-rel", 508, 192, "tools, resources, prompts")
    d.edge("M635 250H825V146"); d.text("t-rel", 833, 178, "HTTPS join session"); d.text("t-rel", 833, 194, "(realm proof v2);"); d.text("t-rel", 833, 210, "membership UCAN"); d.text("t-rel", 833, 226, "over the mesh")
    d.edge("M500 330V430"); d.text("t-rel", 508, 366, "QUIC, hybrid PQ key exchange;"); d.text("t-rel", 508, 382, "signed calls, publications,"); d.text("t-rel", 508, 398, "DHT reads, served procedures")
    d.edge("M635 300H825V430"); d.text("t-rel", 833, 374, "calls by direct dial")
    d.edge("M310 490H365"); d.text("t-rel", 337, 482, "rooms,", anchor="middle"); d.text("t-rel", 337, 510, "rings", anchor="middle")
    d.edge("M690 490H635"); d.text("t-rel", 662, 482, "serve", anchor="middle"); d.text("t-rel", 662, 510, "through", anchor="middle")
    d.legend(600, boundary=False)
    d.write()


def components():
    d = Diagram("c4-components.svg", "macula-mcp components", 1000, 990)
    d.bound(16, 40, 968, 722, "macula-mcp process [Node 24, one per harness session, src/]")
    d.box("b-sys", 32, 70, 936, 88, "index.ts", "[McpServer + StdioServerTransport, @modelcontextprotocol/sdk]",
          ["The entry point: registers every tool, the mesh://identity and mesh://etiquette resources, the help and role prompts."], code=True)
    d.bound(32, 182, 936, 316, "Tools and what presence starts [tools that need presence call ensurePresence at their entry]")
    d.box("b-cmp", 48, 214, 288, 126, "Calls, DHT, content", "[mesh_call, mesh_dht, mesh_artifact]",
          ["mesh_call (sealed when the provider", "names a KEM key), mesh_find_record*,", "mesh_put / mesh_get; mesh_publish,", "mesh_watch"], code=True)
    d.box("b-cmp", 356, 214, 288, 126, "Rooms and rings", "[converse_in_rooms/, ring_agents/]",
          ["open/join/leave, mesh_say, read_inbox,", "wait_room, observe_lobby; ring,", "answer_ring, wait_ring, trust_agent;", "envelope.ts, policy.ts"], code=True)
    d.box("b-cmp", 664, 214, 288, 126, "Memory, stations, role", "[mesh_memory, mesh_stations]",
          ["recall / remember / remember_directory", "on mcl-rag (secret_scan first);", "list_stations on mcl-stations;", "mesh_role: role prompts via mcl-rag"], code=True)
    d.box("b-cmp", 48, 356, 288, 126, "Realm membership", "[realm.ts, device_membership.ts]",
          ["mesh_join_realm, mesh_list_realms:", "an RFC 8628-shaped join session over", "HTTPS, polled in the background; the", "membership UCAN over the mesh"], code=True)
    d.box("b-cmp", 356, 356, 288, 126, "Serving", "[mesh_serve, serve.ts]",
          ["Serves ~<node_id>/<name>; each inbound", "call spawns the operator's local shell", "command (JSON on stdin, the caller in", "MACULA_MCP_CALLER)"], code=True)
    d.box("b-cmp", 664, 356, 288, 126, "presence.ts", "[mesh_hello / goodbye / agents]",
          ["agent.hello heartbeat and roster,", "watch_lobby (central and rooms),", "serve_rings (~<node_id>/ring),", "citizenship, device_membership"], code=True)
    d.box("b-mac", 32, 522, 618, 112, "macula_ts_client.ts on @macula-io/ts 0.31", "[Macula SDK, wire 1.0]",
          ["ONE Pool under ONE identity key (ML-DSA, pq_hybrid), linked to every configured",
           "station, each pinned by its node_id; calls by direct dial, signed publications,",
           "subscriptions replayed onto a redialed link."])
    d.box("b-cmp", 668, 522, 300, 112, "machine_transcript.ts", "[node:sqlite and files, local state]",
          ["roster and lobby transcript;", "rings.sqlite3 (rings, node events,", "room membership); keys, credentials"])
    d.box("b-cmp", 32, 658, 936, 88, "mesh_config.ts, io_macula_realm_key.ts", "[configuration]",
          ["MACULA_MESH_STATIONS (host:port@node_id, the six fleet stations by default), MACULA_MESH_REALMS (trusted realm keys)."], code=True)
    d.edge("M500 158V182"); d.text("t-rel", 508, 174, "registers")
    d.edge("M341 498V522"); d.text("t-rel", 349, 514, "every mesh operation")
    d.edge("M808 482V522"); d.text("t-rel", 816, 514, "reads, writes")
    d.edge("M341 634V658"); d.text("t-rel", 349, 650, "stations, realm keys")
    d.bound(16, 782, 968, 140, "Companion executables [src/bin, src/install]")
    d.box("b-cmp", 32, 812, 456, 96, "register, uninstall, status, doctor", "[macula-mcp-* bins]",
          ["Safe-merge a macula entry into each detected client's", "config (install/mcp_clients: six clients), check it runs"], code=True)
    d.box("b-cmp", 512, 812, 456, 96, "macula-mcp-realm, macula-mcp-node-id", "[bins]",
          ["Join a realm other than io.macula (never a tool);", "print the node_id of an identity key"], code=True)
    d.legend(952)
    d.write()


if __name__ == "__main__":
    for make in (context, components):
        make()
