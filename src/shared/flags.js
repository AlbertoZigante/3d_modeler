/** shared/flags.js — inline SVG flags (emoji flags do not render on Windows). */
const svg = (body) =>
  `<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">${body}</svg>`;

export const FLAGS = {
  en: svg(
    '<rect width="60" height="40" fill="#012169"/>' +
    '<path d="M0 0L60 40M60 0L0 40" stroke="#fff" stroke-width="8"/>' +
    '<path d="M0 0L60 40M60 0L0 40" stroke="#C8102E" stroke-width="3"/>' +
    '<path d="M30 0V40M0 20H60" stroke="#fff" stroke-width="12"/>' +
    '<path d="M30 0V40M0 20H60" stroke="#C8102E" stroke-width="7"/>'
  ),
  fr: svg('<rect width="20" height="40" fill="#0055A4"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#EF4135"/>'),
  it: svg('<rect width="20" height="40" fill="#009246"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#CE2B37"/>'),
};

export const flagFor = (lang) => FLAGS[lang] ?? '';
