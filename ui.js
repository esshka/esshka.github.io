/*
  /Users/esshka/hireme/ui.js
  Modal open/close, focus trap, and the Space-to-hide-overlay hotkey.
  RELEVANT FILES: index.html, styles.css, modal_styles.css, webgl.js
*/

(() => {
  const body = document.body;
  const modalEls = Array.from(document.querySelectorAll('[data-modal]'));
  const triggerEls = Array.from(document.querySelectorAll('[data-modal-trigger]'));
  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  let activeModal = null;
  let lastTrigger = null;

  function getFocusable(modalEl) {
    return Array.from(modalEl.querySelectorAll(focusableSelector)).filter((el) => {
      return !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true';
    });
  }

  function openModal(modalEl, triggerEl) {
    if (!modalEl) return;
    if (activeModal && activeModal !== modalEl) {
      closeModal(activeModal, false);
    }

    lastTrigger = triggerEl || document.activeElement;
    modalEl.hidden = false;
    modalEl.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      modalEl.classList.add('active');
    });

    body.classList.add('modal-open');
    activeModal = modalEl;

    if (window.pauseWebGL) {
      window.pauseWebGL();
    }

    setTimeout(() => {
      const focusables = getFocusable(modalEl);
      const target = focusables[0] || modalEl.querySelector('.modal-content') || modalEl;
      target.focus();
    }, 10);
  }

  function closeModal(modalEl, restoreFocus = true) {
    if (!modalEl || modalEl.hidden) return;

    modalEl.classList.remove('active');
    modalEl.setAttribute('aria-hidden', 'true');

    window.setTimeout(() => {
      modalEl.hidden = true;

      if (activeModal === modalEl) {
        activeModal = null;
      }

      const anotherOpen = modalEls.some((modalNode) => !modalNode.hidden);
      if (!anotherOpen) {
        body.classList.remove('modal-open');
        if (window.resumeWebGL) {
          window.resumeWebGL();
        }
      }

      if (restoreFocus && lastTrigger && typeof lastTrigger.focus === 'function') {
        lastTrigger.focus();
      }
    }, 260);
  }

  function trapFocus(event) {
    if (!activeModal || event.key !== 'Tab') return;

    const focusables = getFocusable(activeModal);
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  triggerEls.forEach((trigger) => {
    trigger.addEventListener('click', () => {
      openModal(document.getElementById(trigger.getAttribute('data-modal-trigger')), trigger);
    });
  });

  document.querySelectorAll('[data-close]').forEach((closeButton) => {
    closeButton.addEventListener('click', () => {
      closeModal(closeButton.closest('[data-modal]'));
    });
  });

  modalEls.forEach((modalEl) => {
    modalEl.addEventListener('click', (event) => {
      if (event.target === modalEl) {
        closeModal(modalEl);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    const onPageChrome = event.target === document.body || event.target === document.documentElement;
    if (event.code === 'Space' && !activeModal && onPageChrome) {
      event.preventDefault();
      body.classList.toggle('overlay-hidden');
    }

    if (event.key === 'Escape' && activeModal) {
      closeModal(activeModal);
    }

    trapFocus(event);
  });

  /* ---- Live telemetry: the HUD reports real state, not decoration ---- */

  const setText = (el, value) => {
    if (el && el.textContent !== value) el.textContent = value;
  };

  const clockEl = document.getElementById('clock');
  const clockFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Belgrade',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function tickClock() {
    setText(clockEl, clockFmt.format(new Date()));
  }

  const fpsEl = document.getElementById('tFps');
  const tierEl = document.getElementById('tTier');
  const resEl = document.getElementById('tRes');

  function pollStats() {
    if (!window.webglStats) return;
    const stats = window.webglStats();
    setText(fpsEl, stats.fallback ? 'OFF' : String(stats.fps));
    setText(tierEl, stats.fallback ? '2D' : stats.tier.toUpperCase());
    setText(resEl, stats.fallback ? '—' : `${stats.width}×${stats.height}`);
  }

  tickClock();
  pollStats();
  setInterval(tickClock, 1000);
  setInterval(pollStats, 500);

  /* ---- Capability tiles drive the trench palette ---- */

  function hexToRgb(hex) {
    const raw = hex.trim().replace('#', '');
    const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n)) return null;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  document.querySelectorAll('.domain').forEach((tile) => {
    let pair;

    const enter = () => {
      if (!pair) {
        const style = getComputedStyle(tile);
        pair = [
          hexToRgb(style.getPropertyValue('--accent')),
          hexToRgb(style.getPropertyValue('--accent-2')),
        ];
      }
      if (window.setLaneAccent && pair[0] && pair[1]) {
        window.setLaneAccent(pair[0], pair[1]);
      }
    };

    const leave = () => {
      if (window.setLaneAccent) window.setLaneAccent(null);
    };

    tile.addEventListener('mouseenter', enter);
    tile.addEventListener('mouseleave', leave);
    tile.addEventListener('focusin', enter);
    tile.addEventListener('focusout', leave);
  });
})();
