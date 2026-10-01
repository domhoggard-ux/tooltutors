/* ==========================================================================
   TOOLTUTORS INTERACTION SCRIPT
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // Mobile Navigation Drawer Logic
  const mobileToggle = document.getElementById('mobileToggle');
  const navMenu = document.getElementById('navMenu');
  const navOverlay = document.getElementById('navOverlay');

  function toggleMenu() {
    const isOpen = navMenu.classList.contains('active');
    mobileToggle.classList.toggle('active', !isOpen);
    navMenu.classList.toggle('active', !isOpen);
    navOverlay.classList.toggle('active', !isOpen);
    document.body.style.overflow = isOpen ? '' : 'hidden';
    mobileToggle.setAttribute('aria-expanded', !isOpen);
  }

  if (mobileToggle) {
    mobileToggle.addEventListener('click', toggleMenu);
    navOverlay.addEventListener('click', toggleMenu);
  }

  // Close menu on link click (mobile)
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      if (navMenu.classList.contains('active')) {
        toggleMenu();
      }
    });
  });

  // Dynamic Copyright Year
  const yearSpan = document.getElementById('currentYear');
  if (yearSpan) {
    yearSpan.textContent = new Date().getFullYear();
  }

  // Generic Form Handler with User Feedback
  const forms = document.querySelectorAll('form[data-handle="true"]');
  forms.forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn.textContent;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      setTimeout(() => {
        form.reset();
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        
        // Dynamic Success Alert Box
        const alertBox = document.createElement('div');
        alertBox.style.cssText = `
          background-color: rgba(255, 107, 53, 0.15);
          border: 1px solid #FF6B35;
          color: #FFFFFF;
          padding: 1rem;
          border-radius: 8px;
          margin-top: 1.5rem;
          text-align: center;
          font-weight: 600;
        `;
        alertBox.textContent = 'Application received! A member of the ToolTutors team will be in touch shortly.';
        form.appendChild(alertBox);

        setTimeout(() => alertBox.remove(), 6000);
      }, 1200);
    });
  });
});