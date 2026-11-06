# Vynen Dart

Turnier-App für das Neujahrsdart-Turnier „Vynen 26“: Live-Spielstand für alle, Schiri-Scorer pro Board, KO-Turnierbaum.

- **Live-Ansicht** (`#live`): Boards mit Restpunkten und Legs, wartende Spiele, letzte Ergebnisse – aktualisiert sich selbst.
- **Schiri-Scorer** (`#schiri`): PIN pro Spiel, Ausbullen (auch vor dem Decider), Eingabe pro Aufnahme oder Einzeldart, Rückgängig, Checkout-Vorschlag, Kontrollseite vor dem Abschluss. Funktioniert bei Netzausfall weiter und überträgt nach.
- Installierbar aufs Handy (PWA): im Browser „Zum Startbildschirm hinzufügen“.

## Technik
- Statische Seite (HTML/CSS/JS, keine Build-Schritte), gehostet über GitHub Pages.
- Daten und Live-Updates: Supabase (`supabase/migrations/`). Schreibzugriffe nur über PIN-geprüfte Datenbankfunktionen (`ref_*`) bzw. Admin-Login (`admin_*`); die Spiellogik (Bust, Double Out, Leg-/Matchende, Weiterrücken im Baum) läuft auf dem Server.

## Status
- [x] Datenbank, Spiellogik, Scorer, Live-Ansicht
- [x] Turnierleitung: Login, Turnier anlegen, Boards + PINs vergeben
- [x] Korrekturen: Ergebnis setzen, Spiel zurücksetzen, umbenennen, zurückziehen (w. o.), nachmelden
- [x] Turnierbaum, Tabelle, Highlights (automatisch aus dem Scorer), Hallen-Anzeige (`#halle`)
