// Wrap in an IIFE so hx-boost page transitions re-evaluating this script do not redeclare top-level classes.
(function() {
  'use strict';

class UniversNavbar extends HTMLElement {
  connectedCallback() {
    const toggleBtn = this.querySelector('.univers-drawer-toggle');
    const closeBtn = this.querySelector('.univers-drawer-close');
    const backdrop = this.querySelector('.univers-drawer-backdrop');
    const content = this.querySelector('.univers-drawer-content');
    const darkToggles = this.querySelectorAll('.univers-dark-toggle');

    const openDrawer = () => {
      backdrop?.classList.add('active');
      content?.classList.add('active');
    };

    const closeDrawer = () => {
      backdrop?.classList.remove('active');
      content?.classList.remove('active');
    };

    toggleBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer();
    });

    closeBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      closeDrawer();
    });

    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) closeDrawer();
    });

    darkToggles.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const html = document.documentElement;
        const isDark = html.classList.contains('dark');
        if (isDark) {
          html.classList.remove('dark');
          localStorage.setItem('theme', 'light');
          localStorage.setItem('walnut_theme_mode', 'light');
          html.setAttribute('data-theme-mode', 'light');
        } else {
          html.classList.add('dark');
          localStorage.setItem('theme', 'dark');
          localStorage.setItem('walnut_theme_mode', 'dark');
          html.setAttribute('data-theme-mode', 'dark');
        }
      });
    });
  }
}
if (!customElements.get('univers-navbar')) {
  customElements.define('univers-navbar', UniversNavbar);
}

class UniversCardsSlider extends HTMLElement {
  connectedCallback() {
    const track = this.querySelector('.univers-carousel-track');
    const prevBtn = this.querySelector('.univers-carousel-prev');
    const nextBtn = this.querySelector('.univers-carousel-next');
    const controls = this.querySelector('.univers-carousel-controls') || prevBtn?.closest('.univers-carousel-controls') || prevBtn?.parentElement;
    const slides = Array.from(this.querySelectorAll('.univers-carousel-slide'));
    if (!track || slides.length === 0) return;

    let currentPage = 0;

    const setupSlider = () => {
      const isDesktop = window.innerWidth >= 768;
      const itemsPerView = isDesktop ? 3 : 1;
      const totalSlides = slides.length;
      const totalPages = Math.ceil(totalSlides / itemsPerView);

      // Hide carousel controls when all slides fit on a single page to prevent empty pagination slots.
      if (totalPages <= 1) {
        if (controls) controls.style.display = 'none';
        slides.forEach(slide => {
          slide.style.display = '';
        });
        track.style.transform = 'none';
        return;
      }

      if (controls) controls.style.display = 'flex';
      if (currentPage >= totalPages) currentPage = 0;

      const renderPage = () => {
        const start = currentPage * itemsPerView;
        const end = start + itemsPerView;
        slides.forEach((slide, idx) => {
          slide.style.display = (idx >= start && idx < end) ? '' : 'none';
        });
      };

      renderPage();

      if (!this._hasBoundEvents) {
        this._hasBoundEvents = true;
        prevBtn?.addEventListener('click', (e) => {
          e.preventDefault();
          const currentTotalPages = Math.ceil(slides.length / (window.innerWidth >= 768 ? 3 : 1));
          currentPage = (currentPage - 1 + currentTotalPages) % currentTotalPages;
          renderPage();
        });

        nextBtn?.addEventListener('click', (e) => {
          e.preventDefault();
          const currentTotalPages = Math.ceil(slides.length / (window.innerWidth >= 768 ? 3 : 1));
          currentPage = (currentPage + 1) % currentTotalPages;
          renderPage();
        });
      }
    };

    setupSlider();

    if (window.matchMedia) {
      const mql = window.matchMedia('(min-width: 768px)');
      const resizeHandler = () => setupSlider();
      if (mql.addEventListener) {
        mql.addEventListener('change', resizeHandler);
      } else if (mql.addListener) {
        mql.addListener(resizeHandler);
      }
    }
  }
}
if (!customElements.get('univers-cards-slider')) {
  customElements.define('univers-cards-slider', UniversCardsSlider);
}
if (!customElements.get('univers-cards')) {
  class UniversCards extends UniversCardsSlider {}
  customElements.define('univers-cards', UniversCards);
}

class UniversConvertBlock extends HTMLElement {
  connectedCallback() {
    const form = this.querySelector('.univers-convert-form');
    const emailInput = this.querySelector('.univers-convert-input');
    const nameInput = this.querySelector('.univers-convert-name');
    const msgInput = this.querySelector('.univers-convert-message');
    const honeypot = this.querySelector('input[name="_honeypot"]');
    const actionType = this.getAttribute('data-action') || 'toast';
    const actionTarget = this.getAttribute('data-target') || '/api/forms/submit/contact';

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      // Fake success when a bot fills the honeypot field without writing to the database.
      if (honeypot && honeypot.value.trim().length > 0) {
        if (window.showToast) window.showToast('Submission received! Thank you for your feedback.', 'success');
        form.reset();
        return;
      }

      const email = emailInput?.value?.trim() || '';
      const name = nameInput?.value?.trim() || '';
      const message = msgInput?.value?.trim() || '';
      if (!email) return;

      if (actionType === 'api') {
        fetch(actionTarget, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, message, source: 'univers-lead-form' })
        }).then(() => {
          if (window.showToast) window.showToast('Submission received! We will be in touch shortly.', 'success');
          form.reset();
        }).catch(() => {
          if (window.showToast) window.showToast('Network error, please try again', 'error');
        });
      } else {
        if (window.showToast) {
          window.showToast(`Message received from ${name || email}!`, 'success');
        }
        form.reset();
      }
    });
  }
}
if (!customElements.get('univers-convert-block')) {
  customElements.define('univers-convert-block', UniversConvertBlock);
}
if (!customElements.get('univers-lead-form')) {
  class UniversLeadForm extends UniversConvertBlock {}
  customElements.define('univers-lead-form', UniversLeadForm);
}

class UniversStreamBlock extends HTMLElement {
  connectedCallback() {
    const container = this.querySelector('.univers-stream-container') || this.querySelector('.grid');
    const filterBar = this.querySelector('.univers-feed-filter-bar');
    const cards = Array.from(container?.children || this.querySelectorAll('.univers-feed-card, article'));

    if (cards.length === 0) {
      if (filterBar) filterBar.style.display = 'none';
      return;
    }

    const categoriesSet = new Set();
    cards.forEach(card => {
      const cat = (card.getAttribute('data-category') || card.getAttribute('data-folder') || card.getAttribute('data-progress') || '').trim();
      if (cat && cat !== 'all' && cat !== '全部') {
        categoriesSet.add(cat);
      }
    });

    const categories = Array.from(categoriesSet);

    if (!filterBar || categories.length < 2) {
      if (filterBar) filterBar.style.display = 'none';
      return;
    }

    filterBar.innerHTML = '';
    filterBar.style.display = '';

    const createBtn = (label, filterVal, isActive) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-filter', filterVal);
      btn.className = `univers-filter-btn px-3 py-1.5 rounded-lg transition font-bold text-xs ${
        isActive
          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
          : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
      }`;
      btn.textContent = label;
      return btn;
    };

    const allBtn = createBtn('全部', 'all', true);
    filterBar.appendChild(allBtn);

    const filterBtns = [allBtn];
    categories.forEach(cat => {
      const btn = createBtn(cat, cat, false);
      filterBar.appendChild(btn);
      filterBtns.push(btn);
    });

    filterBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const activeFilter = btn.getAttribute('data-filter') || 'all';

        filterBtns.forEach(b => {
          b.className = 'univers-filter-btn px-3 py-1.5 rounded-lg transition font-bold text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white';
        });
        btn.className = 'univers-filter-btn px-3 py-1.5 rounded-lg transition font-bold text-xs bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs';

        cards.forEach(card => {
          if (activeFilter === 'all') {
            card.style.display = '';
            return;
          }
          const cardCat = (card.getAttribute('data-category') || card.getAttribute('data-folder') || card.getAttribute('data-progress') || '').trim();
          const cardFolder = (card.getAttribute('data-folder') || '').trim();
          const cardProg = (card.getAttribute('data-progress') || '').trim();
          const isMatch = cardCat === activeFilter || cardFolder === activeFilter || cardProg === activeFilter;
          card.style.display = isMatch ? '' : 'none';
        });
      });
    });
  }
}
if (!customElements.get('univers-stream-block')) {
  customElements.define('univers-stream-block', UniversStreamBlock);
}
if (!customElements.get('univers-content-feed')) {
  class UniversContentFeed extends UniversStreamBlock {}
  customElements.define('univers-content-feed', UniversContentFeed);
}

function syncAllUniversTocs() {
  const tocLists = document.querySelectorAll('.univers-toc-list');
  if (!tocLists || tocLists.length === 0) return;

  let headings = document.querySelectorAll('.walnut-article-content h2, .walnut-article-content h3');
  if (!headings || headings.length === 0) {
    headings = document.querySelectorAll('article h2, article h3');
  }

  tocLists.forEach((tocList) => {
    if (!headings || headings.length === 0) {
      tocList.innerHTML = '<div class="text-xs text-slate-400 py-1">暂无章节大纲</div>';
      return;
    }

    tocList.innerHTML = Array.from(headings).map((h, i) => {
      const id = h.id || `heading-${i}`;
      h.id = id;
      const level = parseInt(h.tagName.substring(1), 10);
      const indentClass = level <= 2 ? 'font-bold' : 'pl-3 text-slate-500';
      return `
        <a href="#${id}" class="univers-link-accent block py-1 text-xs text-slate-600 dark:text-slate-400 truncate transition ${indentClass}">
          ${h.textContent}
        </a>
      `;
    }).join('');

    tocList.querySelectorAll('a').forEach(anchor => {
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = anchor.getAttribute('href')?.replace('#', '');
        const targetEl = targetId ? document.getElementById(targetId) : null;
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  });
}

class UniversTocSidebar extends HTMLElement {
  connectedCallback() {
    syncAllUniversTocs();
    requestAnimationFrame(syncAllUniversTocs);
    setTimeout(syncAllUniversTocs, 80);
  }
}
if (!customElements.get('univers-toc-sidebar')) {
  customElements.define('univers-toc-sidebar', UniversTocSidebar);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncAllUniversTocs);
  } else {
    syncAllUniversTocs();
  }
  document.addEventListener('htmx:afterSettle', syncAllUniversTocs);
  document.addEventListener('htmx:afterSwap', syncAllUniversTocs);
  document.addEventListener('htmx:load', syncAllUniversTocs);
  window.addEventListener('pageshow', syncAllUniversTocs);
}

// Register passive layout containers so :not(:defined) cloak styles lift immediately.
class UniversHero extends HTMLElement {}
class UniversGrid extends HTMLElement {}
class UniversFooter extends HTMLElement {}
class UniversArticleView extends HTMLElement {}
class UniversDatasetViewer extends HTMLElement {}
class UniversMediaGallery extends HTMLElement {}
class UniversNoticeBar extends HTMLElement {}
class UniversProfileCard extends HTMLElement {}
class UniversTimeline extends HTMLElement {}

class UniversSocialSidebar extends HTMLElement {
  connectedCallback() {
    const copyBtn = this.querySelector('.univers-share-copy, [data-action="copy"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(window.location.href);
          if (window.showToast) window.showToast('Link copied to clipboard', 'success');
        }
      });
    }
  }
}

const universLayoutComponents = {
  'univers-hero': UniversHero,
  'univers-grid': UniversGrid,
  'univers-footer': UniversFooter,
  'univers-article-view': UniversArticleView,
  'univers-social-sidebar': UniversSocialSidebar,
  'univers-dataset-viewer': UniversDatasetViewer,
  'univers-media-gallery': UniversMediaGallery,
  'univers-notice-bar': UniversNoticeBar,
  'univers-profile-card': UniversProfileCard,
  'univers-timeline': UniversTimeline
};

for (const [tag, cls] of Object.entries(universLayoutComponents)) {
  if (!customElements.get(tag)) {
    customElements.define(tag, cls);
  }
}
})();
