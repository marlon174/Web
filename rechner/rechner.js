/* =========================================================
   Rechenhelfer – Logik für alle Rechner
   Die Rechenfunktionen sind von der Anzeige getrennt,
   damit man sie leicht prüfen und wiederverwenden kann.
   ========================================================= */
(() => {
  'use strict';

  // ---------- Zahlen lesen und ausgeben ----------

  // Deutsche Eingaben wie „1.234,56“, „19,5“, „1.500“ oder „99.9“ in eine Zahl umwandeln.
  function parseZahl(text) {
    if (typeof text !== 'string') return NaN;
    let s = text.trim().replace(/[\s €%]/g, '');
    if (s === '') return NaN;
    if (s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.');   // Komma = Dezimaltrennzeichen
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');                      // „1.500“ = Tausenderpunkt
    }
    const zahl = Number(s);
    return Number.isFinite(zahl) ? zahl : NaN;
  }

  function runde(n, stellen) {
    const faktor = 10 ** stellen;
    const r = Math.round(n * faktor) / faktor;
    return r === 0 ? 0 : r;   // verhindert die Anzeige „-0“
  }

  const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const euro = (n) => euroFormat.format(runde(n, 2));

  // Zahl mit bis zu 2 Nachkommastellen (bei sehr kleinen Werten bis zu 4)
  function zahl(n, stellen) {
    const s = stellen ?? (Math.abs(n) < 1 ? 4 : 2);
    return new Intl.NumberFormat('de-DE', { maximumFractionDigits: s }).format(runde(n, s));
  }

  const inCent = (betrag) => Math.round(Number((betrag * 100).toPrecision(12)));

  // ---------- Rechenfunktionen ----------

  // Mehrwertsteuer: gerechnet wird in Cent, damit keine Rundungsfehler entstehen.
  // art = 'netto' → der Betrag ist netto; art = 'brutto' → der Betrag ist brutto.
  function berechneMwst(betrag, satz, art) {
    const cent = inCent(betrag);
    let netto, steuer, brutto;
    if (art === 'brutto') {
      brutto = cent;
      netto = Math.round((brutto * 100) / (100 + satz));
      steuer = brutto - netto;
    } else {
      netto = cent;
      steuer = Math.round((netto * satz) / 100);
      brutto = netto + steuer;
    }
    return { netto: netto / 100, steuer: steuer / 100, brutto: brutto / 100 };
  }

  // Prozentrechnung – a und b sind die beiden Eingaben der jeweiligen Aufgabe.
  const PROZENT = {
    // Wie viel sind a % von b?
    anteil: {
      rechne: ({ a, b }) => (b * a) / 100,
      ergebnis: (e) => zahl(e),
      weg: ({ a, b }, e) => `${zahl(b)} × ${zahl(a)} ÷ 100 = ${zahl(e)}`,
    },
    // a ist wie viel Prozent von b?
    satz: {
      rechne: ({ a, b }) => (b === 0 ? NaN : (a / b) * 100),
      ergebnis: (e) => `${zahl(e)} %`,
      weg: ({ a, b }, e) => `${zahl(a)} ÷ ${zahl(b)} × 100 = ${zahl(e)} %`,
    },
    // a sind b % von wie viel?
    grundwert: {
      rechne: ({ a, b }) => (b === 0 ? NaN : (a * 100) / b),
      ergebnis: (e) => zahl(e),
      weg: ({ a, b }, e) => `${zahl(a)} × 100 ÷ ${zahl(b)} = ${zahl(e)}`,
    },
    // Um wie viel Prozent ändert sich a auf b?
    veraenderung: {
      rechne: ({ a, b }) => (a === 0 ? NaN : ((b - a) / Math.abs(a)) * 100),
      ergebnis: (e) => {
        const r = runde(e, 2);
        const art = r > 0 ? 'Anstieg' : r < 0 ? 'Rückgang' : 'keine Veränderung';
        return `${r > 0 ? '+' : ''}${zahl(e, 2)} % (${art})`;
      },
      weg: ({ a, b }, e) => `(${zahl(b)} − ${zahl(a)}) ÷ ${zahl(Math.abs(a))} × 100 = ${zahl(e, 2)} %`,
    },
    // a um b % erhöhen oder verringern
    aendern: {
      rechne: ({ a, b, richtung }) => a * (1 + (richtung === 'minus' ? -b : b) / 100),
      ergebnis: (e) => zahl(e),
      weg: ({ a, b, richtung }, e) =>
        `${zahl(a)} × (1 ${richtung === 'minus' ? '−' : '+'} ${zahl(b)} ÷ 100) = ${zahl(e)}`,
    },
  };

  // Stromkosten eines Geräts pro Jahr (inkl. Standby in den übrigen Stunden)
  function berechneStrom({ watt, stunden, tage, preisCent, standbyWatt = 0 }) {
    const nutzStunden = (stunden * tage * 365) / 7;          // Betriebsstunden pro Jahr
    const standbyStunden = Math.max(0, 8760 - nutzStunden);  // restliche Stunden des Jahres
    const kwhBetrieb = (watt * nutzStunden) / 1000;
    const kwhStandby = (standbyWatt * standbyStunden) / 1000;
    const kwhJahr = kwhBetrieb + kwhStandby;
    const kostenJahr = (kwhJahr * preisCent) / 100;
    return {
      kwhJahr,
      kostenJahr,
      kostenMonat: kostenJahr / 12,
      kostenTag: kostenJahr / 365,
      kostenStandby: (kwhStandby * preisCent) / 100,
      centProStunde: (watt / 1000) * preisCent,
    };
  }

  const Rechner = { parseZahl, euro, zahl, berechneMwst, PROZENT, berechneStrom };

  // In Node.js (für Tests) nur die Funktionen bereitstellen
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Rechner;
    return;
  }

  // ---------- Anzeige: Mehrwertsteuer-Rechner ----------

  function initMwst(form) {
    const bereich = form.closest('.rechner');
    const aus = (name) => bereich.querySelector(`[data-aus="${name}"]`);
    const eigenFeld = form.querySelector('.feld-eigen');

    function aktualisiere() {
      const daten = new FormData(form);
      const art = daten.get('art');
      const satzWahl = daten.get('satz');
      eigenFeld.hidden = satzWahl !== 'eigen';

      const betrag = parseZahl(daten.get('betrag'));
      const satz = satzWahl === 'eigen' ? parseZahl(daten.get('eigenerSatz')) : Number(satzWahl);

      let fehler = '';
      if (Number.isNaN(betrag)) fehler = 'Bitte gib einen Betrag ein, z. B. 100 oder 49,99.';
      else if (Number.isNaN(satz) || satz < 0 || satz > 100) fehler = 'Bitte gib einen Steuersatz zwischen 0 und 100 % ein.';

      zeigeFehler(bereich, fehler);
      if (fehler) return;

      const r = berechneMwst(betrag, satz, art);
      aus('netto').textContent = euro(r.netto);
      aus('steuer').textContent = euro(r.steuer);
      aus('brutto').textContent = euro(r.brutto);
      aus('satz').textContent = zahl(satz);
      aus('netto').closest('div').classList.toggle('ziel', art === 'brutto');
      aus('brutto').closest('div').classList.toggle('ziel', art !== 'brutto');
    }

    beobachte(form, aktualisiere);
  }

  // ---------- Anzeige: Prozentrechner ----------

  function initProzent(form) {
    const aufgabe = PROZENT[form.dataset.aufgabe];
    const ergebnisEl = form.querySelector('[data-aus="ergebnis"]');
    const wegEl = form.querySelector('[data-aus="rechenweg"]');

    function aktualisiere() {
      const daten = new FormData(form);
      const werte = { a: parseZahl(daten.get('a')), b: parseZahl(daten.get('b')), richtung: daten.get('richtung') };

      if (Number.isNaN(werte.a) || Number.isNaN(werte.b)) {
        ergebnisEl.textContent = '–';
        wegEl.textContent = 'Bitte beide Felder mit Zahlen ausfüllen.';
        return;
      }
      const e = aufgabe.rechne(werte);
      if (!Number.isFinite(e)) {
        ergebnisEl.textContent = '–';
        wegEl.textContent = 'Nicht berechenbar: Durch 0 kann man nicht teilen.';
        return;
      }
      ergebnisEl.textContent = aufgabe.ergebnis(e);
      wegEl.textContent = `Rechenweg: ${aufgabe.weg(werte, e)}`;
    }

    beobachte(form, aktualisiere);
  }

  // ---------- Anzeige: Stromkosten-Rechner ----------

  function initStrom(form) {
    const bereich = form.closest('.rechner');
    const aus = (name) => bereich.querySelector(`[data-aus="${name}"]`);

    function aktualisiere() {
      const daten = new FormData(form);
      const eingabe = {
        watt: parseZahl(daten.get('watt')),
        stunden: parseZahl(daten.get('stunden')),
        tage: parseZahl(daten.get('tage')),
        preisCent: parseZahl(daten.get('preis')),
        standbyWatt: daten.get('standby').trim() === '' ? 0 : parseZahl(daten.get('standby')),
      };

      let fehler = '';
      if (Object.values(eingabe).some((w) => Number.isNaN(w))) fehler = 'Bitte fülle alle Felder mit Zahlen aus.';
      else if (Object.values(eingabe).some((w) => w < 0)) fehler = 'Negative Werte sind nicht möglich.';
      else if (eingabe.stunden > 24) fehler = 'Ein Tag hat höchstens 24 Stunden.';
      else if (eingabe.tage > 7) fehler = 'Eine Woche hat höchstens 7 Tage.';

      zeigeFehler(bereich, fehler);
      if (fehler) return;

      const r = berechneStrom(eingabe);
      aus('kosten-jahr').textContent = euro(r.kostenJahr);
      aus('kosten-monat').textContent = euro(r.kostenMonat);
      aus('kosten-tag').textContent = euro(r.kostenTag);
      aus('kwh-jahr').textContent = `${zahl(r.kwhJahr, 1)} kWh`;
      aus('cent-stunde').textContent = `${zahl(r.centProStunde, 2)} ct`;
      aus('kosten-standby').textContent = euro(r.kostenStandby);
      aus('kosten-standby').closest('div').hidden = eingabe.standbyWatt === 0;
    }

    // Beispielgeräte füllen die Felder mit typischen Werten
    const vorlagen = bereich.querySelectorAll('[data-vorlage]');
    const markiere = (aktiv) => vorlagen.forEach((k) => k.setAttribute('aria-pressed', String(k === aktiv)));
    vorlagen.forEach((knopf) => {
      knopf.addEventListener('click', () => {
        const [watt, stunden, standby] = knopf.dataset.vorlage.split('|');
        form.elements.watt.value = watt;
        form.elements.stunden.value = stunden;
        form.elements.tage.value = '7';
        form.elements.standby.value = standby;
        markiere(knopf);
        aktualisiere();
      });
    });
    form.addEventListener('input', () => markiere(null));   // eigene Eingabe → keine Vorlage mehr aktiv

    beobachte(form, aktualisiere);
  }

  // ---------- Gemeinsame Helfer ----------

  function beobachte(form, aktualisiere) {
    form.addEventListener('input', aktualisiere);
    form.addEventListener('change', aktualisiere);
    form.addEventListener('submit', (e) => { e.preventDefault(); aktualisiere(); });
    aktualisiere();
  }

  function zeigeFehler(bereich, text) {
    const fehlerEl = bereich.querySelector('[data-aus="fehler"]');
    const ergebnisEl = bereich.querySelector('.ergebnis-liste');
    fehlerEl.textContent = text;
    fehlerEl.hidden = !text;
    ergebnisEl.classList.toggle('veraltet', Boolean(text));
  }

  document.querySelectorAll('form[data-rechner="mwst"]').forEach(initMwst);
  document.querySelectorAll('form[data-aufgabe]').forEach(initProzent);
  document.querySelectorAll('form[data-rechner="strom"]').forEach(initStrom);

  // Aktuelles Jahr im Fußbereich
  document.querySelectorAll('[data-jahr]').forEach((el) => { el.textContent = new Date().getFullYear(); });
})();
