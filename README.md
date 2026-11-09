# Vynen Dart

Turnier-App für das Neujahrsdart-Turnier „Vynen 26“: Live-Spielstand für alle, Schiri-Scorer pro Board, KO-Turnierbaum.

- **Live-Ansicht** (`#live`): Boards mit Restpunkten und Legs, wartende Spiele, letzte Ergebnisse – aktualisiert sich selbst.
- **Schiri-Scorer** (`#schiri`): PIN pro Spiel, Ausbullen (auch vor dem Decider), Eingabe pro Aufnahme oder Einzeldart, Rückgängig, Checkout-Vorschlag, Kontrollseite vor dem Abschluss. Funktioniert bei Netzausfall weiter und überträgt nach.
- Installierbar aufs Handy (PWA): im Browser „Zum Startbildschirm hinzufügen“.

## Turniermodi
- **KO-Baum** (Standard): Setzliste, Freilose, Spiel um Platz 3.
- **Schweizer System**: feste Rundenzahl, Auslosung punktgleicher Spieler ohne Wiederholung, Freilos (1 Punkt, höchstens einmal), Nachmeldung jederzeit (Start mit 0 oder den Punkten des Letzten), Wertung Punkte → Buchholz → Leg-Differenz → Average, Ende als Tabellensieg oder KO-Finale Top 4/Top 8.

## Technik
- Statische Seite (HTML/CSS/JS, keine Build-Schritte), gehostet über GitHub Pages.
- Daten und Live-Updates: Supabase (`supabase/migrations/`). Schreibzugriffe nur über PIN-geprüfte Datenbankfunktionen (`ref_*`) bzw. Admin-Login (`admin_*`); die Spiellogik (Bust, Double Out, Leg-/Matchende, Weiterrücken im Baum) läuft auf dem Server.

## Status
- [x] Datenbank, Spiellogik, Scorer, Live-Ansicht
- [x] Turnierleitung: Login, Turnier anlegen, Boards + PINs vergeben
- [x] Korrekturen: Ergebnis setzen, Spiel zurücksetzen, umbenennen, zurückziehen (w. o.), nachmelden
- [x] Turnierbaum, Tabelle, Highlights (automatisch aus dem Scorer), Hallen-Anzeige (`#halle`)
