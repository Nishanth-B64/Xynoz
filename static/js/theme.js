const THEME_STORAGE_KEY = 'xynoz_theme';

function setTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');

  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.textContent = isDark ? '☀️' : '🌙';
    button.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    button.setAttribute('aria-pressed', String(isDark));
  });
}

const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
setTheme(savedTheme === 'dark' ? 'dark' : 'light');

document.addEventListener('DOMContentLoaded', () => {
  setTheme(document.documentElement.dataset.theme);
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  });
});
