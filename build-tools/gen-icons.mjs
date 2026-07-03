// scan360 아이콘 일괄 생성 — 새 로고 마크(렌즈+파노라마그리드+스캔스윕+360궤도)를
// dark 정사각 배지로 합성 → sharp 로 PNG 래스터화.
// 출력: public/images/{icon-64, icon-192, icon-512, icon-maskable-192, icon-maskable-512}.png + favicon.svg
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images');

const DEFS = `
  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5cb6f2"/><stop offset="1" stop-color="#2b76bd"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f3c869"/><stop offset="1" stop-color="#d29a30"/>
    </linearGradient>
    <radialGradient id="lens" cx="38%" cy="30%" r="75%">
      <stop offset="0" stop-color="#1d2c47"/><stop offset=".7" stop-color="#101a2b"/><stop offset="1" stop-color="#0a111d"/>
    </radialGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7fd0ff" stop-opacity="0"/><stop offset="1" stop-color="#7fd0ff" stop-opacity=".85"/>
    </linearGradient>
    <radialGradient id="bg" cx="38%" cy="32%" r="85%">
      <stop offset="0" stop-color="#16223a"/><stop offset="1" stop-color="#0a1018"/>
    </radialGradient>
  </defs>`;

// 마크 — 0,0 중심. faint 여부로 favicon 단순화.
const mark = (faint = true) => `
  <circle r="23" fill="url(#lens)"/>
  <circle r="23" fill="none" stroke="url(#blue)" stroke-width="2.4"/>
  <g fill="none" stroke="#3f9be0" stroke-width="1.6">
    <ellipse rx="23" ry="8.5" opacity=".82"/>
    <ellipse rx="8.5" ry="23" opacity=".58"/>
    ${faint ? '<ellipse rx="17" ry="23" opacity=".3"/>' : ''}
    <line x1="-23" y1="0" x2="23" y2="0" opacity=".5"/>
  </g>
  <path d="M0,0 L21,0 A21,21 0 0 0 6.49,-19.97 Z" fill="url(#sweep)"/>
  <line x1="0" y1="0" x2="6.49" y2="-19.97" stroke="#bfe6ff" stroke-width="1.7" stroke-linecap="round"/>
  <g transform="rotate(-24)">
    <ellipse rx="28" ry="10.5" fill="none" stroke="url(#gold)" stroke-width="2.2"/>
    <circle cx="28" cy="0" r="3.2" fill="url(#gold)"/>
  </g>
  <circle r="3.2" fill="#0a111d" stroke="url(#blue)" stroke-width="1.7"/>
  <circle r="1.2" fill="#bfe6ff"/>`;

// S=512 캔버스. scale=마크 확대율. rounded=둥근사각(any)/false=풀블리드(maskable). faint=그리드.
function svg({ scale, rounded, faint = true, bg = true }) {
  const S = 512, c = S / 2;
  const bgRect = bg
    ? `<rect width="${S}" height="${S}" rx="${rounded ? 104 : 0}" fill="url(#bg)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  ${DEFS}
  ${bgRect}
  <g transform="translate(${c},${c}) scale(${scale})">${mark(faint)}</g>
</svg>`;
}

const anySvg = svg({ scale: 7.0, rounded: true });          // purpose any — 둥근 다크 배지
const maskSvg = svg({ scale: 6.0, rounded: false });        // maskable — 풀블리드 + 세이프존
const faviconSvg = svg({ scale: 7.4, rounded: true, faint: false }); // favicon — 굵게·단순

const jobs = [
  ['icon-64.png', faviconSvg, 64],
  ['icon-192.png', anySvg, 192],
  ['icon-512.png', anySvg, 512],
  ['icon-maskable-192.png', maskSvg, 192],
  ['icon-maskable-512.png', maskSvg, 512],
];

for (const [name, src, size] of jobs) {
  await sharp(Buffer.from(src)).resize(size, size).png().toFile(join(OUT, name));
  console.log('✓', name, size + 'px');
}

// SVG 파비콘(모던 브라우저 크리스프)
writeFileSync(join(OUT, 'favicon.svg'), faviconSvg);
console.log('✓ favicon.svg');
