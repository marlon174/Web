// Salon-Website – Live-Öffnungsstatus, Menü auf dem Smartphone, Jahreszahl
(() => {
  'use strict';

  const TAGESNAMEN = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  // ---------- Öffnungszeiten ----------

  // Liest die Zeiten direkt aus der Tabelle – so müssen sie nur an EINER Stelle gepflegt werden.
  // Ergebnis: { 2: { zeile, bereiche: [[540, 1080]] }, … } (Minuten seit Mitternacht)
  function leseOeffnungszeiten() {
    const plan = {};
    document.querySelectorAll('.zeiten tr[data-tag]').forEach((zeile) => {
      const text = zeile.querySelector('td')?.textContent || '';
      const bereiche = [...text.matchAll(/(\d{1,2})[:.](\d{2})\s*(?:–|-|bis)\s*(\d{1,2})[:.](\d{2})/g)]
        .map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])])
        .sort((a, b) => a[0] - b[0]);
      plan[Number(zeile.dataset.tag)] = { zeile, bereiche };
    });
    return plan;
  }

  // Aktuelle Zeit in Deutschland – stimmt auch, wenn jemand die Seite aus dem Ausland aufruft.
  function jetzt() {
    try {
      const teile = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Berlin', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
      }).formatToParts(new Date());
      const wert = (typ) => teile.find((t) => t.type === typ).value;
      const tag = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wert('weekday')];
      if (tag === undefined) throw new Error('Unbekannter Wochentag');
      return { tag, minute: (Number(wert('hour')) % 24) * 60 + Number(wert('minute')) };
    } catch (e) {
      const d = new Date();
      return { tag: d.getDay(), minute: d.getHours() * 60 + d.getMinutes() };
    }
  }

  const uhrzeit = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  function berechneStatus(plan, { tag, minute }) {
    const heute = plan[tag]?.bereiche || [];
    const aktuell = heute.find(([von, bis]) => minute >= von && minute < bis);
    if (aktuell) {
      const bald = aktuell[1] - minute <= 30;
      return {
        klasse: bald ? 'bald' : 'offen',
        text: `${bald ? 'Schließt bald' : 'Jetzt geöffnet'} · bis ${uhrzeit(aktuell[1])} Uhr`,
      };
    }
    // Nächste Öffnung suchen: heute später oder an einem der nächsten Tage
    for (let i = 0; i <= 7; i++) {
      const t = (tag + i) % 7;
      const naechster = (plan[t]?.bereiche || []).find(([von]) => i > 0 || von > minute);
      if (naechster) {
        const wann = i === 0 ? 'heute' : i === 1 ? 'morgen' : `am ${TAGESNAMEN[t]}`;
        return { klasse: 'zu', text: `Geschlossen · öffnet ${wann} um ${uhrzeit(naechster[0])} Uhr` };
      }
    }
    return { klasse: 'zu', text: 'Derzeit geschlossen' };
  }

  const plan = leseOeffnungszeiten();
  const statusElemente = document.querySelectorAll('[data-status]');

  function aktualisiereStatus() {
    const zeit = jetzt();
    const status = berechneStatus(plan, zeit);
    statusElemente.forEach((el) => {
      el.classList.remove('offen', 'bald', 'zu');
      el.classList.add(status.klasse);
      el.querySelector('.status-text').textContent = status.text;
      el.hidden = false;
    });
    Object.entries(plan).forEach(([t, { zeile }]) => zeile.classList.toggle('heute', Number(t) === zeit.tag));
  }

  if (Object.keys(plan).length) {
    aktualisiereStatus();
    setInterval(aktualisiereStatus, 30 * 1000);
  }

  // ---------- Menü auf dem Smartphone ----------

  const kopf = document.querySelector('.kopf');
  const menueBtn = document.querySelector('.menue-btn');
  const nav = document.getElementById('nav');
  if (kopf && menueBtn && nav) {
    const setzeMenue = (offen) => {
      kopf.classList.toggle('nav-offen', offen);
      menueBtn.setAttribute('aria-expanded', String(offen));
      menueBtn.setAttribute('aria-label', offen ? 'Menü schließen' : 'Menü öffnen');
    };
    menueBtn.addEventListener('click', () => setzeMenue(!kopf.classList.contains('nav-offen')));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) setzeMenue(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setzeMenue(false); });
  }

  // ---------- Aktuelles Jahr ----------

  document.querySelectorAll('[data-jahr]').forEach((el) => { el.textContent = new Date().getFullYear(); });
})();
