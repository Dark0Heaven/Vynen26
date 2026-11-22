// Edge Function „notify“: schickt Web-Push an Geräte, die einem Spieler folgen („Mein Spieler“).
// Aufruf nur durch den Datenbank-Trigger _push_matches (Header x-hook = Geheimnis aus dem Vault).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let cfg: Record<string, string> | null = null;

type M = { id: string; tournament_id: string; kind: string; round: number; idx: number; status: string; board: number | null;
  player_a: string | null; player_b: string | null; winner: string | null; legs_a: number; legs_b: number };

function roundName(t: any, m: M): string {
  if (m.kind === "p3") return "Spiel um Platz 3";
  if (m.kind === "sw") return `Runde ${m.round + 1}`;
  if (m.kind === "lg") return `Spiel ${m.idx + 1}`;
  const R = Math.round(Math.log2(m.kind === "sc" ? t.size / 2 : t.size)), k = R - 1 - m.round;
  const n = ["Finale", "Halbfinale", "Viertelfinale", "Achtelfinale", "16tel-Finale"][k] || `Runde ${m.round + 1}`;
  return m.kind === "sc" ? `Silver Cup · ${n}` : n;
}
const open = (s: string) => !["done", "wo", "bye"].includes(s);

Deno.serve(async (req) => {
  try {
    if (!cfg) { const r = await sb.rpc("_push_config"); cfg = r.data; }
    if (!cfg || req.headers.get("x-hook") !== cfg.push_hook) return new Response("forbidden", { status: 401 });
    webpush.setVapidDetails("mailto:turnier@vynen26.de", cfg.vapid_public, cfg.vapid_private);
    const { match_id, event } = await req.json();
    const { data: m } = await sb.from("matches").select("*").eq("id", match_id).single<M>();
    if (!m) return new Response("no match");
    const { data: t } = await sb.from("tournaments").select("*").eq("id", m.tournament_id).single();
    const { data: ps } = await sb.from("players").select("id,name").eq("tournament_id", m.tournament_id);
    const { data: all } = await sb.from("matches").select("*").eq("tournament_id", m.tournament_id);
    const name = (id: string | null) => (ps || []).find((p: any) => p.id === id)?.name || "?";
    const rn = roundName(t, m);
    const msgs: { player: string; title: string; body: string; url: string; tag: string }[] = [];

    for (const side of [0, 1]) {
      const me = side ? m.player_b : m.player_a, opp = side ? m.player_a : m.player_b;
      if (!me) continue;
      const my = name(me), op = name(opp);
      if (event === "ready") msgs.push({ player: my, title: "Gleich bist du dran 🎯", body: `${rn} gegen ${op}. Bitte in der Nähe der Boards bleiben.`, url: "#live", tag: "ready-" + m.id });
      if (event === "live") msgs.push({ player: my, title: `Jetzt: Board ${m.board} 🎯`, body: `${rn} gegen ${op} – ab ans Board!`, url: "#live", tag: "live-" + m.id });
      if (event === "result") {
        const won = m.winner === me, la = side ? m.legs_b : m.legs_a, lb = side ? m.legs_a : m.legs_b;
        const res = m.status === "wo" ? (won ? "kampflos gewonnen" : "kampflos verloren") : `${won ? "Gewonnen" : "Verloren"} ${la}:${lb}`;
        const next = (all || []).filter((x: M) => x.id !== m.id && open(x.status) && (x.player_a === me || x.player_b === me))
          .sort((a: M, b: M) => a.round - b.round)[0];
        const tail = next ? ` – weiter: ${roundName(t, next)}` : "";
        msgs.push({ player: my, title: res, body: `${rn} gegen ${op}${tail}`, url: "#live", tag: "res-" + m.id });
        // Letztes Spiel des Abends: Recap (KO/Silver Cup pro Spieler; sonst wenn das ganze Turnier fertig ist)
        const done = t.mode === "ko" ? !next : !(all || []).some((x: M) => open(x.status));
        if (done && (t.mode === "ko" || (t.mode === "swiss" && new Set((all || []).filter((x: M) => x.kind === "sw").map((x: M) => x.round)).size >= (t.swiss?.rounds || 0)) || t.mode === "league"))
          msgs.push({ player: my, title: "Dein Abend in Zahlen ist da 🎯", body: "Average, Finishes, 180er – schau rein und speichere dein Bild.", url: "#recap/" + encodeURIComponent(my), tag: "recap" });
      }
    }
    // Abonnenten: folgen dem Namen (bei Doppeln „Max & Tim“ zählt auch jeder Einzelname)
    const keys = new Map<string, typeof msgs>();
    for (const g of msgs) for (const k of new Set([g.player, ...g.player.split("&")].map((s) => s.trim().toLowerCase()).filter(Boolean))) {
      if (!keys.has(k)) keys.set(k, []); keys.get(k)!.push(g);
    }
    if (!keys.size) return new Response("nothing");
    const { data: subs } = await sb.from("push_subs").select("*").in("follow", [...keys.keys()]);
    let sent = 0;
    await Promise.all((subs || []).flatMap((s: any) => (keys.get(s.follow) || []).map(async (g) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: g.title, body: g.body, url: g.url, tag: g.tag }), { TTL: 3600, urgency: "high" });
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    })));
    return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response("error: " + (e as Error).message, { status: 500 });
  }
});
