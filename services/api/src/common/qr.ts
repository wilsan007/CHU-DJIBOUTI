import qrcode from "qrcode-generator";

// Octets en UTF-8 (le réglage par défaut de la bibliothèque tronque les caractères hors Latin-1).
qrcode.stringToBytes = (text: string): number[] => [...Buffer.from(text, "utf8")];

/**
 * QR code en SVG (formes vectorielles : net à toute taille, à l'impression comme à l'écran). Niveau de correction « M »
 * (15 %) : lisible même si l'étiquette est un peu abîmée. Les modules sont noirs sur fond blanc avec la marge de silence
 * de 4 modules exigée par la norme.
 */
export function qrSvg(text: string, pixels = 160): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  let path = "";
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1)
      if (qr.isDark(y, x)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
