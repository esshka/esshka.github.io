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
})();
