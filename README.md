# Web-Projekte

Drei Website-Projekte, die sich lohnen. Gebaut mit reinem HTML, CSS und JavaScript: kein Framework, kein Build-Schritt, keine Cookies.

| # | Projekt | Ordner | Wofür? |
|---|---------|--------|--------|
| 1 | **Portfolio** | [`portfolio/`](portfolio/) | Deine Visitenkarte im Netz: Leistungen, Projekte, Preise, Kontakt |
| 2 | **Firmen-Website** (Demo: Friseursalon) | [`firmen-website/`](firmen-website/) | Vorlage, die du lokalen Betrieben zeigst und für sie anpasst |
| 3 | **Rechenhelfer** | [`rechner/`](rechner/) | Rechner-Portal (MwSt, Prozente, Stromkosten), das Besucher über Google gewinnt |

Alle Stellen, die du anpassen solltest, sind im Code mit **`ANPASSEN`** markiert.

## Ansehen

**Lokal:** `index.html` per Doppelklick im Browser öffnen. Alternativ im Ordner `python3 -m http.server` starten und <http://localhost:8000> aufrufen.

**Kostenlos online mit GitHub Pages:**

1. Die Änderungen in den Branch `main` übernehmen (Pull Request mergen).
2. Auf GitHub im Repo **Settings → Pages** öffnen.
3. Bei „Source“ **Deploy from a branch** wählen, Branch `main` und Ordner `/ (root)` einstellen und **Save** klicken.
4. Nach ein bis zwei Minuten ist alles online unter `https://marlon174.github.io/Web/`.

---

## 1 · Portfolio

Mit Leistungen, Projekten (verlinkt auf die beiden anderen Projekte), Ablauf, Preispaketen, „Über mich“ und Kontakt. Hat Dark Mode und funktioniert auf dem Handy.

**So machst du es fertig:**

- [ ] Name, Texte und Foto anpassen
- [ ] Eigene E-Mail-Adresse im Kontakt-Button eintragen
- [ ] Preise nach deiner eigenen Kalkulation festlegen
- [ ] Impressum und Datenschutz ausfüllen
- [ ] Optional eine eigene Domain verbinden (kostet meist nur wenige Euro im Jahr)

## 2 · Firmen-Website (Demo: Friseursalon)

Onepager mit folgenden Funktionen:

- **Live-Status „Jetzt geöffnet / Schließt bald / Geschlossen“**: liest die Öffnungszeiten direkt aus der Tabelle und rechnet immer mit deutscher Uhrzeit
- **Schnellkontakt-Leiste** auf dem Handy (Anrufen und WhatsApp)
- Preisliste, Team, Bewertungen, Anfahrt
- **Strukturierte Daten** für Google (Adresse und Öffnungszeiten)
- Keine externen Dienste: keine Google Fonts, keine eingebettete Karte, keine Tracker

**So gewinnst du damit Kunden:**

1. **Betriebe finden:** In Google Maps nach „Friseur“, „Handwerker“ oder „Restaurant“ plus deiner Stadt suchen. Betriebe ohne Website oder mit veralteter Seite notieren.
2. **Demo anpassen:** Ordner kopieren und Name, Farben, Leistungen und Öffnungszeiten des Betriebs eintragen. Das dauert etwa 30–60 Minuten.
3. **Zeigen:** Vorbeigehen oder anrufen und die Demo auf dem Handy zeigen. Das überzeugt mehr als jede Beschreibung.
4. **Angebot machen:** Einmalpreis plus monatliche Wartung (siehe Preise im Portfolio).

**Checkliste pro Kunde:**

- [ ] Name, Texte, Leistungen und Preise
- [ ] Farben ganz oben in `style.css` (`:root`)
- [ ] Öffnungszeiten in der Tabelle **und** im JSON-LD-Block im `<head>`
- [ ] Telefon, WhatsApp-Nummer (Format `49…` ohne führende 0) und E-Mail
- [ ] Echte Fotos von Salon und Team (das wirkt am stärksten)
- [ ] Nur echte Kundenbewertungen verwenden
- [ ] Impressum und Datenschutz mit den Daten des Kunden
- [ ] Demo-Banner ganz oben entfernen

## 3 · Rechenhelfer

Drei Rechner, die schon beim Tippen rechnen, jeweils mit Rechenweg, Erklärungen und häufigen Fragen. Deutsche Eingaben wie `1.234,56` funktionieren. Alle Berechnungen laufen im Browser, es werden keine Daten gesendet.

- **Mehrwertsteuer-Rechner:** Netto ↔ Brutto, 19 %, 7 % oder eigener Satz, cent-genau gerundet
- **Prozentrechner:** Prozentwert, Prozentsatz, Grundwert, Veränderung, Rabatt/Aufschlag
- **Stromkosten-Rechner:** Kosten pro Jahr, Monat und Tag inklusive Standby, mit Beispielgeräten

**So wächst die Seite:**

- Eigene Domain und die **Google Search Console** einrichten, damit Google die Seiten findet.
- **Regelmäßig neue Rechner ergänzen.** Jeder Rechner ist eine eigene Seite, die bei Google ranken kann. Ideen: Brutto-Netto, Dreisatz, Zinsen, Stundenlohn, Spritkosten.
- Neuer Rechner: eine bestehende Seite kopieren, das Formular anpassen und die Rechenfunktion in `rechner.js` ergänzen.
- Mit genug Besuchern kommen Einnahmen über Werbung (z. B. Google AdSense) oder Affiliate-Links. **Dann brauchst du zusätzlich ein Cookie-Banner und eine angepasste Datenschutzerklärung.**

---

## Rechtliches (Deutschland), kurz und wichtig

- Websites mit geschäftlichem Zweck brauchen ein **Impressum** und eine **Datenschutzerklärung**. In jedem Ordner liegen Platzhalter bereit. Am einfachsten füllst du sie mit einem Generator aus.
- Schriften nicht direkt von Google-Servern laden. Deshalb nutzen alle drei Seiten Systemschriften.
- Keine erfundenen Bewertungen verwenden.

*Das ist keine Rechtsberatung. Lass dich im Zweifel fachlich beraten.*

## Aufbau

```
index.html           Übersicht über alle drei Projekte
portfolio/           Portfolio (index.html, style.css, script.js, Impressum, Datenschutz)
firmen-website/      Demo-Website Friseursalon (gleicher Aufbau)
rechner/             Rechner-Portal: drei Rechner-Seiten + rechner.js mit der Rechenlogik
```
