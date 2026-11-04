// Theme boot: apply the stored theme before first paint to avoid FOUC.
// Kept as a classic blocking script (not inline) so the CSP needs no
// 'unsafe-inline' for scripts.
// A visitor without an explicit choice starts in the product-default
// ink theme. Legacy 'default' remains an explicit light choice.
// ink 主题使用 black 系列品牌素材（favicon-black-* / mark-black）。
(function () {
  try {
    var t = localStorage.getItem('theme');
    var variant = 'ink';
    if (t === 'soft' || t === 'ink') {
      document.documentElement.setAttribute('data-theme', t);
      variant = t;
    } else if (t === 'dark') {
      document.documentElement.classList.add('dark');
      variant = 'dark';
    } else if (t === 'light' || t === 'default') {
      variant = 'light';
    } else {
      document.documentElement.setAttribute('data-theme', 'ink');
    }
    var asset = variant === 'ink' ? 'black' : variant;

    var icons = document.querySelectorAll('link[data-brand-favicon-size]');
    for (var i = 0; i < icons.length; i++) {
      var size = icons[i].getAttribute('data-brand-favicon-size');
      if (size) {
        icons[i].setAttribute('href', '/brand/ledger-knot/favicon-' + asset + '-' + size + '.png');
      }
    }

    var appleTouchIcon = document.getElementById('brand-apple-touch-icon');
    if (appleTouchIcon) {
      appleTouchIcon.setAttribute('href', '/brand/ledger-knot/favicon-' + asset + '-180.png');
    }

    var themeColor = document.getElementById('brand-theme-color');
    if (themeColor) {
      themeColor.setAttribute(
        'content',
        variant === 'dark' ? '#0A0A14' : variant === 'soft' ? '#FFF8EC' : variant === 'ink' ? '#EEF0EE' : '#F8FAFC'
      );
    }
  } catch (e) {}
})();
