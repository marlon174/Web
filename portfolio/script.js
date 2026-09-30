// Portfolio – kleine Helfer ohne Framework
(() => {
  'use strict';

  const root = document.documentElement;

  // 1) Hell/Dunkel umschalten (die Auswahl merkt sich der Browser)
  const themeBtn = document.querySelector('.theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const istDunkel = root.dataset.theme
        ? root.dataset.theme === 'dark'
        : window.matchMedia('(prefers-color-scheme: dark)').matches;
      const neu = istDunkel ? 'light' : 'dark';
      root.dataset.theme = neu;
      try { localStorage.setItem('theme', neu); } catch (e) { /* z. B. privater Modus */ }
    });
  }

  // 2) Menü auf dem Smartphone
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

  // 3) Linie unter dem Kopfbereich, sobald gescrollt wird
  if (kopf) {
    const pruefe = () => kopf.classList.toggle('gescrollt', window.scrollY > 8);
    pruefe();
    window.addEventListener('scroll', pruefe, { passive: true });
  }

  // 4) Inhalte beim Scrollen sanft einblenden
  const elemente = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const beobachter = new IntersectionObserver((eintraege) => {
      eintraege.forEach((eintrag) => {
        if (eintrag.isIntersecting) {
          eintrag.target.classList.add('sichtbar');
          beobachter.unobserve(eintrag.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    elemente.forEach((el) => beobachter.observe(el));
  } else {
    elemente.forEach((el) => el.classList.add('sichtbar'));
  }

  // 5) Aktuelles Jahr im Fußbereich
  document.querySelectorAll('[data-jahr]').forEach((el) => { el.textContent = new Date().getFullYear(); });
})();
